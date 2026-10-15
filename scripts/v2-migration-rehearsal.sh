#!/usr/bin/env bash
# Web Admin V2 migration rehearsal: apply → re-apply (idempotency) → roll back → compare the dbo schema with the
# starting point → apply again. Run it ONLY against a disposable copy (local restore or a Neon branch), never against
# production. It refuses to start unless REHEARSAL_CONFIRM repeats the target's host/database exactly.
#
#   REHEARSAL_DATABASE_URL=postgresql://user:pass@host:5432/db \
#   REHEARSAL_CONFIRM=host/db \
#   bash scripts/v2-migration-rehearsal.sh
#
# Needs psql and pg_dump (PostgreSQL 16 client) on PATH. Leaves the database migrated (final state = all V2 applied).
set -euo pipefail
cd "$(dirname "$0")/.."

url="${REHEARSAL_DATABASE_URL:?set REHEARSAL_DATABASE_URL to a disposable test database}"
target="$(node -e 'const u=new URL(process.argv[1]); console.log(u.hostname + u.pathname)' "$url")"
if [ "${REHEARSAL_CONFIRM:-}" != "$target" ]; then
  echo "Refusing: set REHEARSAL_CONFIRM=$target to confirm this is a disposable test database." >&2
  exit 2
fi

UP=(
  db/migrations/2026-10-16-v2-cache-domain-versions.sql
  db/migrations/2026-10-16-v2-rate-limits.sql
  db/migrations/2026-10-16-v2-search-buildings.sql
)
DOWN=(
  db/migrations/rollback/2026-10-16-v2-search-buildings.down.sql
  db/migrations/rollback/2026-10-16-v2-rate-limits.down.sql
  db/migrations/rollback/2026-10-16-v2-cache-domain-versions.down.sql
)
work="$(mktemp -d)"
# Options before the connection string: Windows psql ignores options placed after it.
psql_run() { psql -v ON_ERROR_STOP=1 -q -X "$@" -d "$url"; }
schema() { pg_dump --dbname="$url" --schema-only --schema=dbo --no-owner --no-privileges | grep -v '^-- Dumped' > "$1"; }

echo "Target: $target"
schema "$work/before.sql"
for f in "${UP[@]}"; do echo "apply   $f"; psql_run -f "$f"; done
for f in "${UP[@]}"; do echo "re-apply $f (idempotent)"; psql_run -f "$f"; done
psql_run -At -c "SELECT 'domains=' || COUNT(*) FROM \"dbo\".\"CacheDomainVersions\";
                 SELECT 'version triggers=' || COUNT(*) FROM pg_trigger WHERE tgname LIKE 'CT\_%\_CacheVersion';
                 SELECT 'rate-limit table=' || to_regclass('\"dbo\".\"RateLimitBuckets\"')::text;
                 SELECT 'geometry history table=' || to_regclass('\"dbo\".\"BuildingGeometryHistory\"')::text;"
# Hard check that the migrations really took effect (guards against a silent no-op run).
installed="$(psql_run -At -c "SELECT (to_regclass('\"dbo\".\"CacheDomainVersions\"') IS NOT NULL)::int + (to_regclass('\"dbo\".\"RateLimitBuckets\"') IS NOT NULL)::int + (to_regclass('\"dbo\".\"BuildingGeometryHistory\"') IS NOT NULL)::int")"
if [ "$installed" != "3" ]; then echo "FAIL: migrations did not apply (found $installed of 3 V2 tables)." >&2; exit 1; fi
schema "$work/migrated.sql"
if diff -q "$work/before.sql" "$work/migrated.sql" > /dev/null; then echo "FAIL: migrated schema equals the starting schema." >&2; exit 1; fi
for f in "${DOWN[@]}"; do echo "rollback $f"; psql_run -f "$f"; done
schema "$work/rolled-back.sql"
if diff -q "$work/before.sql" "$work/rolled-back.sql" > /dev/null; then
  echo "PASS: dbo schema after rollback is identical to the starting schema."
else
  echo "FAIL: dbo schema differs after rollback:" >&2
  diff "$work/before.sql" "$work/rolled-back.sql" | head -40 >&2
  exit 1
fi
for f in "${UP[@]}"; do echo "apply   $f"; psql_run -f "$f"; done
schema "$work/final.sql"
if diff -q "$work/migrated.sql" "$work/final.sql" > /dev/null; then
  echo "PASS: re-applied schema is identical to the first migrated schema."
else
  echo "FAIL: re-applied schema differs from the first migration:" >&2
  diff "$work/migrated.sql" "$work/final.sql" | head -40 >&2
  exit 1
fi
echo "Rehearsal complete. Schema snapshots in $work"
