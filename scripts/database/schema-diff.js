// Shows schema changes made by hand on a local database that no migration contains yet.
//   DATABASE_URL=postgresql://postgres:...@127.0.0.1:5432/seefix_dev npm run db:diff
// Builds a scratch database from db/migrations, pg_dumps both schemas (dbo, --schema-only) and diffs them.
// "+" lines exist only in your database: turn them into a new migration (npm run db:new -- <name>).
// Requires pg_dump and git on PATH. Data changes are not compared.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate } from "./migrate.js";

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"];

async function admin(adminUrl, sql) {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
}

// Creates `name`, runs fn(url), and drops it afterwards, also on failure. CREATE DATABASE fails if the name is taken,
// so a database that existed before this call is never dropped.
export async function withScratchDatabase(sourceUrl, name, fn) {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`invalid scratch database name: ${name}`);
  const adminUrl = new URL(sourceUrl);
  adminUrl.pathname = "/postgres";
  const url = new URL(sourceUrl);
  url.pathname = `/${name}`;
  await admin(adminUrl.href, `CREATE DATABASE "${name}"`);
  try {
    return await fn(url.href);
  } finally {
    await admin(adminUrl.href, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  }
}

export const scratchName = (sourceUrl) =>
  `${new URL(sourceUrl).pathname.slice(1)}`.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40) + `_diff_${randomBytes(6).toString("hex")}`;

function dump(connection, file) {
  const r = spawnSync("pg_dump", ["--schema-only", "--no-owner", "--no-privileges", "--schema=dbo", `--file=${file}`, connection], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("pg_dump failed (is it on PATH?)");
  // Version banners differ between servers and are noise in the diff.
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/^-- Dumped (from|by) .*\n/gm, ""));
}

export async function schemaDiff(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seefix-db-diff-"));
  try {
    await withScratchDatabase(source, scratchName(source), async (scratch) => {
      const stats = await migrate({ connectionString: scratch, environment: "local scratch (db:diff)", log: () => {} });
      if (stats.failed) throw new Error("Migrations failed on the scratch database; run npm run db:migrate on a scratch DB to see why.");
      dump(scratch, path.join(dir, "migrations.sql"));
    });
    dump(source, path.join(dir, "your-database.sql"));
    const diff = spawnSync("git", ["diff", "--no-index", "--", "migrations.sql", "your-database.sql"], { cwd: dir, stdio: "inherit" });
    if (diff.status === 0) console.log("No schema differences: every schema change is in db/migrations.");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = process.env.DATABASE_URL;
  if (!source) {
    console.error("Set DATABASE_URL to your local database.");
    process.exit(1);
  }
  if (!LOCAL_HOSTS.includes(new URL(source).hostname)) {
    console.error("db:diff only runs against a local database.");
    process.exit(1);
  }
  try {
    await schemaDiff(source);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
