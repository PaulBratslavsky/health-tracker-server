import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::profile.profile', {
  config: {
    update: { middlewares: ['global::is-owner'] },
    delete: { middlewares: ['global::is-owner'] },
  },
});
