/**
 * Migration runner (scripts/database/migrate.js). The parser tests always run.
 * The live tests are opt-in and create/drop throwaway databases named seefix_migrate_test_*:
 *   SEEFIX_MIGRATE_TEST_URL=postgresql://postgres:<password>@127.0.0.1:5432/postgres  (local server only)
 *   SEEFIX_MIGRATE_TEST_DUMP=../seefix-db/seefix-dbo-2026-10-13.sql  (optional: adoption test, needs pg_restore)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { MIGRATIONS_DIR, checksum, listMigrations, migrate, splitSql, transactionStatements } from "../scripts/database/migrate.js";

test("splitSql ignores semicolons and BEGIN/COMMIT inside comments, strings and dollar quotes", () => {
  const sql = `-- BEGIN; in a comment
BEGIN;
CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM 1; -- COMMIT;
END;
$fn$;
/* COMMIT; /* nested */ */ INSERT INTO t VALUES ('a;b', E'it\\'s;', "x;y", $$;$$);
COMMIT;
`;
  const texts = splitSql(sql).map((s) => s.text.split(/\s/)[0]);
  assert.deepEqual(texts, ["BEGIN;", "CREATE", "INSERT", "COMMIT;"]);
  const kept = transactionStatements(sql, "x.sql");
  assert.deepEqual(kept.map((s) => s.text.split(/\s/)[0]), ["CREATE", "INSERT"]);
  assert.match(kept[0].text, /\nBEGIN\n {2}PERFORM 1; -- COMMIT;\nEND;\n\$fn\$;$/);
});

test("transactional migrations may not ROLLBACK or SAVEPOINT", () => {
  assert.throws(() => transactionStatements("BEGIN; SELECT 1; ROLLBACK;", "x.sql"), /migrate:no-transaction/);
});

test("the baseline sorts first and every migration file splits cleanly", () => {
  const files = listMigrations();
  assert.match(files[0], /^0000_baseline_dbo\.sql$/);
  for (const f of files) assert.ok(splitSql(fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8")).length > 0, f);
  assert.equal(checksum("a\nb"), checksum("a\r\nb".replace(/\r\n/g, "\n")));
});

const adminUrl = process.env.SEEFIX_MIGRATE_TEST_URL;
const local = adminUrl && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(adminUrl).hostname);
const skip = !local && "set SEEFIX_MIGRATE_TEST_URL to a LOCAL postgres admin URL";
const dumpFile = process.env.SEEFIX_MIGRATE_TEST_DUMP;

async function admin(sql) {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try { return await c.query(sql); } finally { await c.end(); }
}

async function freshDb(t, name) {
  const db = `seefix_migrate_test_${name}`;
  await admin(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await admin(`CREATE DATABASE ${db}`);
  t.after(() => admin(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`));
  const url = new URL(adminUrl);
  url.pathname = `/${db}`;
  return { db, url: url.href };
}

function migrationsDir(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seefix-migrate-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const f of listMigrations()) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
  for (const [f, sql] of Object.entries(extra)) fs.writeFileSync(path.join(dir, f), sql);
  return dir;
}

async function run(url, dir, opts = {}) {
  const lines = [];
  const stats = await migrate({ connectionString: url, dir, log: (l) => lines.push(l), ...opts });
  return { stats, out: lines.join("\n") };
}

async function q(url, sql) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try { return (await c.query(sql)).rows; } finally { await c.end(); }
}

const REAL = listMigrations().length;
const FEATURES = {
  "2099-01-01-000001-new-table.sql": `CREATE TABLE "dbo"."MigrateTestThings" ("Id" serial PRIMARY KEY, "Code" text UNIQUE NOT NULL);`,
  "2099-01-01-000002-new-column.sql": `BEGIN;\nALTER TABLE "dbo"."Buildings" ADD COLUMN "Floors" integer;\nCOMMIT;`,
  "2099-01-01-000003-reference-data.sql": `INSERT INTO "dbo"."MigrateTestThings" ("Code") VALUES ('A'), ('B') ON CONFLICT ("Code") DO NOTHING;`,
  "2099-01-01-000004-data-update.sql": `UPDATE "dbo"."Buildings" SET "Floors" = 3 WHERE "Code" = 'CBE';`,
};

