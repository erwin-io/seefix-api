# SEEFIX database migrations

Every schema or reference-data change is a SQL file in `db/migrations/`. When a file reaches `main`, GitHub Actions
([.github/workflows/deploy-neon-db.yml](../.github/workflows/deploy-neon-db.yml)) applies it to the Neon preview/demo
database. Nobody runs SQL on Neon by hand any more. See [Deployment policy](#deployment-policy) for what runs
automatically and what needs approval.

## Structure

```text
db/migrations/
  0000_baseline_dbo.sql             # the whole dbo schema (2026-10-13 backup) + reference data; builds an EMPTY database
  2026-10-14-report-client-id.sql   # every later change, one file each, applied in filename order
  YYYY-MM-DD-HHMMSS-<name>.sql      # new files (npm run db:new)
  rollback/*.down.sql               # manual rollback notes; never run automatically
scripts/database/
  migrate.js                        # the runner (npm run db:migrate)
  new-migration.js                  # npm run db:new -- <name>
  schema-diff.js                    # npm run db:diff
```

The runner records each applied file in `dbo."SchemaMigrations"` (`Filename`, `Checksum` = SHA-256 of the file with
LF line endings, `AppliedAt`, `DurationMs`, `Adopted`). On each run it:

1. connects and takes `pg_advisory_lock` (a second run waits until the first finishes);
2. fails if a file that was already applied has changed (its checksum differs);
3. applies every pending file in filename order, each in its own transaction together with its history row.
   A failing file is rolled back, recorded nowhere, and stops the run (exit code 1);
4. prints the deployment log and, in GitHub Actions, a job summary.

It reads `DATABASE_URL` (or `NEON_DATABASE_URL`), never `.env`, and never prints the connection string.

## Local commands

| Command | What it does |
|---|---|
| `npm run db:migrate` | apply pending migrations to `DATABASE_URL` (must be localhost unless you pass `-- --allow-remote`) |
| `npm run db:new -- add-building-floors` | create `db/migrations/<local timestamp>-add-building-floors.sql` |
| `npm run db:diff` | show schema changes in your local DB that no migration contains yet (local only) |

PowerShell: `$env:DATABASE_URL = "postgresql://postgres:<password>@127.0.0.1:5432/seefixdb"; npm run db:migrate`
Bash: `DATABASE_URL=postgresql://postgres:<password>@127.0.0.1:5432/seefixdb npm run db:migrate`

`seefix-api/.env` may point at Neon. The runner ignores it on purpose, and it refuses non-local hosts from a
workstation, so a local command can't migrate Neon by accident.

## Writing a migration

1. `npm run db:new -- <what-it-does>` and write the SQL. Don't add `BEGIN`/`COMMIT`: the runner wraps the file in a
   transaction. Older files that contain top-level `BEGIN;`/`COMMIT;` still work: the runner drops those two statements
   and uses its own transaction. `ROLLBACK`/`SAVEPOINT` are rejected.
2. Prefer `IF NOT EXISTS` / `ON CONFLICT DO NOTHING`, so the file is harmless on a database that already has the change.
3. Run `npm run db:migrate` locally, test the API, commit the file with the code that needs it, and open a PR.
   After the merge, Actions applies it to Neon.
4. **Never edit or rename a file once it is on `main`.** Its checksum is recorded, so the next deployment fails.
   To change or undo something, add a new migration (a `rollback/*.down.sql` can be copied into one).

Statements that can't run inside a transaction (`CREATE INDEX CONCURRENTLY`, `ALTER TYPE ... ADD VALUE` on old servers,
`VACUUM`): put `-- migrate:no-transaction` on its own line. Each statement then commits on its own. If one fails midway,
the earlier ones stay and the file isn't recorded, so write such files to be re-runnable (`IF NOT EXISTS`).

Destructive migrations (`DROP COLUMN`, `DROP TABLE`, data rewrites) are allowed: Neon is a shared demo database. They
still need review in the PR, because they run on Neon as soon as the PR is merged.

### Reference and demo data

Reference/setup data (buildings, damage categories, settings) goes in a normal migration:
`INSERT ... ON CONFLICT ("Code") DO NOTHING` or a guarded `UPDATE`. Use fixed UUIDs when other rows refer to the
data. Never commit personal data, real e-mail addresses, or password hashes of real accounts: this repository is
shared. Demo accounts are created with `scripts/seed-rbac-users.js`, not by migrations.

### Capturing changes you made by hand on your local DB

Git only sees files. It can't tell that you ran `ALTER TABLE` in pgAdmin. To find such changes:

```bash
DATABASE_URL=postgresql://postgres:<password>@127.0.0.1:5432/<your-db> npm run db:diff
```

It creates a scratch database with a random name (`<your-db>_diff_<12 hex>`) and builds it from `db/migrations`.
It then runs `pg_dump --schema-only` (schema `dbo`) on both databases and prints a `git diff`. `+` lines exist only
in your database: copy them into a new migration. Data changes are not compared. Requires `pg_dump` and `git` on
`PATH`. Only the scratch database it created itself is dropped, also when something fails. If the name is already
taken, `CREATE DATABASE` fails and nothing is dropped.

## Baseline and adoption

`0000_baseline_dbo.sql` was generated from `seefix-db/seefix-dbo-2026-10-13.sql` (a custom-format `pg_dump`) with
`pg_dump --schema-only --no-owner --no-privileges -n dbo`, plus `--data-only --column-inserts` for `Buildings`,
`DamageCategories` and `SystemSettings`. It contains no users, reports or other personal data. `0000_` sorts before
the date-named files, so it always runs first.

