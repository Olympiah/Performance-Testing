// Samples the machine every few seconds into a CSV, for the idle baseline and for every measured run.
//   node scripts/sample-stats.js results/baseline-idle-sqlite.csv --seconds 60
// Leave out --seconds to run until Ctrl+C. --interval sets the seconds between samples (default 5).
//
// What it records, per sample: Strapi (the process listening on port 1337), k6 and Postgres
// (all postgres.exe processes added together) as CPU % and memory, the sampler's own PowerShell
// process as CPU %, the CPU speed as "% Processor Performance" (100 = the base speed, below it
// means the CPU is running slower, above it means turbo), and free memory.
//
// Read postgres_mem_mb as an upper bound. The Postgres processes share one memory area, and each
// process's working set includes its part of it, so adding them up counts the shared part several
// times. free_mem_mb comes from the whole machine, so use it as the cross-check.
//
// CPU % is the change in a process's cumulative CPU time divided by the elapsed time, where 100%
// is one logical processor (this machine has 4, so a process can read up to 400%). That is the
// S6 method in the strategy.
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 1337;

// process.argv is [node, script, ...your arguments], so slice(2) keeps only your arguments.
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : Number(args[i + 1]);
};
const outArg = args[0];
const seconds = option('--seconds', 0); // 0 means until Ctrl+C
const interval = option('--interval', 5);
if (!outArg || outArg.startsWith('--') || !(seconds >= 0) || !(interval > 0)) {
  console.error('Usage: node scripts/sample-stats.js <output.csv> [--seconds N] [--interval N]');
  process.exit(1);
}
const out = path.resolve(outArg);

// The CSV holds machine numbers only, but results/ is git-ignored on purpose, so refuse a path that is not.
try {
  execFileSync('git', ['check-ignore', '-q', out], { cwd: ROOT });
} catch (e) {
  console.error(`Refusing to write ${out}: it is not git-ignored.`);
  process.exit(1);
}
// Never overwrite an earlier run's numbers.
if (fs.existsSync(out)) {
  console.error(`Refusing to overwrite ${out}.`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(out), { recursive: true });

// Find Strapi by the port, not by name: VS Code and npm also run as node.
const ps = (script) =>
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
  }).trim();
const found = ps(
  `$c = Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; ` +
    `if ($c) { $c.OwningProcess; (Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)").CommandLine }`,
).split(/\r?\n/);
const strapiPid = Number(found[0]);
const commandLine = (found[1] || '').toLowerCase();
if (!strapiPid) {
  console.error(`Nothing is listening on port ${PORT}. Start Strapi first.`);
  process.exit(1);
}
// Something else could hold the port. Only sample a process that is running strapi.js start.
if (!commandLine.includes('strapi.js') || !commandLine.includes('start')) {
  console.error(`The process on port ${PORT} (pid ${strapiPid}) is not running "strapi.js start". Not sampling.`);
  process.exit(1);
}