test("live: empty database gets the baseline, then several pending migrations, and a rerun changes nothing", { skip }, async (t) => {
  const { url } = await freshDb(t, "empty");
  const first = await run(url, migrationsDir(t));
  assert.equal(first.stats.failed, 0, first.out);
  assert.equal(first.stats.applied, REAL);
  assert.match(first.out, /SEEFIX — NEON DATABASE PREVIEW DEPLOYMENT[\s\S]*Connection successful\.[\s\S]*Previously applied: 0\nPending: \d+\nApplying 0000_baseline_dbo\.sql\.\.\. OK/);
  assert.match(first.out, /DATABASE DEPLOYMENT SUCCESSFUL$/);
  assert.equal((await q(url, `SELECT count(*)::int n FROM "dbo"."Buildings"`))[0].n, 8);

  const dir = migrationsDir(t, FEATURES);
  const second = await run(url, dir);
  assert.equal(second.stats.applied, 4, second.out);
  assert.equal(second.stats.skipped, REAL);
  assert.equal((await q(url, `SELECT "Floors" FROM "dbo"."Buildings" WHERE "Code" = 'CBE'`))[0].Floors, 3);

  const third = await run(url, dir);
  assert.deepEqual([third.stats.applied, third.stats.pending, third.stats.failed], [0, 0, 0], third.out);
  assert.equal((await q(url, `SELECT count(*)::int n FROM "dbo"."MigrateTestThings"`))[0].n, 2);
  assert.equal((await q(url, `SELECT count(*)::int n FROM "dbo"."SchemaMigrations"`))[0].n, REAL + 4);
});

test("live: a failing migration rolls back, records nothing and stops the run", { skip }, async (t) => {
  const { url } = await freshDb(t, "fail");
  const dir = migrationsDir(t, {
    "2099-01-01-000001-broken.sql": `CREATE TABLE "dbo"."HalfDone" ("Id" int);\nSELECT 1/0;`,
    "2099-01-01-000002-after.sql": `CREATE TABLE "dbo"."After" ("Id" int);`,
  });
  const { stats, out } = await run(url, dir);
  assert.equal(stats.failed, 1);
  assert.match(out, /Applying 2099-01-01-000001-broken\.sql\.\.\. FAILED\n {2}\[22012\] division by zero \(line 2\)/);
  assert.match(out, /DATABASE DEPLOYMENT FAILED$/);
  const rows = await q(url, `SELECT to_regclass('dbo."HalfDone"') h, to_regclass('dbo."After"') a,
    (SELECT count(*)::int FROM "dbo"."SchemaMigrations" WHERE "Filename" LIKE '2099%') n`);
  assert.deepEqual(rows[0], { h: null, a: null, n: 0 });
});

test("live: a changed historical migration fails the run before anything is applied", { skip }, async (t) => {
  const { url } = await freshDb(t, "checksum");
  const dir = migrationsDir(t);
  await run(url, dir);
  fs.appendFileSync(path.join(dir, "2026-10-14-report-client-id.sql"), "\n-- edited later\n");
  fs.writeFileSync(path.join(dir, "2099-01-01-000001-new.sql"), `CREATE TABLE "dbo"."NotYet" ("Id" int);`);
  const { stats, out } = await run(url, dir);
  assert.equal(stats.failed, 1);
  assert.equal(stats.applied, 0);
  assert.match(out, /Checksum mismatch: 2026-10-14-report-client-id\.sql/);
  assert.equal((await q(url, `SELECT to_regclass('dbo."NotYet"') r`))[0].r, null);
});

