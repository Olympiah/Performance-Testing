// Baseline: low steady load, run once, to see what "unloaded" looks like. The heavy reader's p95
// here sets S2 (10x this p95, rounded up to the next 50 ms, fixed before the load runs).
// 6 journeys/s is T/4, with T = 24. Same mixed workload as the calibration (80% reader, 10% heavy
// reader, 10% writer, no login), a 60 s warm-up at 12 journeys/s (T/2) and then a 5-minute hold at
// 6. SQLite or Postgres. The warm-up is longer and busier than the hold because the heavy path is
// slow when cold: in the first calibration the heavy p95 was highest in the first step, after only
// a few heavy requests. The warm-up is tagged out, so it does not count towards the numbers.
// Run with: k6 run -e DB=sqlite k6/profiles/baseline.js
import { preflight } from '../lib/auth.js';
import { reader } from '../scenarios/reader.js';
import { heavyReader } from '../scenarios/heavy-reader.js';
import { writer } from '../scenarios/writer.js';

export { reader, heavyReader, writer };

const RATE = 6; // journeys per second, all three kinds together
const WARMUP_RATE = 12; // T/2, warms the heavy path with about 72 requests
const WARMUP_LENGTH = '60s'; // tagged so it is left out of the thresholds
const HOLD_LENGTH = '5m';

// How long one iteration takes when the server is not slow: a reader or writer journey is
// 3 requests with 2 think-time pauses (about 4.2 s), a heavy reader is one request (about 0.3 s).
const KINDS = [
  { name: 'reader', exec: 'reader', share: 0.8, iterSec: 4.2 },
  { name: 'heavy', exec: 'heavyReader', share: 0.1, iterSec: 0.3 },
  { name: 'writer', exec: 'writer', share: 0.1, iterSec: 4.2 },
];

// k6 wants a whole number of iterations per time unit, so the rate is given per minute.
function scenario(kind, total, startTime, duration, step, phase) {
  const rate = Math.max(1, Math.round(total * kind.share * 60));
  const unloaded = Math.ceil((rate / 60) * kind.iterSec); // VUs needed while the server is quick
  return {
    executor: 'constant-arrival-rate',
    exec: kind.exec,
    rate,
    timeUnit: '1m',
    duration,
    startTime,
    gracefulStop: '10s',
    preAllocatedVUs: Math.max(2, Math.ceil(unloaded * 1.5)),
    maxVUs: Math.max(4, unloaded * 2),
    tags: { step, phase },
  };
}

const scenarios = {};
for (const kind of KINDS) {
  scenarios[`${kind.name}_warm`] = scenario(kind, WARMUP_RATE, '0s', WARMUP_LENGTH, 'warm', 'warmup');
  scenarios[`${kind.name}_base`] = scenario(kind, RATE, WARMUP_LENGTH, HOLD_LENGTH, 'base', 'hold');
}

// S1, S3 and S4 are real limits. The heavy reader has an always-true condition, because S2 has no
// limit until this run is done, and k6 only prints a tagged sub-metric that a threshold names.
export const options = {
  scenarios,
  thresholds: {
    'http_req_duration{journey:reader,step:base}': ['p(95)<500'],
    'http_req_duration{journey:write,step:base}': ['p(95)<1000'],
    'http_req_duration{journey:heavy,step:base}': ['p(95)>=0'],
    'http_req_failed{step:base}': ['rate<0.01'],
  },
};

export function setup() {
  preflight();
}
