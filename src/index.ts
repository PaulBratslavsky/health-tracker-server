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

      // Pattern D, Rule 3: anonymous post.find / post.findOne / post.findMany —
      // hide posts whose author has not opted into public visibility. Logged-in
      // callers see every post (subject to other filters); anonymous callers
      // only see posts from profiles with `isPublic === true`. This is what
      // makes the landing-page feed preview safe without leaking private users.
      if (
        context.uid === 'api::post.post' &&
        (context.action === 'findMany' ||
          context.action === 'findOne' ||
          context.action === 'findFirst') &&
        !user
      ) {
        const params = (context.params ?? {}) as {
          filters?: Record<string, unknown>;
        };
        const existingFilters = (params.filters ?? {}) as Record<string, unknown>;
        const existingAuthor = (existingFilters.author ?? {}) as Record<string, unknown>;
        params.filters = {
          ...existingFilters,
          author: { ...existingAuthor, isPublic: true },
        };
        context.params = params as typeof context.params;
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
              isPublic: false,
            },
          });

        await strapi.documents('plugin::users-permissions.user').update({
          documentId: userDoc.documentId,
          data: { profile: profile.documentId },
        });
      },
    });

    // Idempotent backfill for new required fields whose defaults weren't
    // applied to rows that pre-date the schema addition. Strapi's auto-
    // migration adds the column but doesn't always populate existing rows
    // (SQLite ALTER TABLE limitation; Postgres behavior varies by the exact
    // generated SQL). Every UPDATE below has a `WHERE ... IS NULL` guard,
    // so subsequent boots are free no-ops. See docs/premium-tier-plan.md
    // and the "Bootstrap-backfill pattern" discussion for rationale.
    void (async () => {
      try {
        // Profile: Phase 7 (moderation) + Phase 10 (premium tier) fields
        await strapi.db.connection.raw(
          "UPDATE profiles SET tier = 'free' WHERE tier IS NULL OR tier = ''",
        );
        await strapi.db.connection.raw(
          'UPDATE profiles SET reputation_score = 100 WHERE reputation_score IS NULL',
        );
        await strapi.db.connection.raw(
          "UPDATE profiles SET posting_status = 'active' WHERE posting_status IS NULL OR posting_status = ''",
        );
        await strapi.db.connection.raw(
          'UPDATE profiles SET upheld_report_count = 0 WHERE upheld_report_count IS NULL',
        );

        // Post: Phase 7 (moderation) fields
        await strapi.db.connection.raw(
          "UPDATE posts SET status = 'visible' WHERE status IS NULL OR status = ''",
        );
        await strapi.db.connection.raw(
          'UPDATE posts SET report_count = 0 WHERE report_count IS NULL',
        );

        // Profile: Phase 11 (public visibility) — default to private for any
        // pre-existing row so existing users aren't retroactively exposed.
        await strapi.db.connection.raw(
          'UPDATE profiles SET is_public = 0 WHERE is_public IS NULL',
        );
      } catch (err) {
        strapi.log.warn('[bootstrap backfill] one or more UPDATEs failed:', err);
      }
    })();

    // Grant the public role read access to posts so the landing-page feed
    // preview works without a JWT. The middleware above filters the results
    // to only posts from public profiles. Idempotent — re-running is a no-op.
    void (async () => {
      try {
        const publicRole: any = await strapi
          .db.query('plugin::users-permissions.role')
          .findOne({ where: { type: 'public' } });
        if (!publicRole) return;

        for (const action of ['api::post.post.find', 'api::post.post.findOne']) {
          const existing = await strapi
            .db.query('plugin::users-permissions.permission')
            .findOne({ where: { action, role: publicRole.id } });
          if (!existing) {
            await strapi
              .db.query('plugin::users-permissions.permission')
              .create({ data: { action, role: publicRole.id } });
          }
        }
      } catch (err) {
        strapi.log.warn('[bootstrap public-post grant] failed:', err);
      }
    })();
  },
};
