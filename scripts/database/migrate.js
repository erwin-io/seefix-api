// SEEFIX database migration runner: applies db/migrations/*.sql in filename order and records each one in
// dbo."SchemaMigrations". Usage and rules: db/README.md.
//
//   DATABASE_URL=postgresql://... node scripts/database/migrate.js [--allow-remote] [--reset --confirm <database>]
//
// Never loads .env and never prints the connection string.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const LOCK = "hashtext('seefix:db-migrate')";
const BASELINE = /^0000_/;
const NO_TRANSACTION = /^--\s*migrate:no-transaction\b/m;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const TX_DROP = /^(BEGIN|START\s+TRANSACTION|COMMIT|END)\b/i;
const TX_FORBIDDEN = /^(ROLLBACK|ABORT|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION)\b/i;
const DML = new Set(["INSERT", "UPDATE", "DELETE", "MERGE", "COPY"]);

// Splits SQL into top-level statements, skipping comments, quoted strings and dollar-quoted bodies.
// shortcut: SQL-standard function bodies (BEGIN ATOMIC ... END) are not recognised; write them with $$ instead.
export function splitSql(sql) {
  const out = [];
  let start = 0, code = -1, i = 0;
  const end = (to) => {
    if (code >= 0) out.push({ start, codeStart: code, end: to, text: sql.slice(code, to) });
    start = to;
    code = -1;
  };
  while (i < sql.length) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? sql.length : nl + 1;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith("/*", i)) { depth++; i += 2; }
        else if (sql.startsWith("*/", i)) { depth--; i += 2; }
        else i++;
      }
      continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    if (code < 0) code = i;
    if (c === ";") { i++; end(i); continue; }
    if (c === "'" || c === '"') {
      const escapes = c === "'" && /[eE]/.test(sql[i - 1] || "") && !/[\w$]/.test(sql[i - 2] || "");
      let j = i + 1;
      while (j < sql.length) {
        if (escapes && sql[j] === "\\") { j += 2; continue; }
        if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } break; }
        j++;
      }
      i = j + 1;
      continue;
    }
    if (c === "$" && !/[\w$]/.test(sql[i - 1] || "")) {
      const tag = /^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(i, i + 64));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        i = close < 0 ? sql.length : close + tag[0].length;
        continue;
      }
    }
    i++;
  }
  end(sql.length);
  return out;
}

// Statements of a transactional migration: the runner owns the transaction, so the file's own top-level
// BEGIN/COMMIT are dropped (files written for psql keep working unchanged).
export function transactionStatements(sql, file) {
  return splitSql(sql).filter((s) => {
    if (TX_FORBIDDEN.test(s.text)) {
      throw new Error(`${file}: "${s.text.split(/\s/)[0]}" is not allowed in a transactional migration; add "-- migrate:no-transaction"`);
    }
    return !TX_DROP.test(s.text);
  });
}

export const checksum = (sql) => createHash("sha256").update(sql).digest("hex");
const readSql = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");

export function listMigrations(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".sql"))
    .map((e) => e.name)
    .sort();
}

// Schema fingerprint of dbo (tables, columns, indexes, constraints, functions, triggers, views) and extensions.
const FINGERPRINT = `
SELECT md5(coalesce(string_agg(x, '|' ORDER BY x), '')) AS fp FROM (
  SELECT 'r:' || relname || ':' || relkind::text FROM pg_catalog.pg_class WHERE relnamespace = 'dbo'::regnamespace
  UNION ALL SELECT 'c:' || table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '')
    FROM information_schema.columns WHERE table_schema = 'dbo'
  UNION ALL SELECT 'i:' || indexname || ':' || indexdef FROM pg_catalog.pg_indexes WHERE schemaname = 'dbo'
  UNION ALL SELECT 'k:' || conname || ':' || pg_catalog.pg_get_constraintdef(oid) FROM pg_catalog.pg_constraint WHERE connamespace = 'dbo'::regnamespace
  UNION ALL SELECT 'f:' || proname || ':' || pg_catalog.md5(prosrc) FROM pg_catalog.pg_proc WHERE pronamespace = 'dbo'::regnamespace
  UNION ALL SELECT 't:' || tgname || ':' || pg_catalog.pg_get_triggerdef(t.oid) FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'dbo'::regnamespace AND NOT t.tgisinternal
  UNION ALL SELECT 'v:' || viewname || ':' || pg_catalog.md5(definition) FROM pg_catalog.pg_views WHERE schemaname = 'dbo'
  UNION ALL SELECT 'e:' || extname FROM pg_catalog.pg_extension
) s(x)`;

const HISTORY_DDL = `
CREATE SCHEMA IF NOT EXISTS dbo;
CREATE TABLE IF NOT EXISTS "dbo"."SchemaMigrations" (
  "Filename"   text PRIMARY KEY,
  "Checksum"   char(64) NOT NULL,
  "AppliedAt"  timestamptz NOT NULL DEFAULT now(),
  "DurationMs" integer NOT NULL,
  "Adopted"    boolean NOT NULL DEFAULT false
)`;

