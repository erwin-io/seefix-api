# Web Admin V2: API merge order, migrations and deployment runbook

Applies to seefix-api #22 (cache versions), #23 (rate limits) and #24 (search, analytics and map). This answers the
tech lead's OPERATOR-GATED review on #24. **Production DDL needs separate owner authorization.** Nothing in this
runbook has been run against production.

## 1. Merge order (code)

1. **#22 → main** with a merge commit.
2. **#23 → main** with a merge commit. Its only overlap with #22 is one import block in `src/routes/maintenance.js`;
   #24's merge commit `9dd6997` already contains the resolved version.
3. **#24 → main** with a merge commit. After steps 1–2, its diff against main is only its own commits:
   - `87e7947`: search, analytics, buildings, map;
   - the runbook/rehearsal commit: this file, `scripts/v2-migration-rehearsal.sh`, the rollback files,
     `SCHEMA_NOT_READY` and `tests/pre-migration.live.test.js`.

**Final-diff CI:** #24's head is the exact combined tree of all three PRs, so #24's CI run is the final-diff run.
After merging #22 and #23, re-run #24's CI (update the branch from main) before merging #24.

## 2. Migration order (database)

| # | File | Needs | Rollback |
|---|---|---|---|
| 0 | `2026-10-14-report-client-id.sql` | already in production (Oct 14) | n/a |
| 1 | `2026-10-16-v2-cache-domain-versions.sql` | nothing | `rollback/2026-10-16-v2-cache-domain-versions.down.sql` |
| 2 | `2026-10-16-v2-rate-limits.sql` | nothing | `rollback/2026-10-16-v2-rate-limits.down.sql` |
| 3 | `2026-10-16-v2-search-buildings.sql` | 1 applied (Buildings edits bump the `reference` domain); `CREATE EXTENSION pg_trgm` as the Neon database owner | `rollback/2026-10-16-v2-search-buildings.down.sql` |
| 4 | `2026-10-16-v2-workflow-assistant.sql` (#21, stacked on #24) | nothing (the new tables aren't cache domains) | `rollback/2026-10-16-v2-workflow-assistant.down.sql` |

Apply in this order, and roll back in reverse. Each file is additive, idempotent (safe to re-run) and wrapped in one
transaction.

**The currently deployed production API is unaffected by these migrations:** it never reads the new tables or columns.
The only change running code will notice is that every business write now also runs the commit-time version triggers:
at most two single-row UPDATEs per touched domain per transaction.

## 3. Recommended sequence (database first, then code)

1. **Tech lead accepts the code** of #22, #23 and #24. Nothing is merged yet.
2. **Owner, on a Neon branch.** Create a Neon branch of production, which is a copy with real data and the real roles.
   Then:
   ```bash
   REHEARSAL_DATABASE_URL='<branch connection string>' REHEARSAL_CONFIRM='<branch-host>/<db>' \
     bash scripts/v2-migration-rehearsal.sh
   ```
   This applies, re-applies, rolls back, compares the schema and applies again, and it must print two `PASS` lines.
   Then run the role E2E against the branch from the #24 head:
   ```bash
   DATABASE_URL='<branch connection string>' SEEFIX_INTEGRATION_DB=1 npm test
   ```
   This needs one active user per role on the branch, and `PUSHER_*` plus `REALTIME_CLIENTS_ENABLED=on` for the
   realtime ACL test.
3. **Owner, on production.** Take a backup (Neon restore point), then apply files 1 → 2 → 3 with
   `psql -v ON_ERROR_STOP=1 -f <file> -d "$PRODUCTION_URL"`, then run `npm run verify:db`. Expected output:
   `Cache domain versions: 7 domains, 31 version triggers.`
4. **Merge #22, then #23, then #24** (section 1). Vercel deploys `main`. Wait for each deploy before the next merge,
   or merge all three and let one deploy run.
5. **Post-deploy checks:**
   - `/health` returns `ok`;
   - `GET /api/sync/versions` (staff token) returns `available: true`;
   - a second `GET /api/maintenance/reports?page=1&pageSize=50` shows `X-Cache: HIT`;
   - `GET /api/map` (Admin) returns 200;
   - signing in 11 times with a wrong password for one test account returns 429 with `Retry-After`.

**If the code ships before step 3** (out-of-order deploy), it degrades safely. `tests/pre-migration.live.test.js`
verifies this on a database without the V2 migrations:
- legacy endpoints and response shapes are unchanged;
- there is no response cache, and `/api/sync/versions` returns `available: false`;
- shared rate limits are skipped;
- search and analytics work, without the trigram indexes;
- the map and admin building settings return `503 SCHEMA_NOT_READY` instead of a 500.

## 4. Rollback

1. **Code first:** revert the merge commits on `main` in reverse order (#24, #23, #22). Vercel redeploys.
2. **Schema only if needed.** The pre-V2 code ignores the new objects, so leaving them is safe. To remove them, run
   these in order:
   - `rollback/2026-10-16-v2-workflow-assistant.down.sql` (#21), which drops pending reminders, drafts and
     reassessment jobs, so back them up first if they should be kept;
   - `rollback/2026-10-16-v2-search-buildings.down.sql`, which drops building geometry and its history, so back it up
     first if any was entered;
   - `rollback/2026-10-16-v2-rate-limits.down.sql`;
   - `rollback/2026-10-16-v2-cache-domain-versions.down.sql`.

   No business rows are touched.

## 5. Evidence (local PostgreSQL 16, restored from the 2026-10-13 backup)

- `bash scripts/v2-migration-rehearsal.sh` on a fresh restore, plus the Oct 14 migration:
  - all three migrations apply, and re-apply idempotently;
  - 7 domains and 31 version triggers are installed, plus the rate-limit and geometry-history tables;
  - rollback leaves the dbo schema identical to the start (`PASS`);
  - re-applying produces a schema identical to the first migration (`PASS`).
- **The script refuses to start** unless `REHEARSAL_CONFIRM` matches the target host and database (exit 2).
- **Full suite on that freshly migrated database:** `SEEFIX_INTEGRATION_DB=1 npm test` → 133 pass, 0 fail (1 skipped:
  the pre-migration test, which needs its own database).
- **Pre-migration database** (only Oct 14 applied): `SEEFIX_PREMIGRATION_DB=1` → pass.
- **Still owner/operator evidence, not developer evidence:** the run on a Neon branch with real data and roles, and
  production DDL.
