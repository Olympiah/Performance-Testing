// The login journey: one POST /auth/local with the test user. Not part of the mixed workload.
// Strapi allows 10 login calls per 60 s per IP (checked on the pinned version, interval 60000 and
// max 10), and every VU shares one IP. So the profile sends about 5 per minute, half the limit.
// A profile runs it with exec: 'loginJourney'.
import { login } from '../lib/auth.js';
import { checkLogin } from '../lib/checks.js';

// One request per iteration. The rate is set in the profile, not here, so this file never
// decides how often login is called. A 429 from the limiter fails the status check, so it shows.
export function loginJourney() {
  checkLogin(login());
}
