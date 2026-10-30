# Load and performance testing of Strapi 5 with k6

I load tested a Strapi 5 content API with k6, on SQLite and on Postgres, to find out what it can carry, what gives out first and why. The strategy is in [docs/01-load-test-strategy.md](docs/01-load-test-strategy.md), the plan is in [docs/02-load-test-plan.md](docs/02-load-test-plan.md) and the results are in [docs/03-results.md](docs/03-results.md).

## What I found

- With 2,000 Articles, my target load of 24 journeys per second (a journey is a short run of requests) stayed inside my latency, failure and CPU limits on both databases.
- On SQLite the ceiling was between 48 and 56 journeys per second. On Postgres the first limit to break was Strapi's CPU, at 36 journeys per second (1.5 times the target load), and the latency limits broke at 48.
- The first three Postgres runs at the target load were slower than every later run at the same rate, and I could not explain why. The results document lists that and the other open questions.

## What is in the repo

```
docs/               strategy, plan, results
k6/
  lib/              config, auth, checks, data, arrival helpers
  scenarios/        reader, heavy-reader, writer, login
  profiles/         smoke, calibration, calibration-high, baseline, load, stress, spike, soak
scripts/            setup-tokens, check-tokens, generate-data, reset-db, start-sqlite, start-postgres,
                    sample-stats, watch-free-memory, judge-runs
strapi-app/         the Strapi 5 app (three content types: Article, Author, Category)
results/            raw test output (git-ignored)
.generated/         tokens, ids and database snapshots (git-ignored)
```

## What you need

- Windows and Git Bash. I wrote every command for Git Bash and ran everything on Windows only. The sampler, the reset script and the Postgres start script use Windows tools and paths, so they would need changes on another system. The k6 profiles are plain k6, but I did not run them elsewhere.
- Node 24.21.0, set in `.nvmrc` (I use nvm-windows).
- Python, because Strapi's documentation says SQLite needs it. I have it installed.
- k6 v2.3.0. If plain `k6` is not on your PATH, the full path is `C:\Program Files\k6\k6.exe`.
- For the Postgres runs: PostgreSQL 17.11, described below.

## Set up Strapi on SQLite

1. Install the packages: `cd strapi-app && npm install`.
   - npm 11 skips install scripts until they are allowed. `allowScripts` in `package.json` allows the ones Strapi needs (`better-sqlite3`, both `esbuild` versions and `@swc/core`) and denies `core-js-pure`, whose script only prints a funding message.
2. Create `strapi-app/.env` from `.env.example` and fill in the values:
   - Generate random secrets for `APP_KEYS` (a comma-separated list of keys), `API_TOKEN_SALT`, `ADMIN_JWT_SECRET`, `JWT_SECRET`, `TRANSFER_TOKEN_SALT` and `ENCRYPTION_KEY`, for example with `node -e "console.log(require('crypto').randomBytes(16).toString('base64'))"`.
   - Set `DATABASE_FILENAME=.tmp/data.db`. It must be set explicitly, because an empty value counts as set and breaks the SQLite path.
   - Set `STRAPI_TELEMETRY_DISABLED=true`. This is deliberate: it keeps Strapi's anonymous telemetry calls out of the load test runs.
3. Build the admin panel: `npm run build`. It took about two minutes for me.
4. Start it with `scripts/start-sqlite.sh`. The script creates the `.tmp` folder, which is git-ignored and which SQLite will not create itself. Check `curl -i http://127.0.0.1:1337/_health`: it should return HTTP 204. Stop with Ctrl+C.

## Set up Postgres

I run Postgres natively from the official ZIP archive, not Docker, because Docker Desktop's virtual machine takes a large share of this machine's memory. I use the default settings, and I don't tune them, because memory settings and the connection pool are candidates for the one change I plan to make and measure.