test("live: concurrent runs serialize on the advisory lock", { skip }, async (t) => {
  const { url } = await freshDb(t, "lock");
  const dir = migrationsDir(t, FEATURES);
  const [a, b] = await Promise.all([run(url, dir), run(url, dir)]);
  assert.equal(a.stats.failed + b.stats.failed, 0, a.out + b.out);
  assert.equal(a.stats.applied + b.stats.applied, REAL + 4);

  // A held lock blocks a run until it is released.
  const holder = new pg.Client({ connectionString: url });
  await holder.connect();
  await holder.query(`SELECT pg_advisory_lock(hashtext('seefix:db-migrate'))`);
  let done = false;
  const blocked = run(url, dir).then((r) => { done = true; return r; });
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(done, false);
  await holder.end();
  assert.equal((await blocked).stats.failed, 0);
});

test("live: no-transaction migrations can CREATE INDEX CONCURRENTLY", { skip }, async (t) => {
  const { url } = await freshDb(t, "notx");
  const dir = migrationsDir(t, {
    "2099-01-01-000001-concurrent.sql": `-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS "IX_Test_Buildings_Name" ON "dbo"."Buildings" ("Name");`,
  });
  const { stats, out } = await run(url, dir);
  assert.equal(stats.failed, 0, out);
  assert.ok((await q(url, `SELECT to_regclass('dbo."IX_Test_Buildings_Name"') r`))[0].r);
});

test("live: reset needs the exact database name, then rebuilds dbo from scratch", { skip }, async (t) => {
  const { url, db } = await freshDb(t, "reset");
  const dir = migrationsDir(t, FEATURES);
  await run(url, dir);
  const refused = await run(url, dir, { reset: true, confirm: "wrong" });
  assert.equal(refused.stats.failed, 1);
  assert.match(refused.out, /Reset refused/);
  assert.equal((await q(url, `SELECT count(*)::int n FROM "dbo"."MigrateTestThings"`))[0].n, 2);
  const reset = await run(url, dir, { reset: true, confirm: db });
  assert.equal(reset.stats.failed, 0, reset.out);
  assert.equal(reset.stats.applied, REAL + 4);
});

test("live: an existing database restored from a dump is adopted, not replayed", { skip: skip || (!dumpFile && "set SEEFIX_MIGRATE_TEST_DUMP") }, async (t) => {
  const { url } = await freshDb(t, "adopt");
  const r = spawnSync("pg_restore", ["--no-owner", "--no-privileges", "-d", url, dumpFile], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const before = await q(url, `SELECT (SELECT count(*)::int FROM "dbo"."Reports") reports, (SELECT count(*)::int FROM "dbo"."Users") users`);
  // Like the live Neon DB: 2026-10-14-report-client-id.sql was applied by hand before the runner existed.
  await q(url, fs.readFileSync(path.join(MIGRATIONS_DIR, "2026-10-14-report-client-id.sql"), "utf8"));
  const dir = migrationsDir(t, { "2099-01-01-000001-new-table.sql": FEATURES["2099-01-01-000001-new-table.sql"] });

  const { stats, out } = await run(url, dir);
  assert.equal(stats.failed, 0, out);
  // Present in the dump (baseline) or applied by hand (2026-10-14): adopted. Anything newer really runs.
  const adoptable = (f) => f === "0000_baseline_dbo.sql" || f === "2026-10-14-report-client-id.sql";
  assert.equal(stats.adopted, 2, out);
  assert.equal(stats.applied, REAL - 2 + 1, out);
  assert.match(out, /adopting it instead of replaying the baseline/);
  const history = await q(url, `SELECT "Filename", "Adopted" FROM "dbo"."SchemaMigrations" ORDER BY 1`);
  assert.deepEqual(history.map((h) => h.Adopted), history.map((h) => adoptable(h.Filename)));
  assert.deepEqual(await q(url, `SELECT (SELECT count(*)::int FROM "dbo"."Reports") reports, (SELECT count(*)::int FROM "dbo"."Users") users`), before);
  assert.equal((await q(url, `SELECT count(*)::int n FROM "dbo"."Buildings"`))[0].n, 8);
});
