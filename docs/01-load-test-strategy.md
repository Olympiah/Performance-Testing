# Load Test Strategy: Strapi 5 with k6

This strategy explains what I want to learn from load testing a Strapi 5 REST API, which limits I judge it against, and why those limits exist. It starts from a risk map, because the limits come out of the risks. The workload, load profiles, sizing, data and schedule are in the test plan ([02-load-test-plan.md](02-load-test-plan.md)).

## Terms

- **VU (virtual user):** one simulated person running a script in a loop.
- **Throughput:** requests per second (RPS).
- **p95:** the response time that 95 out of 100 requests beat. p99 is the same for 99 out of 100.
- **SLO (service level objective):** a limit I set up front, such as "read p95 under 500 ms".
- **Threshold:** an SLO written into the k6 script, so the run fails by itself when the limit is broken.
- **Target load (T):** the request rate I treat as normal use. The test plan explains how I set it.
- **Arrival rate:** a test that sends a fixed number of new requests per second, whatever the server does. With a fixed number of VUs, a slow server makes each user send fewer requests, which hides overload.
- **Dropped iterations:** requests k6 wanted to start but couldn't. If this number rises, k6 was the limit, not Strapi.
- **Warm-up:** the first minute of a run, excluded from the limits, so cold caches don't count.
- **Soak:** a long steady run that looks for slow leaks.
- **Bottleneck:** the single slowest part that limits everything else.

## What I want to find out

1. What is a sensible target load for this setup?
2. What request rate can it carry while staying inside my limits?
3. What gives out first: CPU, memory, the database or one slow query?
4. What changes when I fix that one thing?
5. How does SQLite compare with Postgres on the same data and workload?
6. After a sudden spike, how quickly does it recover?
7. Over a longer run, does it slow down or leak memory?
8. Does it behave the same with twice the data? (Only if time allows.)

No one gave me real requirements. The limits below are targets I chose myself, and I explain each one.

## Scope

**In scope:**
- Reading Articles (list, by id, with relations), Categories and Authors.
- Creating and updating Articles with an API token.
- Login as its own small scenario.
- Strapi in production mode, on SQLite and on Postgres.

**Out of scope:**
- Admin panel UI.
- GraphQL.
- Security and functional correctness, which my first project covers.
- The upload scenario, which is deferred.
- Cloud-scale or distributed load.
- Browser performance.
- Capacity numbers for any real production system.

## Environment and honest limits

- **Machine:** Windows 10, 2 physical cores (4 logical processors), 7.88 GB usable RAM. About 4.1 GB is already in use with only VS Code open, which leaves roughly 3.8 GB for the test. The load generator, Strapi and the database share those cores and that memory.
- **Consequence:** I only trust relative results: SQLite vs Postgres, before vs after a fix, read vs write. Absolute numbers will not match a real server.
- **Repeats:** I repeat the runs I compare three times and report the median and the spread. Those are load on SQLite, load on Postgres, and before and after my one fix. Smoke, baseline, spike and soak run once, because I don't use them for comparisons.
- **Strapi:** the latest stable release when I start, pinned exactly and recorded. Node is pinned in `.nvmrc`.
- **Postgres:** native on Windows, from the official ZIP archive, kept outside the repo and started by hand only for test sessions. I chose this over Docker because Docker Desktop's virtual machine takes a large share of a small amount of free memory. It also lets me measure Postgres by process ID, the same way as Strapi. Settings stay at their defaults, and I record the version.
- **Every run:** charger plugged in, best-performance power mode, sleep off, Chrome and other apps closed. I record CPU speed during long runs, so thermal throttling shows up in the report and isn't blamed on Strapi.

## Performance risk map

| ID | Risk | Likelihood | Impact | Covered by |
|---|---|---|---|---|
| P1 | The Node process saturates one core, so latency climbs | High | High | Stress, S6 |
| P2 | Heavy list requests (page size near 100, deep populate) are far slower than the rest | High | Medium | Heavy reader, S2 |
| P3 | Concurrent writes lock or slow SQLite | Medium | High | Writer scenario on SQLite, S3 |
| P4 | The database connection pool queues requests | Medium | Medium | Stress on Postgres |
| P5 | Memory grows steadily over time | Medium | High | Soak, S7 |
| P6 | The server does not recover after a spike | Medium | High | Spike, S8 |
| P7 | The login rate limit (10 per minute) or errors under load distort results | Medium | Medium | Separate login scenario, S5 |
| P8 | The laptop itself distorts results (swapping, throttling) | High | High | Idle baseline, repeat runs, CPU speed log |

