// Stress: the mixed workload at 1x, 1.5x, 2x and 3x the target load T = 24 journeys/s (24, 36, 48
// and 72), 3 minutes each, after a 60 s warm-up at T/2. Each step is its own tagged scenario, so
// each gets its own p95. The aim is to see where the limits break and which breaks first, so a
// crossed threshold here is a finding, not a mistake. Login runs at 5 per minute throughout and is
// tagged "login", so it is left out of the per-step numbers. Restore the snapshot before each run.
// Run with: k6 run -e DB=postgres k6/profiles/stress.js
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
const STEP_SECONDS = 180;
const STEPS = [
  { name: 'x1', total: T },
  { name: 'x1_5', total: T * 1.5 },
  { name: 'x2', total: T * 2 },
  { name: 'x3', total: T * 3 },
];

// Under overload responses take seconds, and a slow response holds its VU. So the caps are 3 times
// the quick-server figure, not 2, and the heavy reader gets a floor of 50. In the second calibration
// its responses averaged 2.07 s and reached 3.66 s at 80 journeys/s, which at 72 needs about
// 7.2/s x 3.7 s = 27 VUs. 50 leaves roughly double that.
const MAX_FACTOR = 3;
const STRESS_KINDS = KINDS.map((kind) => (kind.name === 'heavy' ? { ...kind, minMaxVUs: 50 } : kind));

const scenarios = {};
const thresholds = { 'http_reqs{status:429}': ['count==0'] }; // S5
for (const kind of STRESS_KINDS) {
  scenarios[`${kind.name}_warm`] = scenario(kind, WARMUP_RATE, '0s', WARMUP_LENGTH, 'warm', 'warmup', MAX_FACTOR);
}
STEPS.forEach((step, i) => {
  const start = 60 + i * STEP_SECONDS;
  for (const kind of STRESS_KINDS) {
    scenarios[`${kind.name}_${step.name}`] = scenario(
      kind, step.total, `${start}s`, `${STEP_SECONDS}s`, step.name, 'hold', MAX_FACTOR);
    // Print-only (always true). The step tag does not reach dropped_iterations, but the scenario tag
    // does, so this shows which step ran out of VUs and whether k6 was the limit and not Strapi.
    thresholds[`dropped_iterations{scenario:${kind.name}_${step.name}}`] = ['count>=0'];
  }
  // The real limits, per step. Crossing them is how the stress run finds the breaking point.
  thresholds[`http_req_duration{journey:reader,step:${step.name}}`] = ['p(95)<500'];
  thresholds[`http_req_duration{journey:heavy,step:${step.name}}`] = ['p(95)<650'];
  thresholds[`http_req_duration{journey:write,step:${step.name}}`] = ['p(95)<1000'];
  thresholds[`http_req_failed{step:${step.name}}`] = ['rate<0.01'];
});
scenarios.login_stress = {
  executor: 'constant-arrival-rate',
  exec: 'loginJourney',
  rate: 5, // one every 12 s, under Strapi's limit of 10 per 60 s per IP
  timeUnit: '1m',
  duration: `${STEPS.length * STEP_SECONDS}s`,
  startTime: WARMUP_LENGTH,
  gracefulStop: '10s',
  preAllocatedVUs: 1,
  maxVUs: 2,
  tags: { step: 'login', phase: 'hold' },
};

export const options = { scenarios, thresholds };

export function setup() {
  preflight();
}
