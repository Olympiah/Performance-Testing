#!/usr/bin/env bash
# Starts Strapi in production mode on Postgres.
# Why this script exists: same reason as start-sqlite.sh. The database is chosen by
# DATABASE_CLIENT, and .env defaults to sqlite, so a named command avoids a wrong choice.
# It also checks that Postgres is running first. Without that check, Strapi fails with a
# long connection error that hides the simple cause: Postgres was not started.
set -euo pipefail

cd "$(dirname "$0")/../strapi-app"

# Postgres lives outside the repo. Set PG_BIN if it is installed somewhere else.
PG_BIN="${PG_BIN:-/c/pg_perf/pgsql/bin}"

if ! "$PG_BIN/pg_isready.exe" -h 127.0.0.1 -p 5432 -q; then
  echo "Postgres is not accepting connections on 127.0.0.1:5432. Start it first." >&2
  exit 1
fi

echo "Database chosen: POSTGRES (connection values from .env)"
DATABASE_CLIENT=postgres NODE_ENV=production exec npm start
