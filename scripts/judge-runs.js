'use strict';
// Judges S6 (Strapi CPU), S7 (Strapi memory growth) and S8 (recovery after the spike) from the files
// in results/. Read-only: it writes no files, prints no secrets and prints no raw rows.
// Usage: node scripts/judge-runs.js
// Percentiles: the p95 of Strapi CPU samples uses nearest rank (as in the notes), the p95 of reader
// latency uses linear interpolation between ranks (like k6).
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ---- Limits and windows (all in one place). Seconds are counted from k6's first sampler row. ----
const RESULTS = path.join(__dirname, '..', 'results');
const SAMPLE_S = 5;                  // sampler interval; windows count rows, 5 s each
const TRIM_S = 10;                   // cut from each end of an S6 window
const WARMUP_S = 60;
const LOAD_HOLD_S = 600;
const SOAK_HOLD_S = 1800;
const STRESS_STEP_S = 180;
const STRESS_STEPS = ['x1', 'x1_5', 'x2', 'x3'];
const S6_LIMIT_AT_T = 60;            // % of one logical processor, mean, at target load
const S6_LIMIT_AT_1_5T = 80;         // same, at 1.5x target load (stress step x1_5)
const S7_LIMIT_PCT = 20;             // growth of the median Strapi private memory
const S7_EDGE_S = 180;               // first and last 3 minutes of the hold
const S8_WINDOW_S = 10;
const S8_RUN = 3;                    // windows in a row
const S8_N_S = 60;                   // the third window must end within this many seconds
const S8_FACTOR = 2;                 // of the reader p95 before the spike
const S8_REF_S = 60;                 // reference = last 60 s of the "pre" step
const S1_MS = 500;                   // a reference above this is not a healthy level
// Not-evaluable limits. Starting heuristics, fixed before the script was run.
const MIN_ROW_FRACTION = 0.9;        // share of a window's rows that must have a value
const MAX_GAP_S = 15;                // largest gap between sampler rows inside a window
const MIN_REF_REQUESTS = 1000;       // reader requests in the S8 reference period
const MIN_WINDOW_REQUESTS = 100;     // reader requests in an S8 window
// CPU speed check (validity of a run, not an S limit), from the handoff.
const BUSY_PCT = 100, BUSY_MIN_SAMPLES = 10, PERF_MEDIAN_MIN = 80, PERF_DROP_MAX = 20;

const RUNS = [
  { name: 'load-sqlite-1', db: 'sqlite', kind: 'load', planned: true },
  { name: 'load-sqlite-2', db: 'sqlite', kind: 'load', planned: true },
  { name: 'load-sqlite-3', db: 'sqlite', kind: 'load', planned: true },
  { name: 'load-postgres-1', db: 'postgres', kind: 'load', planned: true },
  { name: 'load-postgres-2', db: 'postgres', kind: 'load', planned: true },
  { name: 'load-postgres-3', db: 'postgres', kind: 'load', planned: true },
  { name: 'load-postgres-4', db: 'postgres', kind: 'load', planned: false }, // check run
  { name: 'stress-postgres-1', db: 'postgres', kind: 'stress' },
  { name: 'soak-postgres', db: 'postgres', kind: 'soak' },
  { name: 'spike-postgres-1', db: 'postgres', kind: 'spike' },
];

// Numbers I have already seen, for the check section.
const LOGGED = {
  cpu: { 'load-sqlite-1': 43.36, 'load-sqlite-2': 45.06, 'load-sqlite-3': 43.88,
         'load-postgres-1': 57.01, 'load-postgres-2': 58.24, 'load-postgres-3': 57.64 },
  stressX1_5: 82.7,
  s7: { first: 404, last: 409, growth: 1.2 },
  s8: { ref: 44.35, refN: 3454, limit: 88.7, first: 2153, w1: 53, w2: 68, w3: 58, w8: 142, w10: 107 },
};

// ---- Helpers ----
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const pct = (a, p) => { // linear interpolation between ranks, like k6
  const s = [...a].sort((x, y) => x - y); const r = (s.length - 1) * p; const lo = Math.floor(r);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (r - lo);
};
const median = (a) => pct(a, 0.5);
const nearest = (a, p) => [...a].sort((x, y) => x - y)[Math.ceil(p * a.length) - 1]; // nearest rank
const f = (x, d = 2) => x.toFixed(d);
const splitCsv = (line) => {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur); return out;
};