1. On the official PostgreSQL download page for Windows, follow the "zip archive" link (it goes to EDB's binaries page). Download version 17.11, Windows x86-64, and extract it to `C:\pg_perf`, outside the repo.
2. Put a password for the `postgres` superuser in a file outside the repo, for example `C:\pg_perf\superuser.pw`. Don't type passwords into commands.
3. Initialize: `C:\pg_perf\pgsql\bin\initdb.exe -D C:\pg_perf\data -U postgres -A scram-sha-256 --pwfile=C:\pg_perf\superuser.pw -E UTF8`.
4. Start: `C:\pg_perf\pgsql\bin\pg_ctl.exe -D C:\pg_perf\data -l C:\pg_perf\postgres.log start`. Stop with the same command ending in `stop`.
5. Create a `strapi` user and a `strapi` database owned by it, with UTF8 encoding, using `psql.exe` from the same `bin` folder. Put the user's password only in `strapi-app/.env`.
6. Set `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, `DATABASE_USERNAME` and `DATABASE_PASSWORD` in `.env`. Leave `DATABASE_CLIENT=sqlite`.
7. With Postgres running, start Strapi with `scripts/start-postgres.sh`. The startup banner should say `Database postgres`.

The two start scripts exist so I can't test the wrong database by mistake. Each one sets the database for that run and prints which one it chose.

## Tokens, data and snapshots

Do this once per database, with `<db>` being `sqlite` or `postgres`. SQLite and Postgres are separate databases, so each has its own admin, login user and tokens. The files go to `.generated/`, which is git-ignored, and no script prints a secret.

1. With Strapi stopped: `NODE_ENV=production DATABASE_CLIENT=<db> node scripts/setup-tokens.js`. It creates the admin, a login user and three API tokens (read-only, writer and seed).
2. Start Strapi with the start script for the database and run `node scripts/check-tokens.js <db>`. Stop Strapi, then clean up the test records the checks leave behind: `NODE_ENV=production DATABASE_CLIENT=<db> node scripts/check-tokens.js <db> --cleanup`.
3. Start Strapi again and run `node scripts/generate-data.js <db>`. It creates 2,000 Articles (1,700 published, 300 drafts), 20 Authors, 10 Categories and 6 cover images, and writes the ids k6 reads. It is safe to re-run, and `--limit 20` makes a small trial. Stop Strapi.
4. Take the snapshot: `bash scripts/reset-db.sh <db> save`.

The order matters: setup, then the generator, then the snapshot.

## Reproduce a run

Every k6 profile needs `-e DB=sqlite` or `-e DB=postgres`. There is no default, so a run cannot test the wrong database by mistake.

| Profile | What it does |
|---|---|
| `smoke.js` | One user at a time for about 35 s. Checks that the scripts, tokens and login work. |
| `calibration.js`, `calibration-high.js` | Two ladders of rising load on SQLite, to find the ceiling C. |
| `baseline.js` | 6 journeys per second after a warm-up. Sets the heavy reader's limit S2. |
| `load.js` | The target load of 24 journeys per second: a 60 s warm-up, then a 10-minute hold. |
| `stress.js` | Steps at 1×, 1.5×, 2× and 3× the target load, 3 minutes each. |
| `spike.js` | A jump from the target load to twice that. Needs `--out csv=results/<name>-points.csv`. |
| `soak.js` | A 30-minute hold at the target load. Run with `--out csv=results/<name>-points.csv`. |

1. With Strapi stopped, restore the snapshot: `bash scripts/reset-db.sh <db> restore`.
2. Start Postgres by hand if you use it, then start Strapi with the start script. Run `node scripts/generate-data.js <db>`: it must say that it created 0 Articles and show 2000, 1700 and 300. Never run it between a run and the restore, because it rewrites the ids file.
3. Check the machine: Chrome and other apps closed, charger in, best-performance power mode, sleep off, and about 2.5 GB of free memory.
4. Count the Articles with a read-only query: SQLite opened read-only, or `psql` for Postgres.
5. Run, in Git Bash from the repo root. The sampler length is the run length plus about 60 s (780 for `load.js`, 1980 for `soak.js`):

   ```
   node scripts/sample-stats.js results/<name>.csv --seconds <seconds> &
   sleep 3
   node scripts/watch-free-memory.js results/<name>.csv &
   sleep 12
   "/c/Program Files/k6/k6.exe" run --quiet -e DB=<db> --summary-export results/<name>-summary.json k6/profiles/<profile>.js 2>&1 | tee results/<name>-output.txt
   wait
   ```

   The sampler writes Strapi, k6 and Postgres CPU and memory every 5 seconds. The watchdog stops k6 if free memory falls below 800 MB. Never use `--http-debug`, because it prints the Authorization header.
6. Count the Articles again, then stop Strapi and restore the snapshot before the next run.
7. Judge the run with `node scripts/judge-runs.js`. It reads `results/` and prints the verdicts for S6 to S8, p99 for the spike and soak, dropped iterations and a CPU speed check. It writes nothing. The runs it reads are listed at the top of the script.

S1 to S5 are k6 thresholds, so k6 itself fails the run when one of them breaks.

## Choices and things I ran into

- **`@swc/core` is pinned to 1.16.2.** With 1.16.20 the admin build failed with "Failed to load native binding". The cause is that `C:\` grants replacement rights to the Authenticated Users group by default on Windows, which that version's cache-folder check rejects. I hit the same problem in my first project. With 1.16.2 the build passes.
- **`overrides` pin seven internal `@strapi/*` packages to 5.59.0.** This is a precaution from my first project, where a plain `npm install` drifted some of them to a newer version and crashed the admin panel. On 5.59.0 they all installed at 5.59.0 anyway, so some entries may not be needed.
- **`pg` is pinned to 8.23.1.** The app was created for SQLite, so the Postgres driver is not installed by default.
- **Don't change `API_TOKEN_SALT` after creating tokens.** The token keys are hashed with it, so a new value makes every token invalid, and `scripts/setup-tokens.js` has to be run again.
- **Don't re-run `scripts/setup-tokens.js` after taking the reset snapshot.** A re-run rotates the token keys and the login user's password, so a restored snapshot would no longer match the files in `.generated/`. If you re-run it, take a new snapshot.
- **Don't empty `strapi-app/public/uploads`.** The cover images are files in that folder, not rows in the database, so restoring the reset snapshot does not bring them back. Without them every Article's cover would point at a missing file.
- **Production mode and login.** The refresh cookie is Secure. Without the `X-Forwarded-Proto: https` header, login over plain HTTP returned 500 on my setup, on both SQLite and Postgres. `config/server.ts` sets `proxy: { koa: true }`, so sending that header makes login work. API tokens use no cookies and aren't affected.
- **`npm audit` reports 39 vulnerabilities** (5 moderate, 31 high, 3 critical) in Strapi's own dependencies, as of the day I installed. I did not run `npm audit fix`, because it would change the pinned versions. This is a local test app that isn't exposed to a network.

## Honest limits

The load generator, Strapi and the database share one laptop with 2 physical cores and 8 GB of RAM, so I only trust relative results. Stress, spike and soak ran once each, on Postgres only. The results document has the details and what I did not test.

## A possible next step

Re-run the same tests on a newer Strapi version to see whether it is faster or slower.
