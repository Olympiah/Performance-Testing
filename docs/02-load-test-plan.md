# Load Test Plan: Strapi 5 with k6

This plan explains how I run the load tests described in my strategy ([01-load-test-strategy.md](01-load-test-strategy.md)): what the simulated users do, how I size the load, which runs I make, what data I use, what I measure, and when. The strategy covers why the limits exist. This plan covers how I check them.

## Objective

Find out how a typical Strapi 5 content API behaves under load on a 2-core laptop: what load it carries inside my limits (S1–S8), what gives out first, and what changes when I fix that one thing. Compare SQLite and Postgres on the same data and workload.

## Scope

**Test items**

- **Application:** Strapi 5, one pinned version, in production mode (`NODE_ENV=production`), run directly on Windows.
- **Databases:** SQLite and Postgres.
- **Endpoints:**
  - `GET /api/articles` (list), `GET /api/articles/:documentId` (with relations)
  - `GET /api/categories`, `GET /api/authors`
  - `POST /api/articles`, `PUT /api/articles/:documentId`
  - `POST /api/auth/local`

**Exclusions** are the ones in the strategy: admin panel UI, GraphQL, security and functional correctness, the upload scenario (deferred), distributed or cloud-scale load, browser performance, and capacity numbers for any real production system.

## Which question each run answers

| # | Question | Answered by |
|---|---|---|
| 1 | What is a sensible target load? | Calibration, which gives the ceiling C and the target load T |
| 2 | What load, in journeys per second, can it carry inside my limits? | Load and stress runs, judged by S1–S5 |
| 3 | What gives out first? | Stress run plus CPU, memory and database numbers (S6, P1–P4) |
| 4 | What changes when I fix that one thing? | The one fix: three runs before, three after |
| 5 | SQLite vs Postgres? | The SQLite and Postgres load runs |
| 6 | How quickly does it recover after a spike? | Spike run, S8 |
| 7 | Does it slow down or leak over a longer run? | Soak run, S7 |
| 8 | Same behaviour with twice the data? | Double-data run (only if time allows) |

## Environment

| Item | Details |
|---|---|
| Machine | Windows 10, 2 physical cores (4 logical), 7.88 GB usable RAM (about 3.8 GB free with only VS Code open) |
| Strapi | One pinned 5.x version, recorded in the README. Run directly on Windows in production mode. |
| Node | The version pinned in `.nvmrc` |
| k6 | Run directly on Windows, on the same machine |
| Postgres | Native on Windows, from the official ZIP archive, in a folder outside the repo. Started by hand for test sessions, default settings, version recorded. I check memory use on Day 1 before relying on it. |
| Base URL | `http://127.0.0.1:1337/api` |
| Credentials | Read from `.env` (git-ignored), including the Postgres user and password. `.env.example` lists names only. |

**Before every run:** charger plugged in, best-performance power mode, sleep off, Chrome and other apps closed. CPU speed is recorded during the run.

**Production mode and login:** in production mode the refresh cookie is Secure, so login over plain HTTP returns a 500. The workaround is the proxy setting (`server.proxy.koa: true`) plus an `X-Forwarded-Proto: https` header on the login request. API tokens use no cookies, so only login is affected.

## Workload

The percentages are invented, but explicit.

| Share | Journey | Requests |
|---|---|---|
| 80% | Reader | List Articles (page size 25), one Article by `documentId` with author, category and cover, then Categories |
| 10% | Heavy reader | Articles with deep populate, a filter on the category name, a sort, page size near the cap of 100 |
| 10% | Writer | Create an Article, update it, read it back |
| separate | Login | Its own scenario at a fixed low rate (about 5 per minute) |

- Each simulated user pauses 1–3 seconds between steps.
- Readers use a read-only API token. Writers use a custom token that can create and update Articles and read (`find`) Authors and Categories, never a full-access token. Strapi rejects an Article that links an Author or Category unless the token can also `find` that type, so the writer needs it to create Articles shaped like the seeded ones. It still cannot delete Articles or list them.
- Login is not in the mixed workload. Strapi limits auth routes to 10 calls per 60 seconds per IP, and all virtual users share one IP, so a login-heavy test would measure the rate limiter, not capacity. The default limit was seen on Strapi 5.54.0 in my first project, and I re-check it on the pinned version.
- Access tokens last 10 minutes, so runs longer than that use API tokens only.
- Create and update publish by default. The writer therefore adds published Articles, which is why the database is reset between compared runs.
- The ids readers request come from the deterministic data set, so every run asks for the same things. The generator saves them in `.generated/data-<database>.json`, because Strapi makes different ids on each database.

## Test types and sizing

I don't guess rates. I measure the ceiling first, then size everything from it.