function readSampler(name) {
  const file = path.join(RESULTS, name + '.csv');
  if (!fs.existsSync(file)) return null;
  const [head, ...lines] = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const cols = head.split(',');
  const rows = lines.map((line) => {
    const c = line.split(',');
    const o = { time: Date.parse(c[0]) / 1000 };
    cols.forEach((n, i) => { if (i > 0) o[n] = c[i] === '' ? null : Number(c[i]); });
    return o;
  });
  return { rows, start: rows.findIndex((r) => r.k6_private_mb != null) }; // k6's first row
}

// Rows fromS..toS after k6's first row (5 s per row), or the reason it cannot be judged.
function slice(s, fromS, toS, key) {
  if (!s) return { why: 'no sampler file' };
  if (s.start < 0) return { why: 'no row with k6 data, so the start of k6 is unknown' };
  const a = s.start + fromS / SAMPLE_S, b = s.start + toS / SAMPLE_S;
  if (b >= s.rows.length) return { why: `the sampler ends before the window does (window needs ${b - s.start} rows after k6 start, file has ${s.rows.length - 1 - s.start})` };
  const rows = s.rows.slice(a, b + 1);
  const vals = rows.map((r) => r[key]).filter((v) => v != null);
  if (vals.length < MIN_ROW_FRACTION * rows.length) return { why: `only ${vals.length} of ${rows.length} rows have ${key}` };
  for (let i = 1; i < rows.length; i++) {
    const gap = rows[i].time - rows[i - 1].time;
    if (gap > MAX_GAP_S) return { why: `a gap of ${f(gap, 0)} s between sampler rows` };
  }
  return { rows, vals };
}

function cpuWindow(s, fromS, toS) {
  const w = slice(s, fromS, toS, 'strapi_cpu_pct');
  if (w.why) return w;
  return { n: w.vals.length, mean: mean(w.vals), p95: nearest(w.vals, 0.95), max: Math.max(...w.vals), rows: w.rows };
}
const s6Verdict = (r, limit) => (r.why ? `not evaluable: ${r.why}` : r.mean < limit ? 'pass' : 'fail');

// First third against last third use the mean of the busy samples in each.
function perfCheck(rows) {
  const busy = rows.filter((r) => (r.strapi_cpu_pct || 0) + (r.k6_cpu_pct || 0) + (r.postgres_cpu_pct || 0) >= BUSY_PCT && r.cpu_perf_pct != null);
  if (busy.length < BUSY_MIN_SAMPLES) return `not evaluable: ${busy.length} busy samples, need ${BUSY_MIN_SAMPLES}`;
  const med = median(busy.map((r) => r.cpu_perf_pct));
  const third = Math.floor(rows.length / 3), set = new Set(busy);
  const part = (rs) => rs.filter((r) => set.has(r)).map((r) => r.cpu_perf_pct);
  const a = part(rows.slice(0, third)), b = part(rows.slice(-third));
  const problems = []; let text = `median ${f(med, 1)} over ${busy.length} busy samples`;
  if (med < PERF_MEDIAN_MIN) problems.push(`median under ${PERF_MEDIAN_MIN}`);
  if (a.length >= 3 && b.length >= 3) {
    text += `, first third ${f(mean(a), 1)}, last third ${f(mean(b), 1)}`;
    if (mean(a) - mean(b) > PERF_DROP_MAX) problems.push(`last third more than ${PERF_DROP_MAX} points below the first`);
  } else text += ', thirds not comparable (too few busy samples)';
  return text + (problems.length ? ` -> PROBLEM: ${problems.join('; ')}` : ' -> no problem found');
}

function s7(s) {
  const holdEnd = WARMUP_S + SOAK_HOLD_S;
  const first = slice(s, WARMUP_S, WARMUP_S + S7_EDGE_S - SAMPLE_S, 'strapi_private_mb');
  const last = slice(s, holdEnd - S7_EDGE_S + SAMPLE_S, holdEnd, 'strapi_private_mb');
  if (first.why || last.why) return { why: first.why ? `first 3 minutes: ${first.why}` : `last 3 minutes: ${last.why}` };
  const a = median(first.vals), b = median(last.vals), growth = (b / a - 1) * 100;
  return { first: a, last: b, growth, status: growth <= S7_LIMIT_PCT ? 'pass' : 'fail', n: [first.vals.length, last.vals.length] };
}

