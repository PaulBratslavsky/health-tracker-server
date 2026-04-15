import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';

type WithData = { data?: Record<string, unknown> };

// Moderation knobs — see docs/moderation-and-trust.md
const AUTO_HIDE_REPORT_THRESHOLD = 3;
const REPUTATION_PENALTY_PER_AUTO_HIDE = 20;
const FREEZE_REPUTATION_THRESHOLD = 50;
const FREEZE_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

export default {
  register({ strapi }: { strapi: Core.Strapi }) {
    strapi.documents.use(async (context, next) => {
      const requestCtx = strapi.requestContext.get();
      const user = requestCtx?.state?.user;

      // Pattern D, Rule 1: post.create — inject author, enforce type-specific
      // required fields, and block frozen authors.
      if (
        context.uid === 'api::post.post' &&
        context.action === 'create' &&
        user
      ) {
        const fullUser: any = await strapi
          .documents('plugin::users-permissions.user')
          .findOne({
            documentId: user.documentId,
            populate: { profile: true },
          });

        const profile = fullUser?.profile;
        if (!profile) {
          throw new errors.ApplicationError('Profile required before posting');
        }

        // Frozen-author check: if the author is currently frozen and the
        // freeze hasn't expired, reject. If it HAS expired, auto-unfreeze
        // them first so the post can proceed.
        if (profile.postingStatus === 'frozen') {
          const frozenUntil = profile.frozenUntil
            ? new Date(profile.frozenUntil).getTime()
            : 0;
          if (frozenUntil > Date.now()) {
            const remaining = Math.ceil((frozenUntil - Date.now()) / (60 * 60 * 1000));
            throw new errors.ApplicationError(
              `Your posting is temporarily frozen. Try again in ~${remaining}h.`,
            );
          }
          // Freeze has expired — unfreeze the profile and let the post go through
          await strapi.documents('api::profile.profile').update({
            documentId: profile.documentId,
            data: { postingStatus: 'active', frozenUntil: null },
          });
        }

        const data = (context.params as WithData).data ?? {};
        const type = ((data.type as string) ?? 'measurement') as
          | 'measurement'
          | 'link'
          | 'image_embed'
          | 'youtube';

        data.author = profile.documentId;

        if (type === 'measurement') {
          if (data.waistCm == null) {
            throw new errors.ApplicationError(
              'Measurement posts require a waist value',
            );
          }
          if (profile.heightCm == null) {
            throw new errors.ApplicationError(
              'Set your height in your profile before posting a measurement',
            );
          }
          data.heightSnapshotCm = profile.heightCm;
        } else {
          // Non-measurement posts carry a URL, not waist/height
          delete data.waistCm;
          delete data.heightSnapshotCm;
        }

        (context.params as WithData).data = data;
      }

      // Pattern D, Rule 2: report.create — inject reporter, reject self-reports
      // and duplicates, increment the post's reportCount, and auto-hide the
      // post (+ penalize the author's reputation) once the threshold is hit.
      if (
        context.uid === 'api::report.report' &&
        context.action === 'create' &&
        user
      ) {
        const fullUser: any = await strapi
          .documents('plugin::users-permissions.user')
          .findOne({
            documentId: user.documentId,
            populate: { profile: true },
          });

        const reporterProfile = fullUser?.profile;
        if (!reporterProfile) {
          throw new errors.ApplicationError('Profile required before reporting');
        }

        const data = (context.params as WithData).data ?? {};
        const postDocumentId = data.post as string | undefined;
        if (!postDocumentId) {
          throw new errors.ApplicationError('post is required');
        }

        const targetPost: any = await strapi
          .documents('api::post.post')
          .findOne({
            documentId: postDocumentId,
            populate: { author: true },
          });

        if (!targetPost) {
          throw new errors.NotFoundError('Post not found');
        }

        // Reject self-reports
        if (targetPost.author?.documentId === reporterProfile.documentId) {
          throw new errors.ApplicationError("You can't report your own post");
        }

        // Reject duplicates — one report per (post, reporter) pair
        const existing = await strapi
          .documents('api::report.report')
          .findFirst({
            filters: {
              post: { documentId: postDocumentId },
              reporter: { documentId: reporterProfile.documentId },
            },
          });
        if (existing) {
          throw new errors.ApplicationError("You've already reported this post");
        }

        // Force the reporter relation — client can't spoof it
        data.reporter = reporterProfile.documentId;
        data.status = 'pending';
        (context.params as WithData).data = data;

        // The create runs after we return next(). Side effects (increment
        // reportCount, maybe auto-hide + penalty) need to happen after.
        const result = await next();

        const newReportCount = (targetPost.reportCount ?? 0) + 1;
        const shouldAutoHide =
          newReportCount >= AUTO_HIDE_REPORT_THRESHOLD &&
          targetPost.status === 'visible';

        await strapi.documents('api::post.post').update({
          documentId: postDocumentId,
          data: {
            reportCount: newReportCount,
            status: shouldAutoHide ? 'in_review' : targetPost.status,
          },
        });

        if (shouldAutoHide && targetPost.author?.documentId) {
          const author: any = await strapi
            .documents('api::profile.profile')
            .findOne({ documentId: targetPost.author.documentId });

          if (author) {
            const newScore = Math.max(
              0,
              (author.reputationScore ?? 100) - REPUTATION_PENALTY_PER_AUTO_HIDE,
            );
            const shouldFreeze =
              newScore < FREEZE_REPUTATION_THRESHOLD &&
              author.postingStatus !== 'frozen';

            await strapi.documents('api::profile.profile').update({
              documentId: author.documentId,
              data: {
                reputationScore: newScore,
                upheldReportCount: (author.upheldReportCount ?? 0) + 1,
                postingStatus: shouldFreeze ? 'frozen' : author.postingStatus,
                frozenUntil: shouldFreeze
                  ? new Date(Date.now() + FREEZE_DURATION_MS).toISOString()
                  : author.frozenUntil,
              },
            });
          }

          // Mark the report itself as upheld, since it triggered the auto-hide
          const createdReport = result as { documentId?: string } | undefined;
          if (createdReport?.documentId) {
            await strapi.documents('api::report.report').update({
              documentId: createdReport.documentId,
              data: { status: 'upheld' },
            });
          }
        }

        return result;
      }

      return next();
    });
  },

  bootstrap({ strapi }: { strapi: Core.Strapi }) {
    // Pattern E: when a new users-permissions user is created (sign-up),
    // auto-create a Profile shell and link it via the one-way user.profile
    // relation. The User is the owning side; Profile knows nothing about it.
    strapi.db.lifecycles.subscribe({
      models: ['plugin::users-permissions.user'],
      async afterCreate(event) {
        const result = event.result as
          | { id: number; username?: string }
          | undefined;
        if (!result?.id) return;

        const userDoc: any = await strapi
          .documents('plugin::users-permissions.user')
          .findFirst({
            filters: { id: result.id },
            populate: { profile: true },
          });
        if (!userDoc) return;
        if (userDoc.profile) return; // already linked, idempotent

        const profile = await strapi
          .documents('api::profile.profile')
          .create({
            data: {
              displayName: result.username || `user-${result.id}`,
              postingStatus: 'active',
              reputationScore: 100,
              upheldReportCount: 0,
              tier: 'free',
            },
          });

        await strapi.documents('plugin::users-permissions.user').update({
          documentId: userDoc.documentId,
          data: { profile: profile.documentId },
        });
      },
    });
  },
};
