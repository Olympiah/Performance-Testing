// Smoke: one user at a time, about 30 s in total. It answers one question: do the scripts, the
// tokens and the environment work? It is not a measurement, so there are no timing limits.
// Run with: k6 run -e DB=sqlite k6/profiles/smoke.js
import { preflight } from '../lib/auth.js';
import { reader } from '../scenarios/reader.js';
import { heavyReader } from '../scenarios/heavy-reader.js';
import { writer } from '../scenarios/writer.js';
import { loginJourney } from '../scenarios/login.js';

// k6 finds the functions named in "exec" among this file's exports.
export { reader, heavyReader, writer, loginJourney };

// Each journey is its own scenario with one VU, and they start one after another (startTime), so
// there is only ever one user. A fixed number of iterations is used instead of a duration, so each
// journey runs enough times to be tested and then stops. The start times leave room for the
// slowest case of the reader and writer (2 iterations with 3 s pauses, about 13 s each).
export const options = {
  scenarios: {
    reader: {
      executor: 'per-vu-iterations',
      exec: 'reader',
      vus: 1,
      iterations: 2,
      startTime: '0s',
      maxDuration: '15s',
    },
    heavy: {
      executor: 'per-vu-iterations',
      exec: 'heavyReader',
      vus: 1,
      iterations: 3,
      startTime: '14s',
      maxDuration: '5s',
    },
    writer: {
      executor: 'per-vu-iterations',
      exec: 'writer',
      vus: 1,
      iterations: 2,
      startTime: '16s',
      maxDuration: '15s',
    },
    login: {
      executor: 'per-vu-iterations',
      exec: 'loginJourney',
      vus: 1,
      iterations: 1,
      startTime: '30s',
      maxDuration: '5s',
    },
  },
  thresholds: {
    // Smoke is about correctness: every check must pass and no request may fail.
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
  },
};

// Stops the run at once if the tokens belong to the other database or Strapi is not up.
export function setup() {
  preflight();
}