// P99 is reported with no limit. The k6 summary files hold p90 and p95 only, so p99 comes from the points files of the spike and the soak.
const P99_FILES = [
  { name: 'spike-postgres-1', steps: ['pre', 'spike', 'recovery'] },
  { name: 'soak-postgres', steps: ['soak'] },
];
async function readP99(spec) {
  const file = path.join(RESULTS, spec.name + '-points.csv');
  if (!fs.existsSync(file)) return null;
  const rl = readline.createInterface({ input: fs.createReadStream(file) });
  let idx = null; const groups = {};
  for await (const line of rl) {
    if (!idx) { idx = Object.fromEntries(splitCsv(line).map((n, i) => [n, i])); continue; }
    if (!line.startsWith('http_req_duration,')) continue;
    const c = splitCsv(line); const tags = new URLSearchParams(c[idx.extra_tags]);
    const step = tags.get('step'), journey = tags.get('journey');
    if (!spec.steps.includes(step) || !['reader', 'heavy', 'write'].includes(journey)) continue;
    (groups[`${journey}|${step}`] = groups[`${journey}|${step}`] || []).push(Number(c[idx.metric_value]));
  }
  return groups;
}

async function readSpikePoints(name) {
  const file = path.join(RESULTS, name + '-points.csv');
  if (!fs.existsSync(file)) return null;
  const rl = readline.createInterface({ input: fs.createReadStream(file) });
  let idx = null, recStart = Infinity, spikeStart = Infinity, preStart = Infinity, dataEnd = -Infinity; const reader = [];
  for await (const line of rl) {
    if (!idx) { idx = Object.fromEntries(splitCsv(line).map((n, i) => [n, i])); continue; }
    if (!line.startsWith('http_req_duration,')) continue;
    const c = splitCsv(line); const tags = new URLSearchParams(c[idx.extra_tags]);
    const ts = Number(c[idx.timestamp]), step = tags.get('step');
    if (step === 'recovery') recStart = Math.min(recStart, ts);   // first point of any journey
    if (step === 'spike') spikeStart = Math.min(spikeStart, ts);  // first point of any journey
    if (step === 'pre') preStart = Math.min(preStart, ts);
    if (tags.get('journey') === 'reader') { reader.push({ ts, ms: Number(c[idx.metric_value]), step }); dataEnd = Math.max(dataEnd, ts); }
  }
  return { reader, recStart, spikeStart, preStart, dataEnd };
}

