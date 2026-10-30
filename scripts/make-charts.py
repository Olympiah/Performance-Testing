"""Draws the three charts in docs/charts/ from the files in results/.
Usage:
  py scripts/make-charts.py --check         print the numbers, compare them to docs/03-results.md, draw nothing
  py scripts/make-charts.py                 check first, then write the three SVGs to docs/charts/
  py scripts/make-charts.py --png <folder>  also write a PNG of each chart there (for looking at, not committed)
Needs Python 3 and matplotlib. Read-only on results/. If a number differs from the doc it stops and draws nothing.
"""
import csv
import json
import math
import os
import sys

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
RESULTS = os.path.join(ROOT, 'results')
OUT = os.path.join(ROOT, 'docs', 'charts')

# Thresholds from the strategy.
S1_MS, S2_MS, S3_MS = 500, 650, 1000
S8_FACTOR = 2
S8_RUN = 3                 # windows in a row
S8_N_WINDOWS = 6           # N = 60 s of 10 s windows
WINDOW_S = 10
MIN_WINDOW_REQUESTS = 100  # same as judge-runs.js
REF_S = 60                 # reference = last 60 s of the "pre" step
STEPS = ['x1', 'x1_5', 'x2', 'x3']
JOURNEYS = ['reader', 'heavy', 'write']

# Values written in docs/03-results.md. The script stops if the files disagree with them.
DOC_STRESS = {'reader': ['61.59 ms', '210.16 ms', '4.70 s', '8.09 s'],
              'heavy': ['105.25 ms', '250.90 ms', '4.76 s', '8.18 s'],
              'write': ['172.07 ms', '331.27 ms', '3.78 s', '6.30 s']}
DOC_SOAK_MIN, DOC_SOAK_MAX_OTHER, DOC_SOAK_OUTLIER, DOC_SOAK_MINUTES = 38, 79, 159, 30
DOC_SPIKE_REF = 44.35
DOC_SPIKE_THRESHOLD = 88.7
DOC_SPIKE_WINDOWS = {0: 2153, 10: 53, 20: 68, 30: 58, 80: 142, 100: 107, 130: 120, 140: 91, 160: 109}
DOC_SPIKE_HIT = 10         # first of the three passing windows, seconds after the spike


def pct(values, p):
    """Percentile with linear interpolation between ranks, as judge-runs.js does for latency."""
    v = sorted(values)
    k = (len(v) - 1) * p
    lo = int(k)
    hi = min(lo + 1, len(v) - 1)
    return v[lo] + (v[hi] - v[lo]) * (k - lo)


def points(name):
    """Yields (timestamp, duration ms, tags) for every http_req_duration row of a k6 points file."""
    with open(os.path.join(RESULTS, name + '-points.csv'), newline='') as f:
        rows = csv.reader(f)
        idx = {n: i for i, n in enumerate(next(rows))}
        for r in rows:
            if r[0] != 'http_req_duration':
                continue
            tags = dict(t.split('=', 1) for t in r[idx['extra_tags']].split('&') if '=' in t)
            yield int(r[idx['timestamp']]), float(r[idx['metric_value']]), tags


def stress_values():
    with open(os.path.join(RESULTS, 'stress-postgres-1-summary.json')) as f:
        m = json.load(f)['metrics']
    return {j: [m['http_req_duration{journey:%s,step:%s}' % (j, s)]['p(95)'] for s in STEPS] for j in JOURNEYS}