**Adoption** handles a database that already has the schema but no `SchemaMigrations` history, for example Neon on the
first deployment or a local DB restored from a backup. The decision:

- *Adopt* when `dbo."SchemaMigrations"` is empty or missing **and** schema `dbo` has at least one other table.
  On an empty database the baseline runs normally.
- When adopting, the baseline is recorded as applied (`Adopted = true`) **without running**.
- Every later pending file runs in a transaction. If it changed nothing (the dbo schema fingerprint is identical
  before and after, and no row was inserted, updated or deleted), it is recorded with `Adopted = true`. It was already
  there, for example `2026-10-14-report-client-id.sql` on Neon. Otherwise it is recorded as a normal application
  (it was missing and is now applied).
- The fingerprint covers dbo tables, columns, indexes, constraints, functions, triggers and views, plus installed
  extensions.
- A file that isn't idempotent and whose objects already exist fails, and nothing is recorded. Make it idempotent
  in a new commit (it hasn't been applied anywhere yet), or apply/record it by hand.

Adoption trusts that an existing database already contains the baseline schema. Check that with `npm run db:diff`
against a local restore if in doubt.

## Deployment policy

| What | When | Workflow / GitHub environment | Approval |
|---|---|---|---|
| Apply pending migrations (incl. destructive ones such as `DROP COLUMN`) | automatically on every push to `main` that touches `db/migrations/**` or `scripts/database/**`; also by hand via **Run workflow** | `deploy-neon-db.yml` / `neon-preview` | none: the PR review is the gate |
| Reset: drop schema `dbo`, rebuild from baseline + migrations | only by hand | `reset-neon-db.yml` / `neon-preview-reset` | required reviewers on the environment + typed database name |
| Pull requests | never touch Neon (no `pull_request` trigger; PR runs can't read the secret) | — | — |

**Target isolation.** Both workflows give the runner the non-secret repository variables `NEON_EXPECTED_HOST` and
`NEON_EXPECTED_DATABASE`. They run these checks before the lock, the history table or any SQL:

1. In CI it fails if either variable is unset.
2. It compares the connection string's host with `NEON_EXPECTED_HOST` before connecting.
3. After connecting, it compares `current_database()` with `NEON_EXPECTED_DATABASE`.
4. On a mismatch it fails with "Target check failed ... Nothing was changed".

Only the verified host and database name are printed (`Target verified: <host> / <db>`). A secret pointing at another
Neon project/branch, or at production later, therefore fails instead of being migrated. The same checks run locally
when `MIGRATE_EXPECTED_HOST` / `MIGRATE_EXPECTED_DATABASE` are set.

**Secrets live only in the environments**, never as a repository secret. If the reset environment hasn't been set up
(and protected), its job has no `NEON_DATABASE_URL` and fails at "Validate configuration". GitHub creates a missing
environment *without* protection on first use, so create `neon-preview-reset` with reviewers **before** adding the
secret to it.

## Reset (deliberate, destructive)

Actions → **Reset Neon database** → **Run workflow** → type the database name (it must equal the database you are
connected to, i.e. `NEON_EXPECTED_DATABASE`). A required reviewer approves the `neon-preview-reset` deployment. Then,
under the migration lock, the job runs `DROP SCHEMA dbo CASCADE` (all data is lost, including the history) and applies
the baseline and every migration. A wrong name fails before anything is dropped. Pushes never reset.
Locally: `npm run db:migrate -- --reset --confirm <database>`.

## One-time setup (owner)

1. **Connection string.** Neon console → project → **Connect** → choose the branch/database → turn
   **Connection pooling OFF** → copy the string. Its host must **not** contain `-pooler`. Make sure it ends with
   `?sslmode=require`, e.g. `postgresql://<user>:<password>@ep-xxxx.<region>.aws.neon.tech/neondb?sslmode=require`.
2. **Repository variables** (not secret): GitHub → `seefixmanagement/seefix-api` → **Settings → Secrets and
   variables → Actions → Variables → New repository variable**:
   - `NEON_EXPECTED_HOST` = the host part of that string (e.g. `ep-xxxx.<region>.aws.neon.tech`);
   - `NEON_EXPECTED_DATABASE` = the database name (e.g. `neondb`).
3. **Environment `neon-preview`** (ordinary migrations): **Settings → Environments → New environment** →
   `neon-preview`. No required reviewers, so pushes stay zero-blocker. Optionally limit
   *Deployment branches* to `main`. Under *Environment secrets* → **Add secret** `NEON_DATABASE_URL` = the string from step 1.
4. **Environment `neon-preview-reset`** (destructive): **New environment** → `neon-preview-reset` → tick
   **Required reviewers** and add yourself (and the tech lead) → *Deployment branches*: `main` → **Save protection
   rules**. Then add the environment secret `NEON_DATABASE_URL` with the same value.
5. Do **not** create a repository-level `NEON_DATABASE_URL`. Delete one if you already added it.
6. Actions → **Deploy Neon database** → **Run workflow**. The first run checks the target and adopts the existing
   schema. After that every merge to `main` that touches `db/migrations/` deploys by itself.

**Why the direct (non-pooler) string:** the `-pooler` endpoint is PgBouncer in *transaction* mode. Each transaction can
land on a different server connection, so a session-level `pg_advisory_lock` taken on one connection doesn't protect
the next statements, and can stay held on a pooled connection that another client then uses. Neon's docs list
session-level advisory locks among the features pooled connections don't support. The runner needs one real
session for the whole run, so it refuses a `-pooler` host.

The secret only reaches the job as the `DATABASE_URL` environment variable. GitHub masks it in logs, the workflows
never run on `pull_request` (forks and PR branches can't reach Neon), and their token is `contents: read`.
