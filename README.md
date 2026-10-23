# Load and performance testing of Strapi 5 with k6

I'm load testing a Strapi 5 content API with k6, to find out what it can carry, what gives out first and why. The strategy is in [docs/01-load-test-strategy.md](docs/01-load-test-strategy.md) and the plan is in [docs/02-load-test-plan.md](docs/02-load-test-plan.md).

## What you need

- Windows 10 and Git Bash. I wrote every command for Git Bash.
- Node 24.21.0, set in `.nvmrc` (I use nvm-windows).
- Python, because Strapi's documentation says SQLite needs it. I have it installed.
- For the Postgres runs: PostgreSQL 17.11, described below.

## Set up Strapi on SQLite

1. Install the packages: `cd strapi-app && npm install`.
   - npm 11 skips install scripts until they are allowed. `allowScripts` in `package.json` allows the ones Strapi needs (`better-sqlite3`, both `esbuild` versions and `@swc/core`) and denies `core-js-pure`, whose script only prints a funding message.
2. Create `strapi-app/.env` from `.env.example` and fill in the values:
   - Generate random secrets for `APP_KEYS` (a comma-separated list of keys), `API_TOKEN_SALT`, `ADMIN_JWT_SECRET`, `JWT_SECRET`, `TRANSFER_TOKEN_SALT` and `ENCRYPTION_KEY`, for example with `node -e "console.log(require('crypto').randomBytes(16).toString('base64'))"`.
   - Set `DATABASE_FILENAME=.tmp/data.db`. It must be set explicitly, because an empty value counts as set and breaks the SQLite path.
   - Set `STRAPI_TELEMETRY_DISABLED=true`. This is deliberate: it keeps Strapi's anonymous telemetry calls out of the load test runs.
3. Build the admin panel: `npm run build`. It took about two minutes for me.
4. Start it with `scripts/start-sqlite.sh`. The script creates the `.tmp` folder, which is git-ignored and which SQLite will not create itself. Check `curl -i http://localhost:1337/_health`: it should return HTTP 204. Stop with Ctrl+C.

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

## Choices and things I ran into

- **`@swc/core` is pinned to 1.16.2.** With 1.16.20 the admin build failed with "Failed to load native binding". The cause is that `C:\` grants replacement rights to the Authenticated Users group by default on Windows, which that version's cache-folder check rejects. I hit the same problem in my first project. With 1.16.2 the build passes.
- **`overrides` pin seven internal `@strapi/*` packages to 5.59.0.** This is a precaution from my first project, where a plain `npm install` drifted some of them to a newer version and crashed the admin panel. On 5.59.0 they all installed at 5.59.0 anyway, so some entries may not be needed.
- **`pg` is pinned to 8.23.1.** The app was created for SQLite, so the Postgres driver is not installed by default.
- **Don't change `API_TOKEN_SALT` after creating tokens.** The token keys are hashed with it, so a new value makes every token invalid, and `scripts/setup-tokens.js` has to be run again.
- **Don't re-run `scripts/setup-tokens.js` after taking the reset snapshot.** A re-run rotates the token keys and the login user's password, so a restored snapshot would no longer match the files in `.generated/`. If you re-run it, take a new snapshot.
- **Production mode and login.** The refresh cookie is Secure, so login over plain HTTP returns a 500. `config/server.ts` sets `proxy: { koa: true }`, so the load test can log in over HTTP with an `X-Forwarded-Proto: https` header. I have not tested login yet. The smoke run checks it. API tokens use no cookies and aren't affected.
- **`npm audit` reports 39 vulnerabilities** (5 moderate, 31 high, 3 critical) in Strapi's own dependencies, as of the day I installed. I did not run `npm audit fix`, because it would change the pinned versions. This is a local test app that isn't exposed to a network.

## Honest limits

The load generator, Strapi and the database share one laptop with 2 physical cores and 8 GB of RAM, so I only trust relative results. The strategy has the details.

## A possible next step

Re-run the same tests on a newer Strapi version to see whether it is faster or slower. I'm not doing this in the first round.
