#!/usr/bin/env bash
# Starts Strapi in production mode on SQLite.
# Why this script exists: the database is chosen by DATABASE_CLIENT, and .env defaults to
# sqlite. Setting it by hand before every run invites running the wrong database by
# mistake, so each database has its own named start command that sets it explicitly.
set -euo pipefail

cd "$(dirname "$0")/../strapi-app"

# better-sqlite3 does not create the .tmp folder itself, and .tmp is git-ignored, so a
# fresh clone does not have it. This is the named step that creates it.
mkdir -p .tmp

echo "Database chosen: SQLITE (file .tmp/data.db)"
DATABASE_CLIENT=sqlite NODE_ENV=production exec npm start
