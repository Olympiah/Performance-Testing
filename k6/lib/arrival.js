// Arrival-rate scenarios for the mixed workload (80% reader, 10% heavy reader, 10% writer), shared
// by the load, stress, spike and soak profiles. calibration.js, calibration-high.js and baseline.js
// keep their own copies on purpose: their results came from those exact files.

// iterSec is how long one iteration takes while the server is quick: a reader or writer journey is
// 3 requests with 2 think-time pauses (about 4.2 s), a heavy reader is one request (about 0.3 s).
// minMaxVUs is the floor for the VU cap. The heavy reader ran out of its 4 VUs first in the second
// calibration, when its responses took 1 to 3 s, so it needs about rate x 3 VUs under overload.
export const KINDS = [
  { name: 'reader', exec: 'reader', share: 0.8, iterSec: 4.2, minMaxVUs: 4 },
  { name: 'heavy', exec: 'heavyReader', share: 0.1, iterSec: 0.3, minMaxVUs: 30 },
  { name: 'writer', exec: 'writer', share: 0.1, iterSec: 4.2, minMaxVUs: 4 },
];

// k6 wants a whole number of iterations per time unit, so the rate is given per minute.
// maxFactor is how many times the quick-server VU count the cap allows. A slow server holds VUs
// longer, and when the cap runs out k6 drops iterations, which flags the step as limited by k6
// and not by Strapi.
export function scenario(kind, total, startTime, duration, step, phase, maxFactor = 2) {
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
    maxVUs: Math.max(kind.minMaxVUs, unloaded * maxFactor),
    tags: { step, phase },
  };
}