function s8(p) {
  const no = (why) => ({ status: 'not evaluable', why });
  if (!p) return no('no points file');
  if (!isFinite(p.recStart) || !isFinite(p.spikeStart)) return no('no points tagged step=spike or step=recovery');
  const ref = p.reader.filter((x) => x.step === 'pre' && x.ts >= p.spikeStart - S8_REF_S && x.ts < p.spikeStart).map((x) => x.ms);
  if (ref.length < MIN_REF_REQUESTS) return no(`only ${ref.length} reader requests in the reference period, need ${MIN_REF_REQUESTS}`);
  const refP95 = pct(ref, 0.95);
  if (refP95 > S1_MS) return no(`the reference p95 (${f(refP95)} ms) is already over S1 (${S1_MS} ms)`);
  const limit = S8_FACTOR * refP95;
  // Context only, never used in a verdict: the same 10 s windows over the "pre" step, counted back from the spike.
  const preWindows = [];
  for (let hi = p.spikeStart; hi - S8_WINDOW_S >= p.preStart; hi -= S8_WINDOW_S) {
    const lo = hi - S8_WINDOW_S;
    const v = p.reader.filter((x) => x.step === 'pre' && x.ts >= lo && x.ts < hi).map((x) => x.ms);
    preWindows.unshift({ offset: lo - p.spikeStart, n: v.length, p95: v.length ? pct(v, 0.95) : NaN, judgeable: v.length >= MIN_WINDOW_REQUESTS });
  }
  // Every reader request that finishes in a window counts, including spike requests still draining.
  const after = p.reader.filter((x) => x.ts >= p.recStart);
  const windows = [];
  for (let k = 0; ; k++) {
    const lo = p.recStart + k * S8_WINDOW_S, hi = lo + S8_WINDOW_S;
    if (hi > p.dataEnd + 1) break;
    const v = after.filter((x) => x.ts >= lo && x.ts < hi).map((x) => x.ms);
    const judgeable = v.length >= MIN_WINDOW_REQUESTS, p95 = v.length ? pct(v, 0.95) : NaN;
    windows.push({ offset: k * S8_WINDOW_S, n: v.length, p95, judgeable, ok: judgeable && p95 <= limit });
  }
  const maxK = S8_N_S / S8_WINDOW_S; let hit = -1;
  for (let k = 0; k + S8_RUN <= Math.min(windows.length, maxK); k++) {
    if (windows.slice(k, k + S8_RUN).every((w) => w.ok)) { hit = k; break; }
  }
  const base = { refP95, refN: ref.length, limit, windows, hit, preWindows };
  if (hit >= 0) return { ...base, status: 'pass', later: windows.slice(hit + S8_RUN).filter((w) => w.judgeable && w.p95 > limit) };
  if (windows.length < maxK) return { ...base, status: 'not evaluable', why: `the data ends ${windows.length * S8_WINDOW_S} s after the spike, less than ${S8_N_S} s` };
  if (windows.slice(0, maxK).some((w) => !w.judgeable)) return { ...base, status: 'not evaluable', why: `a window within ${S8_N_S} s has fewer than ${MIN_WINDOW_REQUESTS} requests` };
  return { ...base, status: 'fail' };
}

function droppedIterations(name) {
  const file = path.join(RESULTS, name + '-summary.json');
  if (!fs.existsSync(file)) return null;
  const m = JSON.parse(fs.readFileSync(file, 'utf8')).metrics;
  return m.dropped_iterations ? m.dropped_iterations.count : 0;
}

