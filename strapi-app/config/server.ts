import type { Core } from '@strapi/strapi';

const config = ({ env }: Core.Config.Shared.ConfigParams): Core.Config.Server => ({
  host: env('HOST', '0.0.0.0'),
  port: env.int('PORT', 1337),
  // In production mode the login refresh cookie is Secure, and Strapi refuses to set it over
  // plain HTTP (login returns 500). Trusting the proxy header lets the load test log in over
  // HTTP by sending X-Forwarded-Proto: https. API tokens use no cookies and are not affected.
  proxy: { koa: true },
  app: {
    keys: env.array('APP_KEYS')!,
  },
  webhooks: {
    populateRelations: env.bool('WEBHOOKS_POPULATE_RELATIONS', false),
  },
});

export default config;