| Step | What | Why |
|---|---|---|
| Idle baseline | Record CPU and memory of Strapi and Postgres for 1 minute before any load | Gives every later number something to compare against |
| Smoke | 1 user, 30 s | Do the scripts and the environment work? The read-only and writer API tokens work in production mode, and login works with the workaround. |
| Calibration | On SQLite, production mode: raise the arrival rate (journeys per second) in steps until read p95 breaks 500 ms. The ceiling C is stated as a range, between the last step that held and the first that broke. | Sizes everything else for this laptop |
| Baseline | Low steady load of 6 journeys/s (T/4): 30 s warm-up, then a 5-minute hold | What "unloaded" looks like, and where S2 gets its number |
| Load | Target load T (half of the lower end of C): warm-up, then hold 10 min | Do I meet S1–S7 at expected load? |
| Stress | Steps at 1×, 1.5×, 2× and 3× T, 3 min each, each step its own tagged scenario | Where do the limits break, and which breaks first? Each step gets its own p95. |
| Spike | Jump from T to 2T in 10 s, hold 2 min, drop back to T and watch the recovery | Does it recover, and how fast (S8)? |
| Soak | T for about 30 min, run once | Slow leaks (S7)? |
| Double data | Repeat the load run with about 4,000 Articles. Only if time allows. | Same behaviour with twice the data? |

- **Target load T** is set once from the SQLite ceiling and reused on Postgres, so the comparison is fair. I also record the Postgres ceiling as information only. If a Postgres stress step breaks nothing, I add higher steps.
- The stress and spike multiples are a starting proposal. I adjust them after calibration and say so in the results.
- **Arrival rate:** load, stress and spike use a fixed arrival rate, in journeys per second (a reader or writer journey is 3 requests). Smoke and baseline can use fixed virtual users.
- **Warm-up:** every run starts with a short warm-up, excluded from the thresholds by tagging it as its own phase.
- **Dropped iterations:** I watch k6's dropped-iterations count. If it rises, k6 was the limit and not Strapi, and that run's numbers are flagged.
- **Where each run happens:** SQLite covers calibration, the write-lock check (P3) and the contrast. Postgres covers stress, spike, soak and the one fix. If Postgres doesn't fit in memory, this changes and I say so.

## Repeats

I repeat only the runs I compare three times and report the median and the spread: load on SQLite, load on Postgres, and the before and after of my one fix. Smoke, baseline, spike and soak run once, because I don't use them for comparisons. Calibration also runs once, but I re-check the ceiling on the first load run.

To keep compared runs comparable:

- One change at a time.
- The same data, restored before each run.
- The same warm-up.
- The same machine state (see Environment).

## Test data

A generator script creates, through the API:

- 2,000 Articles: 1,700 published and 300 drafts
- 20 Authors
- 10 Categories
- 6 cover images

It uses a fixed seed, so every run starts from identical data, and it can be re-run safely. Between compared runs I reset the database: I copy a saved file on SQLite and restore a dump (`pg_dump` and `pg_restore`) on Postgres. The uploaded images are files in `strapi-app/public/uploads`, not rows in the database, so a reset does not touch them and that folder must never be emptied.

