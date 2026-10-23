#!/usr/bin/env bash
# Saves and restores the test database, so every compared run starts from identical data.
#   scripts/reset-db.sh sqlite|postgres save      take the snapshot, once, after the full data run
#   scripts/reset-db.sh sqlite|postgres restore   put the snapshot back, before each compared run
# Strapi must be stopped for both: SQLite would be overwritten under a running server, and
# Postgres cannot drop tables that a connected server is using.
# What this does not cover: uploaded images are files in strapi-app/public/uploads, not rows
# in the database, so a restore leaves them as they are. Never empty that folder.
set -euo pipefail

DB="${1:-}"
ACTION="${2:-}"
if [[ ! "$DB" =~ ^(sqlite|postgres)$ ]] || [[ ! "$ACTION" =~ ^(save|restore)$ ]]; then
  echo "Usage: scripts/reset-db.sh <sqlite|postgres> <save|restore>" >&2
  exit 1
fi

REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP="$REPO/strapi-app"
EXT=db
[ "$DB" = postgres ] && EXT=dump
SNAP_REL=".generated/snapshot-$DB.$EXT"
SNAP="$REPO/$SNAP_REL"

# A snapshot holds password hashes and token data, so it must never be committable.
if ! git -C "$REPO" check-ignore -q "$SNAP_REL"; then
  echo "$SNAP_REL is not git-ignored, refusing to run." >&2
  exit 1
fi

# Any HTTP answer from Strapi means it is running. curl only fails when nothing listens.
if curl -s -o /dev/null --max-time 3 http://127.0.0.1:1337/_health; then
  echo "Strapi is still answering on port 1337. Stop it first." >&2
  exit 1
fi

# save never overwrites: the snapshot is what every compared run is measured against.
if [ "$ACTION" = save ] && [ -e "$SNAP" ]; then
  echo "$SNAP_REL already exists. Delete it yourself if you really want a new one." >&2
  exit 1
fi
if [ "$ACTION" = restore ] && [ ! -e "$SNAP" ]; then
  echo "$SNAP_REL does not exist. Run save first." >&2
  exit 1
fi

if [ "$DB" = sqlite ]; then
  LIVE="$APP/.tmp/data.db"
  if [ "$ACTION" = save ]; then
    cp "$LIVE" "$SNAP"
    echo "Saved $SNAP_REL"
  else
    # A leftover journal file next to a restored database file can corrupt it.
    rm -f "$LIVE-wal" "$LIVE-shm" "$LIVE-journal"
    cp "$SNAP" "$LIVE"
    echo "Restored $SNAP_REL"
  fi
  # The copy is only trusted if both files are byte for byte the same.
  if [ "$(sha256sum < "$LIVE")" = "$(sha256sum < "$SNAP")" ]; then
    echo "Hashes match: live file and snapshot are identical"
  else
    echo "Hashes differ: the copy is not identical" >&2
    exit 1
  fi
  exit 0
fi

# --- Postgres ---
# Postgres lives outside the repo. Set PG_BIN if it is installed somewhere else.
PG_BIN="${PG_BIN:-/c/pg_perf/pgsql/bin}"

# Reads one value from .env without running the file as a script, and without printing it.
env_value() {
  grep -E "^$1=" "$APP/.env" | tail -1 | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/' | tr -d '\r'
}
# The Postgres tools read these standard variables, so no password is ever on a command line.
export PGHOST="$(env_value DATABASE_HOST)"
export PGPORT="$(env_value DATABASE_PORT)"
export PGDATABASE="$(env_value DATABASE_NAME)"
export PGUSER="$(env_value DATABASE_USERNAME)"
export PGPASSWORD="$(env_value DATABASE_PASSWORD)"
if [ -z "$PGHOST" ] || [ -z "$PGPORT" ] || [ -z "$PGDATABASE" ] || [ -z "$PGUSER" ] || [ -z "$PGPASSWORD" ]; then
  echo "A DATABASE_* value is missing in strapi-app/.env." >&2
  exit 1
fi

if ! "$PG_BIN/pg_isready.exe" -q; then
  echo "Postgres is not accepting connections on $PGHOST:$PGPORT. Start it first." >&2
  exit 1
fi

if [ "$ACTION" = save ]; then
  # -Fc is the custom format: compressed, and pg_restore can pick and clean objects from it.
  "$PG_BIN/pg_dump.exe" -Fc -f "$SNAP"
  echo "Saved $SNAP_REL ($(wc -c < "$SNAP") bytes)"
else
  # --clean drops each object before recreating it. --single-transaction means a failure
  # rolls everything back, so a half-restored database cannot be left behind.
  "$PG_BIN/pg_restore.exe" --clean --if-exists --no-owner --single-transaction -d "$PGDATABASE" "$SNAP"
  echo "Restored $SNAP_REL"
fi
# Strapi 5 keeps a draft row and a published row per published Article, so this count is
# higher than the number of Articles. It is a sanity check, not the proof. The proof is to
# start Strapi and re-run scripts/generate-data.js: it must create 0 and match the counts.
echo "Rows in articles: $("$PG_BIN/psql.exe" -t -A -c 'select count(*) from articles')"
