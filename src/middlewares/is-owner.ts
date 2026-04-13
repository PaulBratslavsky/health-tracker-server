import type { Core } from '@strapi/strapi';

/**
 * Generic ownership middleware. Reads the current user's profile from the
 * one-way `user.profile` relation and uses that profile's documentId as the
 * canonical owner identifier.
 *
 * - For `apiName === 'profile'`: the URL documentId must equal the current
 *   user's profile.documentId.
 * - For all other content types: the entry's `author` relation must point at
 *   the current user's profile.
 *
 * The user account itself is never referenced by owned content; this keeps
 * private auth data unreachable from the public read path.
 */
export default (_config: unknown, { strapi }: { strapi: Core.Strapi }) => {
  return async (ctx: any, next: () => Promise<void>) => {
    const sessionUser = ctx.state.user;
    if (!sessionUser) return ctx.unauthorized();

    const apiName = ctx.state.route?.info?.apiName as string | undefined;
    if (!apiName) return ctx.internalServerError('Missing route apiName');

    const documentId = ctx.params?.id;
    if (!documentId) return ctx.badRequest('Missing documentId');

    const fullUser: any = await strapi
      .documents('plugin::users-permissions.user')
      .findOne({
        documentId: sessionUser.documentId,
        populate: { profile: true },
      });

    const ownerProfileDocId = fullUser?.profile?.documentId;
    if (!ownerProfileDocId) {
      return ctx.unauthorized('No profile linked to your account');
    }

    if (apiName === 'profile') {
      if (documentId !== ownerProfileDocId) {
        return ctx.unauthorized("You can't access this entry");
      }
      return next();
    }

    const uid = `api::${apiName}.${apiName}` as any;
    const entry: any = await strapi.documents(uid).findOne({
      documentId,
      populate: { author: true },
    });

    if (!entry) return ctx.notFound();
    if (entry.author?.documentId !== ownerProfileDocId) {
      return ctx.unauthorized("You can't access this entry");
    }

    return next();
  };
};
