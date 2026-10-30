// Spike: 2 minutes at T = 24 journeys/s, a jump to 2T in 10 s, 2 minutes at 2T, then back to T for
// 3 minutes, after a 60 s warm-up at T/2. S8 asks whether reader p95 returns to within 2x of its
// pre-spike level (the last 60 s of the "pre" phase) for 3 windows of 10 s in a row, within 60 s of
// the spike's end. That needs the raw points, so run it with --out csv. The phases are separate
// scenarios, tagged "step", so the CSV can be cut by phase. Login runs at 5 per minute, tagged
// "login". Restore the snapshot before the run.
// Run with: k6 run -e DB=postgres --out csv=results/spike-postgres-points.csv k6/profiles/spike.js
import { preflight } from '../lib/auth.js';
import { KINDS, scenario, rampScenario } from '../lib/arrival.js';
import { reader } from '../scenarios/reader.js';
import { heavyReader } from '../scenarios/heavy-reader.js';
import { writer } from '../scenarios/writer.js';
import { loginJourney } from '../scenarios/login.js';

export { reader, heavyReader, writer, loginJourney };

const T = 24;
const WARMUP_RATE = 12; // T/2
const WARMUP_SECONDS = 60;
const PRE_SECONDS = 120;
const RAMP = '10s';
const SPIKE_HOLD = '120s';
const RECOVERY_SECONDS = 180;
const SPIKE_START = WARMUP_SECONDS + PRE_SECONDS; // 180 s
const RECOVERY_START = SPIKE_START + 10 + 120; // 310 s
const TOTAL_SECONDS = RECOVERY_START + RECOVERY_SECONDS; // 490 s

const scenarios = {};
for (const kind of KINDS) {
  scenarios[`${kind.name}_warm`] = scenario(kind, WARMUP_RATE, '0s', `${WARMUP_SECONDS}s`, 'warm', 'warmup');
  scenarios[`${kind.name}_pre`] = scenario(kind, T, `${WARMUP_SECONDS}s`, `${PRE_SECONDS}s`, 'pre', 'pre');
  scenarios[`${kind.name}_spike`] = rampScenario(
    kind, T, [{ duration: RAMP, total: 2 * T }, { duration: SPIKE_HOLD, total: 2 * T }],
    `${SPIKE_START}s`, 'spike', 'spike');
  // The drop back to T is instant, because a new scenario starts at the rate of T.
  scenarios[`${kind.name}_recovery`] = scenario(
    kind, T, `${RECOVERY_START}s`, `${RECOVERY_SECONDS}s`, 'recovery', 'recovery');
}
scenarios.login_spike = {
  executor: 'constant-arrival-rate',
  exec: 'loginJourney',
  rate: 5,
  timeUnit: '1m',
  duration: `${TOTAL_SECONDS - WARMUP_SECONDS}s`,
  startTime: `${WARMUP_SECONDS}s`,
  gracefulStop: '10s',
  preAllocatedVUs: 1,
  maxVUs: 2,
  tags: { step: 'login', phase: 'hold' },
};

// Only the "pre" phase has a real limit: it must hold S1 and S4, or the reference level means
// nothing. The spike and recovery lines only make k6 print them. S8 is judged from the CSV.
export const options = {
  scenarios,
  thresholds: {
    'http_req_duration{journey:reader,step:pre}': ['p(95)<500'],
    'http_req_duration{journey:reader,step:spike}': ['p(95)>=0'],
    'http_req_duration{journey:reader,step:recovery}': ['p(95)>=0'],
    'http_req_duration{journey:heavy,step:spike}': ['p(95)>=0'],
    'http_req_duration{journey:write,step:spike}': ['p(95)>=0'],
    'http_req_failed{step:pre}': ['rate<0.01'],
    'http_req_failed{step:spike}': ['rate>=0'],
    'http_req_failed{step:recovery}': ['rate>=0'],
    'http_reqs{status:429}': ['count==0'],
  },
};

export function setup() {
  preflight();
}