// One PowerShell stays open and prints one JSON line per sample. Starting a new PowerShell every
// 5 seconds would cost CPU of its own on a machine this small, and the sampler must not load it.
// $PID is this PowerShell's own process id, read too so the sampler's cost is a column, not a guess.
const loop = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$sw = [Diagnostics.Stopwatch]::StartNew()
$next = 0
while ($true) {
  $procs = @(Get-CimInstance Win32_Process -Filter "ProcessId=${strapiPid} OR ProcessId=$PID OR Name='k6.exe' OR Name='postgres.exe'")
  $ms = $sw.ElapsedMilliseconds
  $os = Get-CimInstance Win32_OperatingSystem
  $perf = (Get-Counter '\\Processor Information(_Total)\\% Processor Performance').CounterSamples[0].CookedValue
  [pscustomobject]@{
    ms = $ms
    self = $PID
    perfPct = [math]::Round($perf, 1)
    freeMb = [math]::Round($os.FreePhysicalMemory / 1024)
    procs = @($procs | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; name = $_.Name; cpu = [uint64]$_.UserModeTime + [uint64]$_.KernelModeTime; ws = [uint64]$_.WorkingSetSize } })
  } | ConvertTo-Json -Compress -Depth 3
  $next += ${interval * 1000}
  $wait = $next - $sw.ElapsedMilliseconds
  if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }
}`;
const child = spawn(
  'powershell',
  ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(loop, 'utf16le').toString('base64')],
  { stdio: ['ignore', 'pipe', 'inherit'] },
);

// If PowerShell dies, say so and fail. The error it printed is already on screen (stderr is
// passed through). Without this the script just ends, with no summary and no message.
child.on('exit', (code) => {
  console.error(`The PowerShell sampler stopped (exit code ${code}). ${rows.length} samples were written.`);
  process.exit(1);
});

const COLUMNS = [
  'time', 'elapsed_s',
  'strapi_cpu_pct', 'strapi_mem_mb',
  'k6_cpu_pct', 'k6_mem_mb',
  'postgres_cpu_pct', 'postgres_mem_mb',
  'sampler_cpu_pct',
  'cpu_perf_pct', 'free_mem_mb',
];
fs.writeFileSync(out, COLUMNS.join(',') + '\n');
console.log(`Sampling Strapi pid ${strapiPid} every ${interval} s into ${out}`);

// The three groups, the sampler's own PowerShell, and which processes belong to each.
// The Node process that reads the output and writes the CSV is not in the sampler column.
const GROUPS = {
  strapi: (p) => p.pid === strapiPid,
  k6: (p) => p.name === 'k6.exe',
  postgres: (p) => p.name === 'postgres.exe', // memory is an upper bound, see the header
  sampler: (p, s) => p.pid === s.self,
};
const previous = { ms: null, cpu: {} }; // cpu: last cumulative CPU time per pid (100 ns units)
const rows = [];

function handle(line) {
  const s = JSON.parse(line);
  const procs = [].concat(s.procs || []);
  const row = { time: new Date().toISOString(), elapsed_s: (s.ms / 1000).toFixed(1) };
  const nowCpu = {};

  for (const [group, belongs] of Object.entries(GROUPS)) {
    const members = procs.filter((p) => belongs(p, s));
    if (members.length === 0) {
      row[`${group}_cpu_pct`] = '';
      row[`${group}_mem_mb`] = '';
      continue;
    }
    let delta = 0;
    for (const p of members) {
      nowCpu[p.pid] = p.cpu;
      // A process seen for the first time counts all its CPU time so far, because it started
      // since the last sample. A process that exited between samples is lost, which is a small
      // error for Postgres connections and none for Strapi and k6, which run all along.
      delta += p.pid in previous.cpu ? p.cpu - previous.cpu[p.pid] : p.cpu;
    }
    // 100 ns units: ms * 10,000 of them per ms. 100% = one logical processor.
    row[`${group}_cpu_pct`] =
      previous.ms === null ? '' : ((delta / ((s.ms - previous.ms) * 10000)) * 100).toFixed(1);
    row[`${group}_mem_mb`] = (members.reduce((sum, p) => sum + p.ws, 0) / 1048576).toFixed(0);
  }
  row.cpu_perf_pct = s.perfPct;
  row.free_mem_mb = s.freeMb;

  previous.ms = s.ms;
  previous.cpu = nowCpu;
  rows.push(row);
  fs.appendFileSync(out, COLUMNS.map((c) => row[c]).join(',') + '\n');

  if (!(strapiPid in nowCpu)) console.warn('Strapi is no longer running.');
  if (seconds > 0 && s.ms >= seconds * 1000) stop();
}

let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop(); // the last piece may be half a line
  lines.filter(Boolean).forEach(handle);
});

// Only means of what was sampled. Empty cells (the first CPU reading, or no k6 or Postgres
// running) are left out of that column's mean.
function stop() {
  child.kill();
  console.log(`\n${rows.length} samples written to ${out}. Means:`);
  for (const c of COLUMNS.slice(2)) {
    const values = rows.map((r) => r[c]).filter((v) => v !== '').map(Number);
    console.log(`  ${c}: ${values.length ? (values.reduce((a, b) => a + b, 0) / values.length).toFixed(1) : 'no data'}`);
  }
  process.exit(0);
}
process.on('SIGINT', stop);
