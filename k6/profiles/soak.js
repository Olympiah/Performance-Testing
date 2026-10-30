// Soak: the mixed workload at the target load T = 24 journeys/s for 30 minutes, after a 60 s warm-up
// at T/2, plus login at 5 per minute. The question is S7: does Strapi's private memory grow by more
// than 20% after the warm-up? Run it once. The writer adds about 4,400 Articles over the run (72 in the
// warm-up, 4,320 in the hold), so the database ends at more than three times its starting size, and
// part of any slowdown is data growth. The raw points file lets me read reader p95 minute by minute.
// Restore the snapshot before the run.
// Run with: k6 run -e DB=postgres --out csv=results/soak-postgres-points.csv k6/profiles/soak.js
import { preflight } from '../lib/auth.js';
import { KINDS, scenario } from '../lib/arrival.js';
import { reader } from '../scenarios/reader.js';
import { heavyReader } from '../scenarios/heavy-reader.js';
import { writer } from '../scenarios/writer.js';
import { loginJourney } from '../scenarios/login.js';

export { reader, heavyReader, writer, loginJourney };

const T = 24;
const WARMUP_RATE = 12; // T/2
const WARMUP_LENGTH = '60s';
const HOLD_LENGTH = '30m';

const scenarios = {};
for (const kind of KINDS) {
  scenarios[`${kind.name}_warm`] = scenario(kind, WARMUP_RATE, '0s', WARMUP_LENGTH, 'warm', 'warmup');
  scenarios[`${kind.name}_soak`] = scenario(kind, T, WARMUP_LENGTH, HOLD_LENGTH, 'soak', 'hold');
}
scenarios.login_soak = {
  executor: 'constant-arrival-rate',
  exec: 'loginJourney',
  rate: 5,
  timeUnit: '1m',
  duration: HOLD_LENGTH,
  startTime: WARMUP_LENGTH,
  gracefulStop: '10s',
  preAllocatedVUs: 1,
  maxVUs: 2,
  tags: { step: 'soak', phase: 'hold' },
};

// S1 to S5 over the whole hold. S7 is judged after the run from the sampler CSV.
export const options = {
  scenarios,
  thresholds: {
    'http_req_duration{journey:reader,step:soak}': ['p(95)<500'],
    'http_req_duration{journey:heavy,step:soak}': ['p(95)<650'],
    'http_req_duration{journey:write,step:soak}': ['p(95)<1000'],
    'http_req_failed{step:soak}': ['rate<0.01'],
    'http_reqs{status:429}': ['count==0'],
  },
};

export function setup() {
  preflight();
}
