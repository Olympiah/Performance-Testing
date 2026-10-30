# Test Architecture: Strapi 5 with k6

How the test setup is built, in the order I built it, and why. The numbers from the runs are in the [results](03-results.md), the thresholds are in the [strategy](01-load-test-strategy.md) and the run method is in the [plan](02-load-test-plan.md).

## 1. Environment

Strapi 5.59.0 in production mode on a Windows laptop with 2 physical cores (4 logical processors), once on SQLite and once on Postgres 17.11. k6 v2.3.0 generates the load on the same machine. Node is 24.21.0.

- **Production mode.** The runs should behave like a deployed server. The cost is that login needs a proxy setting and an `X-Forwarded-Proto: https` header, or it returns 500. I confirmed that on both databases.
- **Native Postgres, not Docker.** Docker Desktop's virtual machine takes a large share of free memory. With Chrome closed, 2.53 GB was free, and Chrome costs about 1.2 GB. Running Postgres natively also lets me measure it by process ID, the same way as Strapi.
- **Default Postgres settings.** Memory settings and the connection pool are candidates for my one fix, so I did not tune them.
- **Strapi version.** I used the latest stable release when I started and pinned it exactly, with `overrides` for the internal `@strapi/*` packages, to avoid version drift. `@swc/core` is pinned to 1.16.2 because a newer one failed the admin build on this machine, and the `pg` driver is pinned because the app was created for SQLite.
- **Named start scripts.** `start-sqlite.sh` and `start-postgres.sh` set the database explicitly, so a wrong choice cannot quietly test the wrong database.
- **Telemetry off**, to keep background calls out of the runs.

## 2. Tokens and roles

One set of credentials per database: an admin, a login user and three API tokens, written to a git-ignored folder by `scripts/setup-tokens.js`.

| Token | Can do | Used by |
|---|---|---|
| Read-only | Read all content | Readers, and the writer's read-back |
| Writer | Create and update Articles, and `find` Authors and Categories | The writer scenario |
| Seed | Create and update Articles, Authors and Categories, `find` Authors and Categories, upload files | The data generator only |

- **Least privilege.** Strapi's built-in Full Access token can delete content, so I do not use it. The writer and seed tokens cannot delete, and the checks prove it with a 403.
- **Only tokens can read content.** The Public role has 8 login actions and the Authenticated role has 5, none on content.
- **Login is its own scenario.** Strapi allows 10 auth calls per minute per IP and all simulated users share one IP, so a login-heavy test would measure the rate limiter.
- **Why `find` on Author and Category.** The first generator trial failed with `400 Invalid key author`. Strapi rejects a relation key in a create request unless the token can also `find` the target type, and only `find` is checked. I added that and nothing else.
- **Re-runs keep old permissions.** A re-run of the setup only rotated the keys, so the script now updates the permissions first and prints each token's stored actions read back from the database.
- **Evidence.** 16 checks per database, all passing, with test records cleaned up afterwards. After the snapshot I never re-run the setup and never change `API_TOKEN_SALT`, because tokens are hashed with it.

## 3. Data generator

`scripts/generate-data.js` fills a running Strapi with 20 Authors, 10 Categories, 6 cover images and 2,000 Articles, writing with the seed token and reading with the read-only token.

- I seeded the data through Strapi's REST API, so it goes through the same routes and checks as real content and has the same shape the tests read.
- 300 of the 2,000 Articles (about 15%) are drafts, so list requests have to filter them and readers see only published Articles. The ratio is my choice, not measured from real data.
- **Exact spread.** A seeded shuffle gives exact counts: 300 short Articles (1 to 2 paragraphs), 1,660 typical (3 to 5) and 40 long (20 to 30), with a fixed seed so both databases get the same data. Author and category pairs are assigned so that all 200 pairs appear 10 times each.
- **Safe to re-run.** Everything is matched by name or slug, so a re-run skips what exists. A final check compares exact counts with the plan, so extra records fail the run.
- **Ids for k6.** Strapi makes different ids on each database, so the generator writes the published Article ids, Author ids and Category names to a git-ignored file that k6 reads.
- **Covers.** Six PNGs at 800×600, about 1.2 MB each, written with Node's built-in `zlib`. The API returns the cover's metadata, not the picture, and k6 never downloads the files.
- **Uploaded images are files** in `strapi-app/public/uploads`, not database rows, so a restore does not touch them and that folder must never be emptied.

## 4. Snapshots and reset

`scripts/reset-db.sh <sqlite|postgres> <save|restore>`. SQLite is a file copy checked by SHA-256. Postgres is `pg_dump` and `pg_restore` in one transaction. It refuses to run while Strapi is up, refuses a snapshot path that is not git-ignored, never overwrites a snapshot, and never puts the Postgres password on a command line.

The writer adds published Articles, so a compared run that started from another run's leftovers would be unfair. A plain re-run of the generator after a restore would pass even if the restore did nothing, so I proved the restore differently: save, add one extra Article, show that the generator fails (2,001 and 1,701 instead of 2,000 and 1,700), restore, then show that it passes with nothing created. I did this on both databases.

## 5. Scenarios

Three journeys and a login scenario. The 80/10/10 split is my own, stated up front, not measured from real traffic. The mix puts slightly more weight on writes, which suits the SQLite write-lock risk (P3 in the risk map in the strategy).

- **Reader (80%).** A list of 25 Articles, one Article with its author, category and cover, then the Categories.
- **Heavy reader (10%).** A deep populate, a filter on the category name, a sort and a page size of 100.
- **Writer (10%).** Create an Article, update it, read it back with the read-only token. The read-back is tagged `readback`: it is left out of S1 and S3 but counted in S4, the check pass rate and throughput, so a failing read-back cannot go unnoticed.
- **Login.** About 5 per minute on its own, under the limit of 10 per minute.
- **Same requests every run.** Picks use the iteration number, not a random draw, and ids come from the data file. A rerun on unrestored data fails with 400 on purpose.
- **Checks look at the body.** The list checks require the exact item count (25, 10, 100). The heavy reader checks status, a body over 10,000 bytes and the echoed page size instead of parsing the JSON, to save k6 CPU. That is weaker, and the code says so.
- **Arrival rate.** Load, stress and spike start a fixed number of journeys per second whatever the server does. A fixed number of users would send fewer requests when the server slows and hide overload. Users pause 1 to 3 seconds between steps, which does not change request durations.

## 6. Measurement and judging

- **Sampler.** Every 5 seconds it records CPU and memory of Strapi (found by the process listening on port 1337, 100% being one logical processor), k6 and Postgres (all its processes added together), and CPU speed. S7 is judged on Strapi's private memory, because the working set shrinks when the process is idle.
- **Watchdog.** It stops k6 if free memory falls below 800 MB or the sampler file goes stale.
- **Judging.** S1 to S5 are k6 thresholds. `scripts/judge-runs.js` judges S6 to S8, reports p99 for the spike and soak, flags dropped iterations, and checks CPU speed. The windows and thresholds are constants at the top of the script, and "not evaluable" is reported with its reason.
- **Honesty rule.** If a real result differs from what I expected, I tell the story as it happened and do not change the expectation afterwards.