const lineOf = (sql, index) => sql.slice(0, index).split("\n").length;

// Runs statements one by one so an error names the file line (parse errors: exact; runtime errors: statement start).
async function runStatements(client, sql, statements) {
  let rows = 0;
  for (const s of statements) {
    try {
      const res = await client.query(s.text);
      rows += [res].flat().reduce((n, r) => n + (DML.has(r?.command) ? r.rowCount || 0 : 0), 0);
    } catch (error) {
      error.detailText = `${error.code ? `[${error.code}] ` : ""}${error.message} (line ${lineOf(sql, s.codeStart + Math.max(Number(error.position || 1) - 1, 0))})`;
      throw error;
    }
  }
  return rows;
}

// Applies one migration and records it. Returns true when it was adopted (adoption mode and it changed nothing).
async function applyFile(client, file, sql, adopt, record) {
  if (NO_TRANSACTION.test(sql)) {
    // Each statement autocommits (CREATE INDEX CONCURRENTLY etc.); such files must be safe to re-run.
    try { await runStatements(client, sql, splitSql(sql)); }
    finally { await client.query("RESET ALL"); }
    await record(false);
    return false;
  }
  const statements = transactionStatements(sql, file);
  await client.query("BEGIN");
  try {
    const before = adopt ? (await client.query(FINGERPRINT)).rows[0].fp : null;
    const rows = await runStatements(client, sql, statements);
    await client.query("RESET ALL");
    const adopted = adopt && rows === 0 && (await client.query(FINGERPRINT)).rows[0].fp === before;
    await record(adopted);
    await client.query("COMMIT");
    return adopted;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    await client.query("RESET ALL").catch(() => {});
    throw error;
  }
}

export async function migrate({
  connectionString,
  dir = MIGRATIONS_DIR,
  environment = "local",
  reset = false,
  confirm = "",
  expect = null, // { host, database }: refuse any other target (CI passes the repo variables)
  log = console.log,
} = {}) {
  // Without this, pg would silently fall back to the PGHOST/PGDATABASE environment variables.
  if (!connectionString) throw new Error("migrate() needs an explicit connectionString");
  const stats = { previouslyApplied: 0, pending: 0, applied: 0, adopted: 0, skipped: 0, failed: 0, files: [] };
  log("==============================================");
  log("SEEFIX — NEON DATABASE PREVIEW DEPLOYMENT");
  log("==============================================");
  log(`Environment: ${environment}`);
  const client = new pg.Client({ connectionString, application_name: "seefix-migrate" });
  client.on("notice", () => {});
  let connected = false;
  try {
    const host = new URL(connectionString).hostname;
    if (expect && host !== expect.host) throw new Error("Target check failed: the connection host is not NEON_EXPECTED_HOST. Nothing was changed.");
    await client.connect();
    connected = true;
    const { rows: [{ db }] } = await client.query("SELECT current_database() AS db");
    log("Connection successful.");
    log(`Database: ${db}`);
    if (expect) {
      if (db !== expect.database) throw new Error(`Target check failed: connected database "${db}" is not NEON_EXPECTED_DATABASE. Nothing was changed.`);
      log(`Target verified: ${host} / ${db}`);
    }

    const { rows: [{ locked }] } = await client.query(`SELECT pg_try_advisory_lock(${LOCK}) AS locked`);
    if (!locked) {
      log("Another migration run holds the lock; waiting for it to finish...");
      await client.query(`SELECT pg_advisory_lock(${LOCK})`);
    }

    if (reset) {
      if (confirm !== db) throw new Error(`Reset refused: the confirmation must equal the database name ("${db}").`);
      log(`RESET: dropping schema dbo in ${db} and rebuilding from the baseline...`);
      await client.query("DROP SCHEMA IF EXISTS dbo CASCADE");
    }

    await client.query(HISTORY_DDL);
    const history = new Map((await client.query(
      `SELECT "Filename", "Checksum" FROM "dbo"."SchemaMigrations" ORDER BY "Filename"`,
    )).rows.map((r) => [r.Filename, r.Checksum]));
    const files = listMigrations(dir);
    const sources = new Map(files.map((f) => [f, readSql(path.join(dir, f))]));

    const changed = files.filter((f) => history.has(f) && history.get(f) !== checksum(sources.get(f)));
    for (const f of [...history.keys()].filter((f) => !sources.has(f))) log(`Warning: ${f} is recorded as applied but missing from db/migrations.`);
    const pending = files.filter((f) => !history.has(f));
    stats.previouslyApplied = history.size;
    stats.pending = pending.length;
    log(`Previously applied: ${history.size}`);
    log(`Pending: ${pending.length}`);

    if (changed.length) {
      for (const f of changed) log(`Checksum mismatch: ${f} was changed after it was applied. Revert it and add a new migration instead.`);
      stats.failed = changed.length;
      stats.skipped = history.size;
      return stats;
    }

    // Adoption: dbo already has tables but no migration history (first run against an existing database).
    const { rows: [{ existing }] } = await client.query(
      `SELECT count(*)::int AS existing FROM pg_catalog.pg_tables WHERE schemaname = 'dbo' AND tablename <> 'SchemaMigrations'`,
    );
    const adopt = history.size === 0 && existing > 0;
    if (adopt) log(`Existing dbo schema without history (${existing} tables): adopting it instead of replaying the baseline.`);

    for (const file of pending) {
      const sql = sources.get(file);
      const sum = checksum(sql);
      const started = Date.now();
      try {
        const record = (adopted) => client.query(
          `INSERT INTO "dbo"."SchemaMigrations" ("Filename", "Checksum", "DurationMs", "Adopted") VALUES ($1, $2, $3, $4)`,
          [file, sum, Date.now() - started, adopted],
        );
        // The baseline is never replayed onto an existing schema (its CREATEs are not idempotent).
        const adopted = adopt && BASELINE.test(file)
          ? (await record(true), true)
          : await applyFile(client, file, sql, adopt, record);
        if (adopted) stats.adopted++;
        else stats.applied++;
        stats.files.push({ file, status: adopted ? "adopted" : "applied", ms: Date.now() - started });
        log(`Applying ${file}... OK${adopted ? " (adopted: already present, recorded without changes)" : ""}`);
      } catch (error) {
        stats.failed++;
        stats.files.push({ file, status: "failed", ms: Date.now() - started });
        log(`Applying ${file}... FAILED`);
        log(`  ${error.detailText || `${error.code ? `[${error.code}] ` : ""}${error.message}`}`);
        break;
      }
    }
    stats.skipped = history.size;
    return stats;
  } catch (error) {
    stats.failed = Math.max(stats.failed, 1);
    log(connected || error.message.startsWith("Target check") ? `Error: ${error.message}` : `Connection failed: ${error.code || ""} ${error.message}`.trim());
    return stats;
  } finally {
    // Ending the session releases the advisory lock.
    await client.end().catch(() => {});
    log("----------------------------------------------");
    log(`Applied: ${stats.applied + stats.adopted}${stats.adopted ? ` (${stats.adopted} adopted)` : ""}`);
    log(`Skipped: ${stats.skipped}`);
    log(`Failed: ${stats.failed}`);
    log(stats.failed ? "DATABASE DEPLOYMENT FAILED" : "DATABASE DEPLOYMENT SUCCESSFUL");
  }
}

