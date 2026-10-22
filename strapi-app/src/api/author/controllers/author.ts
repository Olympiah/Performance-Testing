import { factories } from '@strapi/strapi';

// Stock controller with no custom logic, so the load test measures Strapi's own API.
export default factories.createCoreController('api::author.author');