**Content:** Article content is Blocks (Strapi's rich-text format), so the generator writes paragraphs. The text is made-up filler picked from a fixed word list with the seeded random generator, so nothing is copied from anywhere. A paragraph is 3 to 6 sentences of 6 to 14 words, about 50 words. The spread is exact, because a seeded shuffle assigns it: 300 short Articles (1–2 paragraphs), 1,660 typical (3–5) and 40 long (20–30). A separate shuffle picks the 300 drafts. Each Article links to one Author and one Category, assigned so that all 200 Author and Category pairs appear 10 times each.

**Cover images:** generated by the script, not downloaded: 6 PNG files at 800×600, each about 1.2 MB (1,191 to 1,229 KB measured). Every Article uses one, so each is shared by about 333 Articles. Strapi also makes thumbnail, small and medium copies on upload. The API returns the cover's metadata and not the picture, and k6 never downloads the files, so the file size does not change the cost of a request.

**Content model:** the three content types (`Article`, `Author`, `Category`) are recreated from the schema files of my first project. I copy only those three schema files, after checking that they contain just the model.

| Content type | Fields | Draft & Publish |
|---|---|---|
| `Article` | `title`, `slug`, `content`, `cover` (Media), `author` (many-to-one), `category` (many-to-one) | On |
| `Author` | `name`, `email`, `bio` | Off |
| `Category` | `name`, `slug` | Off |

**Configuration:** `rest.defaultLimit` is 25 and `maxLimit` is 100, the values I saw in my first project. Requests for a larger page size are capped to 100, so "page size near 100" means 100. I re-check these on the pinned version.

## Limits and pass/fail

The limits S1–S8 and their reasons are in the strategy. A run passes only if every limit that applies to it holds.

- **S1–S5** are k6 thresholds, filtered by tag (read, heavy read, write), so the run itself exits with a failure when one breaks.
- **S6–S8** are judged after the run by a script, from the stats CSV and the p95 time series.
- **S2** gets its limit after the baseline run (10× the baseline heavy p95, rounded up to the next 50 ms). **S8**'s N is fixed before the spike run.
- A broken limit is a finding, not an error. Whether to keep going to find the breaking point is decided by the stress profile, which always runs all its steps.

## Monitoring

| What | How |
|---|---|
| Response times, failures, throughput, check pass rate, dropped iterations | k6: p50, p95 and p99, `http_req_failed`, requests per second, `check()` rate. Output is k6's built-in web dashboard and HTML report. [verify against the installed version] |
| CPU and memory of Strapi, k6 and Postgres | A stats script samples every 5 seconds into a CSV. Strapi is found by the process listening on port 1337, k6 and Postgres by process name (Postgres is the sum of its processes). Memory is recorded as working set and as private memory, and S7 is judged on Strapi's private memory. S6's method is in the strategy. |
| CPU speed | Sampled with the same script, so thermal throttling shows in the report |
| Postgres | Active connections from `pg_stat_activity`. Slow queries from `pg_stat_statements` if it is enabled. |

Grafana is a stretch goal and will probably be skipped for lack of RAM. Before building it I would check which k6 output is currently supported and lightest.

## Finding and fixing one bottleneck

1. Run stress and note the first limit that breaks.
2. Read the machine and database numbers and form a hypothesis. Candidates: one core maxed out, the connection pool, heavy populate, SQLite write locks.
3. Change one thing.
4. Re-run with the same data and profile, three times.
5. Write down the change, the evidence and the outcome, even if it didn't help. Finding no bottleneck is still an honest result.

Postgres runs with its default settings. Memory settings and the connection pool are candidates for the one fix, so I don't tune them up front.

## SQLite vs Postgres

The same data, workload and profile on both, SQLite first. I label the contrast carefully. SQLite is a single file with one writer, so on SQLite I'm largely measuring SQLite. Postgres is a separate server process on the same machine, so the difference also includes that process and the localhost connection.

## CI

On push, a smoke run only: 1 user, 30 seconds, against SQLite with a tiny seed and loose thresholds. It checks that the scripts parse, both tokens work and the API answers. Full runs stay manual because shared CI runners are too noisy for meaningful numbers. The workflow creates its own throwaway tokens. I don't claim CI works until there is a real green run. The functional CI in my first project took 5m47s, so I expect a similar Strapi startup cost.

## Credentials

No credentials are committed. They live in `.env`, which is git-ignored, and `.env.example` lists names only. Generated token files stay inside the repo and are git-ignored.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Little free RAM (about 3.8 GB): Strapi, k6 and Postgres together may swap | Native Postgres with default settings, started only for tests. Skip Grafana until the core is done. Keep rates modest. Check memory before each session. |
| Load generator and Strapi share the CPU | State it in the report and trust relative results only |
| Noisy results | Repeat compared runs three times and report the spread. Close other apps. |
| Login rate limit pollutes results | API tokens for load. Login is a separate, slow scenario. |
| Strapi version drift | Pin `@strapi/*` with `overrides` in `package.json` |
| Admin build takes about 2 minutes | Build once, reuse the build |
| Postgres settings change the result | Defaults only, recorded. A setting changes only as the one fix. |
| Real behaviour differs from what I expected | I tell the story as it happened and never change an expected result quietly |
| No real bottleneck found | Still a valid, honest result |

## Test schedule

| Day | Work |
|---|---|
| 1 | Plan approved, repo skeleton, pinned Strapi on SQLite, Postgres set up and memory checked |
| 2 | Data generator, auth, reader and writer scenarios, smoke, idle baseline |
| 3 | Calibration, baseline, load runs on SQLite |
| 4 | Load on Postgres, stress, spike |
| 5 | One fix and re-measure, soak |
| 6 | Report, README and CI smoke first. Double-data run last, only if time allows and the machine is free. |

One week at most. The days are a guide. If something slips, the double-data run is the first to drop, and the results doc says so.

## Repository layout

```
docs/               strategy, plan, results
k6/
  scenarios/        reader.js, heavy-reader.js, writer.js, login.js
  profiles/         smoke.js, calibration.js, baseline.js, load.js, stress.js, spike.js, soak.js
  lib/              config.js, auth.js, checks.js, data.js
strapi-app/         the pinned app (three schema files from my first project)
scripts/            setup-tokens.js, generate-data.js, sample-stats.js, reset-db.sh
results/            raw output (git-ignored)
.github/workflows/  smoke.yml
```

The Postgres folder lives outside the repo, so nothing from it can be committed. Summaries and graphs are copied from `results/` into `docs/03-results.md`.

## Deliverables

| Deliverable | Location |
|---|---|
| Strategy | `docs/01-load-test-strategy.md` |
| Plan | `docs/02-load-test-plan.md` |
| Results | `docs/03-results.md` |
| k6 scenarios and profiles | `k6/` |
| Data generator, stats sampler, token setup | `scripts/` |
| CI smoke workflow | `.github/workflows/smoke.yml` |
| README | `README.md` |

## Entry and exit criteria

- **Entry for the first full run:** Strapi starts in production mode, the data is loaded, both tokens work, login works with the workaround, and smoke passes.
- **Suspension:** if Strapi won't start, a token fails, or the machine is swapping, I pause, because the numbers would measure the environment. I resume once it is fixed and re-run anything affected.
- **Exit:** every planned run is done or marked as skipped with the reason. Each of S1–S8 has a verdict, the bottleneck story is written, and the results doc says what I did not test.