function writeSummary(stats, environment) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const rows = stats.files.map((f) => `| \`${f.file}\` | ${f.status} | ${f.ms} ms |`).join("\n");
  fs.appendFileSync(file, [
    `## Database deployment ${stats.failed ? "FAILED ❌" : "successful ✅"}`,
    `Environment: ${environment}`,
    "",
    "| Previously applied | Pending | Applied | Adopted | Skipped | Failed |",
    "|---|---|---|---|---|---|",
    `| ${stats.previouslyApplied} | ${stats.pending} | ${stats.applied} | ${stats.adopted} | ${stats.skipped} | ${stats.failed} |`,
    "",
    rows ? `| File | Result | Duration |\n|---|---|---|\n${rows}\n` : "No pending migrations.\n",
  ].join("\n"));
}

async function main(argv) {
  const connectionString = process.env.DATABASE_URL || process.env.NEON_DATABASE_URL;
  const arg = (name) => argv.includes(name);
  const value = (name) => argv[argv.indexOf(name) + 1] ?? "";
  if (!connectionString) {
    console.error("Set DATABASE_URL (or NEON_DATABASE_URL) to the target database. .env is deliberately not read.");
    return 1;
  }
  let host;
  try { host = new URL(connectionString).hostname; }
  catch { console.error("DATABASE_URL is not a valid postgresql:// URL."); return 1; }
  if (host.includes("-pooler")) {
    console.error("The connection string points at the Neon pooler (-pooler host). Use the DIRECT connection string: advisory locks need a session connection.");
    return 1;
  }
  const local = LOCAL_HOSTS.has(host);
  if (!local && process.env.CI !== "true" && !arg("--allow-remote")) {
    console.error("Refusing to migrate a non-local database from a workstation. Pass --allow-remote if you really mean it.");
    return 1;
  }
  const expect = { host: process.env.MIGRATE_EXPECTED_HOST, database: process.env.MIGRATE_EXPECTED_DATABASE };
  if (process.env.CI === "true" && !(expect.host && expect.database)) {
    console.error("Target check failed: set the repository variables NEON_EXPECTED_HOST and NEON_EXPECTED_DATABASE (see db/README.md).");
    return 1;
  }
  const environment = process.env.MIGRATE_ENVIRONMENT || (local ? "local" : "remote");
  const stats = await migrate({
    connectionString,
    environment,
    reset: arg("--reset"),
    confirm: arg("--confirm") ? value("--confirm") : "",
    expect: expect.host || expect.database ? expect : null,
  });
  writeSummary(stats, environment);
  return stats.failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
