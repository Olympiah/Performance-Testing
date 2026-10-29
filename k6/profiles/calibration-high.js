// Calibration, second ladder: continues from calibration.js, where read p95 was still under 50 ms
// at 24 journeys/s. Same mixed workload (80% reader, 10% heavy reader, 10% writer), higher steps.
// Step names start with "h" so they are not confused with s1-s8 of the first run. SQLite only.
// Run with: k6 run -e DB=sqlite k6/profiles/calibration-high.js
// The writer adds Articles all through the run (about 2,100 over this ladder), so the late steps
// run on a larger data set than the early ones. The heavy reader sorts every Article in its
// category, so part of any late-step slowdown is data growth and not only load.
import { preflight } from '../lib/auth.js';
import { reader } from '../scenarios/reader.js';
import { heavyReader } from '../scenarios/heavy-reader.js';
import { writer } from '../scenarios/writer.js';

export { reader, heavyReader, writer };

// Journeys per second, all three kinds together. 24 repeats the top step of the first run.
const STEPS = [24, 32, 40, 48, 56, 64, 80];
const STEP_LENGTH = '60s';
const WARMUP_LENGTH = '60s'; // a moderate rate on all three kinds, tagged so it is left out
const WARMUP_RATE = 12;

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
  scenarios[`${kind.name}_warm`] = scenario(kind, WARMUP_RATE, '0s', WARMUP_LENGTH, 'warm', 'warmup');
}
start += 60;

STEPS.forEach((total, i) => {
  const step = `h${i + 1}`;
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
