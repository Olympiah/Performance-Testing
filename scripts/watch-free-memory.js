// Stops k6 when the machine is short of memory or the sampler stops writing.
//   node scripts/watch-free-memory.js results/calibration-sqlite.csv [--min 800] [--stale 60]
// Run it next to scripts/sample-stats.js, which writes the CSV. Every 2 seconds it reads the
// last row:
//   free_mem_mb below --min (MB)       k6 is stopped, exit code 2
//   CSV not updated for 15 s           a warning, once
//   CSV not updated for --stale (s)    k6 is stopped, exit code 2
//   k6 gone from the CSV after it was in it   "k6 has finished", exit code 0
// free_mem_mb leaves out cached data that Windows can reclaim, so it can read low without real
// trouble. A stop near the limit with no other sign of a problem deserves a second look.
const fs = require('fs');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : Number(args[i + 1]);
};
const file = args[0];
const min = option('--min', 800);
const stale = option('--stale', 60);
if (!file || file.startsWith('--') || !(min > 0) || !(stale > 0)) {
  console.error('Usage: node scripts/watch-free-memory.js <sampler.csv> [--min MB] [--stale SECONDS]');
  process.exit(1);
}

const startedAt = Date.now();
let lowest = Infinity;
let seenK6 = false;
let warned = false;

// The last row as an object, or null if the file is missing, has no rows yet or the last row is
// half written (fewer cells than the header).
function lastRow() {
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;
  const header = lines[0].split(',');
  const cells = lines[lines.length - 1].split(',');
  if (cells.length !== header.length) return null;
  return Object.fromEntries(header.map((h, i) => [h, cells[i]]));
}

function stopK6(reason) {
  console.error(reason);
  try {
    execFileSync('taskkill', ['/IM', 'k6.exe', '/F'], { stdio: 'ignore' });
    console.error('k6 was stopped.');
  } catch (e) {
    console.error('taskkill found no k6 to stop.');
  }
  report();
  process.exit(2);
}

function report() {
  console.log(`Lowest free memory seen: ${lowest === Infinity ? 'none' : lowest + ' MB'}`);
}

setInterval(() => {
  // Seconds since the CSV last changed. Before it exists, count from when this script started.
  const changed = fs.existsSync(file) ? fs.statSync(file).mtimeMs : startedAt;
  const quiet = (Date.now() - Math.max(changed, startedAt)) / 1000;
  if (quiet > stale) stopK6(`The CSV has not updated for ${Math.round(quiet)} s. Stopping k6.`);
  if (quiet > 15 && !warned) {
    warned = true;
    console.warn(`Warning: the CSV has not updated for ${Math.round(quiet)} s. k6 is stopped at ${stale} s.`);
  }

  const row = lastRow();
  if (!row) return;
  if (quiet <= 15) warned = false;

  const free = Number(row.free_mem_mb);
  if (free < lowest) lowest = free;
  if (free < min) stopK6(`Free memory is ${free} MB, under the ${min} MB limit. Stopping k6.`);

  if (row.k6_mem_mb !== '') seenK6 = true;
  else if (seenK6) {
    console.log('k6 has finished.');
    report();
    process.exit(0);
  }
}, 2000);