(async () => {
  const samplers = {}; for (const r of RUNS) samplers[r.name] = readSampler(r.name);
  const holdFrom = WARMUP_S + TRIM_S, holdTo = WARMUP_S + LOAD_HOLD_S - TRIM_S;
  const cpu = {};
  for (const r of RUNS.filter((x) => x.kind === 'load')) cpu[r.name] = cpuWindow(samplers[r.name], holdFrom, holdTo);
  const stress = {};
  for (const r of RUNS.filter((x) => x.kind === 'stress')) {
    stress[r.name] = STRESS_STEPS.map((name, i) => ({ name, ...cpuWindow(samplers[r.name], WARMUP_S + i * STRESS_STEP_S + TRIM_S, WARMUP_S + (i + 1) * STRESS_STEP_S - TRIM_S) }));
  }
  const soakRuns = RUNS.filter((x) => x.kind === 'soak');
  const soak7 = {}; for (const r of soakRuns) soak7[r.name] = s7(samplers[r.name]);
  const spike8 = {}; for (const r of RUNS.filter((x) => x.kind === 'spike')) spike8[r.name] = s8(await readSpikePoints(r.name));

  // ---- Check against numbers already seen ----
  const checks = [];
  const check = (label, computed, logged, d) => checks.push({ label, computed, logged, d });
  for (const [name, logged] of Object.entries(LOGGED.cpu)) if (!cpu[name].why) check(`S6 mean ${name}`, cpu[name].mean, logged, 2);
  const x15 = (stress['stress-postgres-1'] || []).find((s) => s.name === 'x1_5');
  if (x15 && !x15.why) check('S6 stress x1_5 mean', x15.mean, LOGGED.stressX1_5, 1);
  const k7 = soak7['soak-postgres'];
  if (k7 && !k7.why) { check('S7 median first 3 min (MB)', k7.first, LOGGED.s7.first, 0); check('S7 median last 3 min (MB)', k7.last, LOGGED.s7.last, 0); check('S7 growth (%)', k7.growth, LOGGED.s7.growth, 1); }
  const k8 = spike8['spike-postgres-1'];
  if (k8 && k8.windows) {
    const w = k8.windows; const g = LOGGED.s8;
    check('S8 reference p95 (ms)', k8.refP95, g.ref, 2); check('S8 reference requests', k8.refN, g.refN, 0); check('S8 limit (ms)', k8.limit, g.limit, 1);
    [['window +0 s (first)', 0, g.first], ['window +10 s', 1, g.w1], ['window +20 s', 2, g.w2], ['window +30 s', 3, g.w3], ['window +80 s', 8, g.w8], ['window +100 s', 10, g.w10]]
      .forEach(([label, i, logged]) => { if (w[i]) check(`S8 ${label} p95 (ms)`, w[i].p95, logged, 0); });
  }
  console.log('CHECK AGAINST NUMBERS ALREADY SEEN');
  for (const c of checks) {
    const same = c.computed.toFixed(c.d) === c.logged.toFixed(c.d);
    console.log(`  ${c.label.padEnd(34)} computed ${f(c.computed, c.d).padStart(9)}  logged ${f(c.logged, c.d).padStart(9)}  ${same ? 'match' : 'DIFFERENT by ' + f(c.computed - c.logged, Math.max(c.d, 2))}`);
  }

  // ---- S6 ----
  console.log(`\nS6 Strapi CPU, mean over the hold window (${holdFrom}-${holdTo} s after k6's first sampler row), limit ${S6_LIMIT_AT_T}% at T`);
  for (const r of RUNS.filter((x) => x.kind === 'load')) {
    const c = cpu[r.name];
    const tag = r.planned ? '' : '  (check run, not in the database verdict)';
    console.log(`  ${r.name.padEnd(17)} ${c.why ? '' : `mean ${f(c.mean).padStart(6)}  p95 ${f(c.p95, 1).padStart(5)}  max ${f(c.max, 1).padStart(5)}  n ${c.n}  `}${s6Verdict(c, S6_LIMIT_AT_T)}${tag}`);
  }
  for (const db of ['sqlite', 'postgres']) {
    const reps = RUNS.filter((x) => x.kind === 'load' && x.planned && x.db === db);
    const bad = reps.filter((r) => cpu[r.name].why);
    let text;
    if (bad.length) text = `not evaluable (${bad.map((r) => `${r.name}: ${cpu[r.name].why}`).join('; ')})`;
    else {
      const means = reps.map((r) => cpu[r.name].mean), fails = reps.filter((r) => cpu[r.name].mean >= S6_LIMIT_AT_T);
      text = `${fails.length ? 'FAIL (' + fails.map((r) => r.name).join(', ') + ')' : 'pass (all ' + reps.length + ' repeats)'}; median ${f(median(means))}, range ${f(Math.min(...means))} to ${f(Math.max(...means))}`;
    }
    console.log(`  ${db} verdict: ${text}`);
  }
  for (const r of soakRuns) {
    const w = cpuWindow(samplers[r.name], holdFrom, WARMUP_S + SOAK_HOLD_S - TRIM_S);
    console.log(`  ${r.name.padEnd(17)} ${w.why ? 'not evaluable: ' + w.why : `mean ${f(w.mean).padStart(6)}  p95 ${f(w.p95, 1)}  max ${f(w.max, 1)}  n ${w.n}  (information only, S6 is judged on the load repeats)`}`);
  }
  for (const [name, steps] of Object.entries(stress)) {
    console.log(`\nS6 at 1.5x T, ${name}: mean per step, each step ${STRESS_STEP_S} s trimmed ${TRIM_S} s at each end`);
    for (const s of steps) {
      const limit = s.name === 'x1_5' ? S6_LIMIT_AT_1_5T : null;
      console.log(`  ${s.name.padEnd(5)} ${s.why ? 'not evaluable: ' + s.why : `mean ${f(s.mean).padStart(7)}  p95 ${f(s.p95, 1).padStart(6)}  max ${f(s.max, 1).padStart(6)}  n ${s.n}  `}${limit ? s6Verdict(s, limit) + ` (limit ${limit}%)` : s.why ? '' : 'no limit'}`);
    }
  }

  // ---- S7 ----
  console.log(`\nS7 Strapi private memory, median of the first 3 minutes of the hold against the last 3 minutes, limit ${S7_LIMIT_PCT}%`);
  for (const r of soakRuns) {
    const k = soak7[r.name];
    console.log(`  ${r.name}: ${k.why ? 'not evaluable: ' + k.why : `first ${f(k.first, 1)} MB, last ${f(k.last, 1)} MB, growth ${f(k.growth, 1)}% (rows ${k.n.join(' and ')}) -> ${k.status}`}`);
  }
  console.log('  Other runs: not applicable (S7 is judged on the soak only). Table size and time since start grow together in the soak, so they cannot be separated.');

  // ---- S8 ----
  console.log(`\nS8 reader p95 back within ${S8_FACTOR}x of its level before the spike, ${S8_RUN} windows of ${S8_WINDOW_S} s in a row, within ${S8_N_S} s of the spike's end`);
  for (const [name, k] of Object.entries(spike8)) {
    if (k.refP95 != null) {
      console.log(`  ${name}: reference ${f(k.refP95)} ms (${k.refN} requests), limit ${f(k.limit, 1)} ms`);
      console.log('    ' + k.windows.slice(0, 12).map((w) => `+${w.offset}s ${w.judgeable ? f(w.p95, 0) : 'n/a'}${w.ok ? '' : '*'}`).join('  ') + '   (* over the limit or too few requests)');
      const judged = k.preWindows.filter((w) => w.judgeable), over = judged.filter((w) => w.p95 > k.limit);
      console.log('    before the spike (context only, no effect on the verdict): ' + k.preWindows.map((w) => `${w.offset}s ${w.judgeable ? f(w.p95, 0) : 'n/a'}${w.judgeable && w.p95 > k.limit ? '*' : ''}`).join('  ') + `   (${over.length} of ${judged.length} over the limit)`);
    }
    console.log(`  ${name}: ${k.status}${k.why ? ' (' + k.why + ')' : k.status === 'pass' ? ` (windows +${k.windows[k.hit].offset} s to +${k.windows[k.hit + S8_RUN - 1].offset + S8_WINDOW_S} s)` : ''}`);
    if (k.later && k.later.length) console.log(`    later windows over the limit: ${k.later.map((w) => `+${w.offset} s ${f(w.p95, 0)} ms`).join(', ')} (a stricter "stays under" reading would fail)`);
  }
  console.log('  Timestamps in the points file are whole seconds, so window edges are about +-2 s.');

  console.log('\nP99 (reported, no limit; the k6 summary files hold p90 and p95 only, so p99 comes from the points files of the spike and the soak)');
  for (const spec of P99_FILES) {
    const g = await readP99(spec);
    if (!g) { console.log(`  ${spec.name}: no points file`); continue; }
    for (const step of spec.steps) for (const journey of ['reader', 'heavy', 'write']) {
      const v = g[`${journey}|${step}`];
      console.log(`  ${spec.name.padEnd(17)} ${step.padEnd(9)} ${journey.padEnd(7)} ${v ? `n ${String(v.length).padStart(6)}  p95 ${f(pct(v, 0.95), 1).padStart(8)}  p99 ${f(pct(v, 0.99), 1).padStart(8)}  max ${f(v.reduce((a, b) => Math.max(a, b), -Infinity), 1)}` : 'no points'}`);
    }
  }

  // ---- Extras ----
  console.log('\nCPU SPEED CHECK (validity of the run, same window as S6)');
  for (const r of RUNS.filter((x) => x.kind === 'load')) console.log(`  ${r.name.padEnd(17)} ${cpu[r.name].why ? 'not evaluable: ' + cpu[r.name].why : perfCheck(cpu[r.name].rows)}`);
  console.log('\nK6 DROPPED ITERATIONS (k6 was the limit if above 0)');
  for (const r of RUNS) { const d = droppedIterations(r.name); console.log(`  ${r.name.padEnd(17)} ${d == null ? 'no summary file' : d + (d > 0 ? '  FLAGGED' : '')}`); }
  console.log('\nWindow boundaries are rows at a nominal 5 s, so they are about +-10 s of real time. S6 and S7 here are judged on single runs on one laptop with k6 on the same machine.');
})();