Why these: Strapi runs on one main thread, so one busy core limits it (P1). Populate and large pages multiply the database work per request (P2). SQLite is one file with one writer (P3). The login limit applies per IP, and all VUs share one IP (P7).

## Limits I check

Only S1–S5 can fail a k6 run directly. S6–S8 are judged after the run by a script, from the stats CSV and the p95 time series.

| ID | Verify | Limit | Why this limit |
|---|---|---|---|
| S1 | Verify read p95 stays under 500 ms at target load | p95 < 500 ms | I chose 500 ms as the point where a page starts to feel slow. |
| S2 | Verify heavy read p95 stays under a limit I set after the baseline run | [to confirm] | The heavy request does far more work, so it gets its own limit once I see an unloaded number. |
| S3 | Verify write p95 stays under 1,000 ms at target load | p95 < 1,000 ms | Writes do more work than reads, so I allow twice the time. |
| S4 | Verify fewer than 1% of requests fail | < 1% | A few failures are tolerable, a steady stream isn't. |
| S5 | Verify no unexpected 429 responses in the mixed workload | 0 | A 429 means the rate limiter, not capacity, is answering. |
| S6 | Verify Strapi's CPU stays under about 60% at target load and under about 80% at 1.5× target load | see below | This gives headroom before the single main thread saturates. |
| S7 | Verify memory grows by at most 20% during the soak, measured after warm-up | ≤ 20% | Some growth is normal. Steady growth is a leak. |
| S8 | Verify p95 returns to baseline within N seconds after the spike ends | N [to confirm after baseline] | Recovery is a number, not a feeling. |

I report p99 but give it no limit yet. On a noisy 2-core laptop one background hiccup can spike it, so a hard limit could fail runs for reasons unrelated to Strapi. After the baseline run I decide whether it gets one, as with S2.

### How S6 is measured

- **Unit:** one logical processor counts as 100%. This machine has 4, so a process can read up to 400%. On a 2-core CPU with hyper-threading this is not quite one physical core when its sibling thread is busy.
- **Process:** the Strapi Node process, found by the process listening on its port (1337), not by name. VS Code and npm also run as `node`, and `npm start` can launch a wrapper whose CPU would read near zero.
- **Sampling:** a script reads the process's cumulative CPU time every 5 seconds. CPU % is the change in CPU time divided by the elapsed time.
- **Judged on:** the mean of the samples during the steady hold window, excluding warm-up. The peak and the 95th percentile of the samples are reported next to it.
- **Where it applies:** the 60% limit at target load (the load run), the 80% limit at the 1.5× target load stress step.
- **Per database:** S6 is read separately for SQLite and for Postgres. SQLite runs queries on Node's own thread, so its CPU curve may look different, and that is worth showing.
- **Other processes:** k6 and Postgres are reported separately, each by process ID, with no limits.
- **Reading it:** Node's main thread saturates near 100% on this scale. A reading above 100% means worker threads or native work are involved, and I'd report that. This is a measurement method, not a result. The first runs will show whether it behaves as I expect, and I'll say so if it doesn't.

## Tools

| Tool | Purpose |
|---|---|
| k6 | Load generator. Scripts are JavaScript, thresholds are built in, it installs as one Windows program, and it has a built-in web dashboard and HTML report (to verify against the installed version). |
| Strapi 5 (pinned version) | System under test, run in production mode |
| SQLite and Postgres | The two databases I compare. Postgres runs natively from the official ZIP archive. |
| Node scripts | Data generator and the stats sampler (CPU, memory and CPU speed to a CSV) |
| GitHub Actions | CI smoke run only |

I considered JMeter, Artillery and Locust. I chose k6 because I already write JavaScript, and because limits can be written straight into the script so a broken limit fails the run. Grafana is a stretch goal and will probably be skipped for lack of RAM.

## Deliverables

- Load test strategy (this document)
- Load test plan (`02-load-test-plan.md`)
- k6 scenarios and profiles, the data generator and the stats sampler
- Results (`03-results.md`), written after the runs: numbers, graphs and the bottleneck story
- GitHub Actions smoke workflow
- README, including how to reproduce a run, and the newer-Strapi comparison as a possible next step
