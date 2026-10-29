// Load: the mixed workload at the target load T = 24 journeys/s, a 60 s warm-up and then a 10-minute
// hold, plus the login scenario at 5 per minute. This is the run judged against S1-S7, and the one
// repeated three times per database. The warm-up runs at T/2 and is tagged out, as in baseline.js,
// so the heavy path is warm. The writer adds about 1,500 Articles over the run, so the late part
// uses a bigger database. Restore the snapshot before each run.
// Run with: k6 run -e DB=sqlite k6/profiles/load.js
import { preflight } from '../lib/auth.js';
import { KINDS, scenario } from '../lib/arrival.js';
import { reader } from '../scenarios/reader.js';
import { heavyReader } from '../scenarios/heavy-reader.js';
import { writer } from '../scenarios/writer.js';
import { loginJourney } from '../scenarios/login.js';

export { reader, heavyReader, writer, loginJourney };

const T = 24; // journeys per second, all three kinds together
const WARMUP_RATE = 12; // T/2
const WARMUP_LENGTH = '60s';
const HOLD_LENGTH = '10m';

const scenarios = {};
for (const kind of KINDS) {
  scenarios[`${kind.name}_warm`] = scenario(kind, WARMUP_RATE, '0s', WARMUP_LENGTH, 'warm', 'warmup');
  scenarios[`${kind.name}_load`] = scenario(kind, T, WARMUP_LENGTH, HOLD_LENGTH, 'load', 'hold');
}
// Login: 5 per minute is one every 12 s, so a 60 s window holds 5 (6 at the very worst), under
// Strapi's limit of 10 per 60 s per IP. It runs during the hold only, as one VU.
scenarios.login_load = {
  executor: 'constant-arrival-rate',
  exec: 'loginJourney',
  rate: 5,
  timeUnit: '1m',
  duration: HOLD_LENGTH,
  startTime: WARMUP_LENGTH,
  gracefulStop: '10s',
  preAllocatedVUs: 1,
  maxVUs: 2,
  tags: { step: 'load', phase: 'hold' },
};

// S1-S4 are limits on the hold: reader p95 under 500 ms, heavy p95 under 650 ms (S2), write p95
// under 1,000 ms, fewer than 1% of requests failing. S5 is the last line: no request in the whole
// run, warm-up included, gets a 429 from Strapi's rate limiter.
export const options = {
  scenarios,
  thresholds: {
    'http_req_duration{journey:reader,step:load}': ['p(95)<500'],
    'http_req_duration{journey:heavy,step:load}': ['p(95)<650'],
    'http_req_duration{journey:write,step:load}': ['p(95)<1000'],
    'http_req_failed{step:load}': ['rate<0.01'],
    'http_reqs{status:429}': ['count==0'],
  },
};

export function setup() {
  preflight();
}