def soak_minutes():
    """Reader p95 per full minute of the soak hold, counted from its first point."""
    start, end, reader = None, 0, []
    for ts, ms, t in points('soak-postgres'):
        if t.get('step') != 'soak':
            continue
        start = ts if start is None else min(start, ts)
        if t.get('journey') == 'reader':
            reader.append((ts, ms))
            end = max(end, ts)
    bins = {}
    for ts, ms in reader:
        bins.setdefault((ts - start) // 60, []).append(ms)
    return [pct(bins[k], 0.95) for k in sorted(bins) if (k + 1) * 60 <= end - start + 1]


def spike_windows():
    """Reader p95 per 10 s window, aligned to the first point of the recovery step like judge-runs.js."""
    pre = spk = rec = None
    end = 0
    reader = []
    for ts, ms, t in points('spike-postgres-1'):
        s = t.get('step')
        if s == 'pre':
            pre = ts if pre is None else min(pre, ts)
        elif s == 'spike':
            spk = ts if spk is None else min(spk, ts)
        elif s == 'recovery':
            rec = ts if rec is None else min(rec, ts)
        if t.get('journey') == 'reader' and s != 'warm':
            reader.append((ts, ms, s))
            end = max(end, ts)
    ref = [ms for ts, ms, s in reader if s == 'pre' and spk - REF_S <= ts < spk]
    ref_p95 = pct(ref, 0.95)
    bins = {}
    for ts, ms, s in reader:
        bins.setdefault((ts - rec) // WINDOW_S, []).append(ms)
    k_min = math.ceil((pre - rec) / WINDOW_S)
    k_max = (end + 1 - rec) // WINDOW_S - 1
    wins = {k * WINDOW_S: pct(bins[k], 0.95) for k in range(k_min, k_max + 1)
            if len(bins.get(k, [])) >= MIN_WINDOW_REQUESTS}
    limit = S8_FACTOR * ref_p95
    hit = None
    for k in range(0, S8_N_WINDOWS - S8_RUN + 1):
        run = [wins.get((k + i) * WINDOW_S) for i in range(S8_RUN)]
        if all(v is not None and v <= limit for v in run):
            hit = k * WINDOW_S
            break
    return {'ref': ref_p95, 'ref_n': len(ref), 'limit': limit, 'wins': wins, 'hit': hit,
            'x0': pre - rec, 'x_spike': spk - rec}


def close(got, want, tol):
    return abs(got - want) <= tol


def check(stress, soak, spike):
    bad = []
    for j in JOURNEYS:
        for s, got, want in zip(STEPS, stress[j], DOC_STRESS[j]):
            if fmt(got, 2) != want:
                bad.append('stress %s %s: file gives %s, doc has %s' % (j, s, fmt(got, 2), want))
    big = [v for v in soak if v > 100]
    rest = [v for v in soak if v <= 100]
    if len(soak) != DOC_SOAK_MINUTES:
        bad.append('soak: %d full minutes, doc has %d' % (len(soak), DOC_SOAK_MINUTES))
    if len(big) != 1 or not close(big[0], DOC_SOAK_OUTLIER, 1):
        bad.append('soak: minutes over 100 ms are %s, doc has one at %d ms' % ([round(v) for v in big], DOC_SOAK_OUTLIER))
    if not rest or not close(min(rest), DOC_SOAK_MIN, 1) or not close(max(rest), DOC_SOAK_MAX_OTHER, 1):
        bad.append('soak: other minutes run %.1f to %.1f ms, doc has %d to %d'
                   % (min(rest, default=0), max(rest, default=0), DOC_SOAK_MIN, DOC_SOAK_MAX_OTHER))
    if not close(spike['ref'], DOC_SPIKE_REF, 0.005):
        bad.append('spike: reference %.2f ms, doc %.2f ms' % (spike['ref'], DOC_SPIKE_REF))
    if not close(spike['limit'], DOC_SPIKE_THRESHOLD, 0.05):
        bad.append('spike: threshold %.2f ms, doc %.1f ms' % (spike['limit'], DOC_SPIKE_THRESHOLD))
    for off, want in DOC_SPIKE_WINDOWS.items():
        got = spike['wins'].get(off)
        if got is None or not close(got, want, 1):
            bad.append('spike: window +%d s is %s ms, doc %d ms' % (off, 'missing' if got is None else '%.1f' % got, want))
    if spike['hit'] != DOC_SPIKE_HIT:
        bad.append('spike: passing run starts at %s s, doc has +%d s' % (spike['hit'], DOC_SPIKE_HIT))
    return bad


def report(stress, soak, spike):
    print('STRESS p95 (ms), steps 1x, 1.5x, 2x, 3x')
    for j in JOURNEYS:
        print('  %-7s %s' % (j, '  '.join('%9.2f' % v for v in stress[j])))
    print('\nSOAK reader p95 per minute (ms), %d full minutes' % len(soak))
    print('  ' + ' '.join('%.0f' % v for v in soak))
    print('\nSPIKE reader p95 per 10 s window (ms); reference %.2f ms from %d requests, threshold %.2f ms; * = over'
          % (spike['ref'], spike['ref_n'], spike['limit']))
    print('  ' + '  '.join('%+d:%.0f%s' % (o, v, '*' if v > spike['limit'] else '') for o, v in sorted(spike['wins'].items())))
    print('  passing run of %d windows starts at +%s s' % (S8_RUN, spike['hit']))


# ---- drawing ----
INK, MUTED, GRID, BLUE = '#1f2328', '#59636e', '#e1e4e8', '#1f6fb5'
plt.rcParams.update({'svg.fonttype': 'path', 'svg.hashsalt': 'charts', 'font.family': 'sans-serif',
                     'font.sans-serif': ['Arial', 'DejaVu Sans'], 'font.size': 10, 'text.color': INK,
                     'axes.labelcolor': MUTED, 'xtick.color': MUTED, 'ytick.color': MUTED,
                     'axes.edgecolor': GRID, 'axes.facecolor': 'white', 'figure.facecolor': 'white'})


def fmt(ms, decimals=0):
    if ms >= 1000:
        return '%.2f s' % (ms / 1000) if decimals else '{:,.0f} ms'.format(ms)
    return ('%.2f ms' % ms) if decimals else '%.0f ms' % ms


def tidy(ax):
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    ax.grid(axis='y', color=GRID, lw=0.8, zorder=0)
    ax.set_axisbelow(True)


def log_axis(ax, lo, hi):
    ax.set_yscale('log')
    ax.set_ylim(lo, hi)
    ax.set_yticks([100, 1000, 10000])
    ax.set_yticklabels(['100 ms', '1 s', '10 s'])
    ax.minorticks_off()


def dot(ax, x, y, crossed):
    ax.plot(x, y, 'o', ms=8, mfc='white' if crossed else BLUE, mec=BLUE, mew=2, zorder=3)


def draw_stress(stress):
    fig, axes = plt.subplots(1, 3, figsize=(10, 4.6), sharey=True)
    fig.suptitle('Stress on Postgres: p95 per step against its threshold', x=0.01, ha='left', fontsize=12, fontweight='bold')
    panels = [('reader', 'Reader', S1_MS), ('heavy', 'Heavy reader', S2_MS), ('write', 'Write', S3_MS)]
    labels = ['1× T\n24/s', '1.5× T\n36/s', '2× T\n48/s', '3× T\n72/s']
    for ax, (j, title, thr) in zip(axes, panels):
        tidy(ax)
        log_axis(ax, 30, 30000)
        ax.plot(range(4), stress[j], color=BLUE, lw=2, zorder=2)
        ax.axhline(thr, ls='--', color=MUTED, lw=1.5, zorder=1)
        ax.text(-0.3, thr * 1.08, 'threshold %s ms' % '{:,}'.format(thr), color=MUTED, fontsize=9, va='bottom')
        for x, y in enumerate(stress[j]):
            dot(ax, x, y, y > thr)
            ax.annotate(fmt(y, 2), (x, y), xytext=(0, 10), textcoords='offset points', ha='center', fontsize=9)
        ax.set_xticks(range(4))
        ax.set_xticklabels(labels, fontsize=9)
        ax.set_xlim(-0.4, 3.4)
        ax.set_title(title, loc='left', fontsize=10.5)
    axes[0].set_ylabel('p95 response time (log scale)')
    fig.text(0.01, 0.01, 'Filled dot: inside the threshold. Hollow dot: crossed it. At 2× T and 3× T k6 dropped iterations, '
             'so the load delivered was below the target.', fontsize=8.5, color=MUTED)
    fig.tight_layout(rect=(0, 0.04, 1, 0.95))
    return fig


def draw_soak(soak):
    fig, ax = plt.subplots(figsize=(10, 4.2))
    fig.suptitle('Soak on Postgres: reader p95 per minute over the 30-minute hold', x=0.01, ha='left', fontsize=12, fontweight='bold')
    tidy(ax)
    xs = list(range(1, len(soak) + 1))
    ax.plot(xs, soak, color=BLUE, lw=2, marker='o', ms=6, zorder=3)
    ax.set_ylim(0, 200)
    top = max(range(len(soak)), key=lambda i: soak[i])
    ax.annotate(fmt(soak[top]), (xs[top], soak[top]), xytext=(0, 10), textcoords='offset points', ha='center', fontsize=9)
    ax.set_xlim(0.3, len(soak) + 0.7)
    ax.set_xlabel('Minute of the hold')
    ax.set_ylabel('Reader p95 (ms)')
    ax.text(0.99, 0.95, 'The S1 threshold of 500 ms is above this axis.', transform=ax.transAxes, ha='right', va='top',
            fontsize=9, color=MUTED)
    fig.tight_layout(rect=(0, 0, 1, 0.94))
    return fig


def draw_spike(spike):
    fig, ax = plt.subplots(figsize=(10, 4.8))
    fig.suptitle('Spike on Postgres: reader p95 per 10 s window', x=0.01, ha='left', fontsize=12, fontweight='bold')
    tidy(ax)
    log_axis(ax, 20, 6000)
    limit, wins = spike['limit'], spike['wins']
    xs = [o + WINDOW_S / 2 for o in sorted(wins)]
    ys = [wins[o] for o in sorted(wins)]
    x_end = xs[-1] + WINDOW_S / 2
    for a, b, name, shade in [(spike['x0'], spike['x_spike'], 'before the spike (T)', '#ffffff'),
                              (spike['x_spike'], 0, 'spike (2T)', '#f3f4f6'),
                              (0, x_end, 'recovery (T)', '#ffffff')]:
        ax.axvspan(a, b, color=shade, zorder=0)
        ax.text((a + b) / 2, 0.96, name, transform=ax.get_xaxis_transform(), ha='center', va='top', fontsize=9, color=MUTED)
    ax.axvline(0, color=GRID, lw=1)
    ax.plot(xs, ys, color=BLUE, lw=2, zorder=2)
    for x, y in zip(xs, ys):
        dot(ax, x, y, y > limit)
    ax.axhline(limit, ls='--', color=MUTED, lw=1.5, zorder=1)
    ax.text(spike['x0'] + 2, limit * 1.08, 'S8 threshold %.1f ms (2 × the %.2f ms before the spike)' % (limit, spike['ref']),
            color=MUTED, fontsize=9, va='bottom')
    place = {0: (26, 6), 80: (0, 10), 100: (0, 10), 130: (0, 10), 140: (0, -17), 160: (0, 10)}
    for off, (dx, dy) in place.items():
        ax.annotate(fmt(wins[off]), (off + WINDOW_S / 2, wins[off]), xytext=(dx, dy), textcoords='offset points',
                    ha='center', fontsize=9)
    hit = spike['hit']
    run = [hit + i * WINDOW_S for i in range(S8_RUN)]
    ax.annotate('S8 windows: ' + ', '.join('%.0f' % wins[o] for o in run) + ' ms',
                (run[1] + WINDOW_S / 2, wins[run[1]]), xytext=(30, -42), textcoords='offset points', fontsize=9,
                arrowprops={'arrowstyle': '-', 'color': MUTED, 'lw': 1})
    ax.set_xlim(spike['x0'], x_end)
    ax.set_xlabel('Seconds after the spike ended')
    ax.set_ylabel('Reader p95 (log scale)')
    fig.text(0.01, 0.01, 'Filled dot: inside the S8 threshold. Hollow dot: over it. Windows with fewer than 100 reader requests are left out.',
             fontsize=8.5, color=MUTED)
    fig.tight_layout(rect=(0, 0.04, 1, 0.94))
    return fig


def main():
    args = sys.argv[1:]
    png = args[args.index('--png') + 1] if '--png' in args else None
    stress, soak, spike = stress_values(), soak_minutes(), spike_windows()
    report(stress, soak, spike)
    bad = check(stress, soak, spike)
    if bad:
        print('\nCHECK FAILED, nothing drawn. These differ from docs/03-results.md:')
        for b in bad:
            print('  - ' + b)
        sys.exit(2)
    print('\nCHECK OK: every number above matches the numbers set in this script, which match docs/03-results.md')
    if '--check' in args:
        return
    os.makedirs(OUT, exist_ok=True)
    for name, fig in [('stress-p95', draw_stress(stress)), ('soak-reader-p95', draw_soak(soak)), ('spike-timeline', draw_spike(spike))]:
        fig.savefig(os.path.join(OUT, name + '.svg'), metadata={'Date': None})
        if png:
            os.makedirs(png, exist_ok=True)
            fig.savefig(os.path.join(png, name + '.png'), dpi=110)
        plt.close(fig)
        print('wrote docs/charts/%s.svg' % name)


if __name__ == '__main__':
    main()
