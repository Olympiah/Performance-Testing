// Calibration: finds the ceiling C, the load at which read p95 breaks 500 ms (S1). SQLite only.
// The mixed workload (80% reader, 10% heavy reader, 10% writer) is sent in steps of rising
// arrival rate. Each step is its own scenario with a "step" tag, so each gets its own p95:
// one p95 for the whole run would be mostly the quiet early steps.
// Run with: k6 run -e DB=sqlite k6/profiles/calibration.js
import { preflight } from '../lib/auth.js';
import { reader } from '../scenarios/reader.js';
import { heavyReader } from '../scenarios/heavy-reader.js';
import { writer } from '../scenarios/writer.js';

export { reader, heavyReader, writer };

// Journeys per second, all three kinds together. These steps are a starting guess, because C
// is not known yet. If read p95 holds at the last step, the ladder is extended and this is said.
const STEPS = [2, 4, 6, 8, 12, 16, 20, 24];
const STEP_LENGTH = '60s';
const WARMUP_LENGTH = '30s'; // one warm-up at the first step's rate, tagged so it is left out

// How long one iteration takes when the server is not slow: a reader or writer journey is
// 3 requests with 2 think-time pauses (about 4.2 s), a heavy reader is one request (about 0.3 s).
const KINDS = [
  { name: 'reader', exec: 'reader', journey: 'reader', share: 0.8, iterSec: 4.2 },
  { name: 'heavy', exec: 'heavyReader', journey: 'heavy', share: 0.1, iterSec: 0.3 },
  { name: 'writer', exec: 'writer', journey: 'write', share: 0.1, iterSec: 4.2 },
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
    // Twice the quick-server figure. A slow server holds VUs longer, and when this runs out k6
    // drops iterations, which flags the step as limited by k6 and not by Strapi.
    maxVUs: Math.max(4, unloaded * 2),
    tags: { step, phase },
  };
}

const scenarios = {};
const thresholds = {};
let start = 0;

for (const kind of KINDS) {
  scenarios[`${kind.name}_warm`] = scenario(kind, STEPS[0], '0s', WARMUP_LENGTH, 'warm', 'warmup');
}
start += 30;

STEPS.forEach((total, i) => {
  const step = `s${i + 1}`;
  for (const kind of KINDS) {
    scenarios[`${kind.name}_${step}`] = scenario(kind, total, `${start}s`, STEP_LENGTH, step, 'hold');
  }
  start += 60;

  // Only the reader p95 has a real limit (S1). The others have an always-true condition: k6 only
  // prints a tagged sub-metric in the summary if a threshold names it. The failures and dropped
  // iterations are printed the same way.
  thresholds[`http_req_duration{journey:reader,step:${step}}`] = ['p(95)<500'];
  thresholds[`http_req_duration{journey:heavy,step:${step}}`] = ['p(95)>=0'];
  thresholds[`http_req_duration{journey:write,step:${step}}`] = ['p(95)>=0'];
  thresholds[`http_req_failed{step:${step}}`] = ['rate>=0'];
  thresholds[`dropped_iterations{step:${step}}`] = ['count>=0'];
});

export const options = { scenarios, thresholds };

export function setup() {
  preflight();
}
