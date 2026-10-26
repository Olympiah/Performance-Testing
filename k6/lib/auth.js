// Request parameters and the two calls that are not plain reads. Every request gets a
// "journey" tag, for the limits, and a fixed "name" tag, so an Article id in the URL
// doesn't make a new metric for each Article.
import http from 'k6/http';
import exec from 'k6/execution';
import { BASE_URL, READ_TOKEN, WRITE_TOKEN, LOGIN_USER, JOURNEY } from './config.js';

export const readParams = (journey, name) => ({
  headers: { Authorization: `Bearer ${READ_TOKEN}` },
  tags: { journey, name },
});

export const writeParams = (name) => ({
  headers: { Authorization: `Bearer ${WRITE_TOKEN}`, 'Content-Type': 'application/json' },
  tags: { journey: JOURNEY.write, name },
});

// Production mode sets a Secure refresh cookie, so over plain HTTP Strapi answers 500 unless
// the request says it came through https. API tokens use no cookies, so only login needs this.
export function login() {
  return http.post(`${BASE_URL}/auth/local`, JSON.stringify(LOGIN_USER), {
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
    tags: { journey: JOURNEY.login, name: 'POST /auth/local' },
  });
}

// Run once from each profile's setup(). A 401 means the tokens belong to the other database
// (or Strapi was restarted with another setup), so every later number would be meaningless.
// Tagged "setup", so it is left out of every limit.
export function preflight() {
  const res = http.get(`${BASE_URL}/articles?pagination[pageSize]=1`, {
    headers: { Authorization: `Bearer ${READ_TOKEN}` },
    tags: { journey: 'setup', name: 'preflight' },
  });
  if (res.status !== 200) {
    exec.test.abort(`Preflight got ${res.status}. Is Strapi up, on the database set with -e DB?`);
  }
}
