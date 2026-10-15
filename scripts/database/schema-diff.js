// Shows schema changes made by hand on a local database that no migration contains yet.
//   DATABASE_URL=postgresql://postgres:...@127.0.0.1:5432/seefix_dev npm run db:diff
// Builds a scratch database from db/migrations, pg_dumps both schemas (dbo, --schema-only) and diffs them.
// "+" lines exist only in your database: turn them into a new migration (npm run db:new -- <name>).
// Requires pg_dump and git on PATH. Data changes are not compared.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { migrate } from "./migrate.js";

const source = process.env.DATABASE_URL;
if (!source) {
  console.error("Set DATABASE_URL to your local database.");
  process.exit(1);
}
const url = new URL(source);
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
  console.error("db:diff only runs against a local database.");
  process.exit(1);
}
const scratchName = `${url.pathname.slice(1)}_diff_scratch`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
const scratch = new URL(source);
scratch.pathname = `/${scratchName}`;
const admin = new URL(source);
admin.pathname = "/postgres";

const exec = async (sql) => {
  const c = new pg.Client({ connectionString: admin.href });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
};
const dump = (connection, file) => {
  const r = spawnSync("pg_dump", ["--schema-only", "--no-owner", "--no-privileges", "--schema=dbo", `--file=${file}`, connection], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("pg_dump failed (is it on PATH?)");
  // Version banners differ between servers and are noise in the diff.
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/^-- Dumped (from|by) .*\n/gm, ""));
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seefix-db-diff-"));
let status = 0;
try {
  await exec(`DROP DATABASE IF EXISTS "${scratchName}"`);
  await exec(`CREATE DATABASE "${scratchName}"`);
  const stats = await migrate({ connectionString: scratch.href, environment: "local scratch (db:diff)", log: () => {} });
  if (stats.failed) throw new Error("Migrations failed on the scratch database; run npm run db:migrate on a scratch DB to see why.");
  dump(scratch.href, path.join(dir, "migrations.sql"));
  dump(source, path.join(dir, "your-database.sql"));
  const diff = spawnSync("git", ["diff", "--no-index", "--", "migrations.sql", "your-database.sql"], { cwd: dir, stdio: "inherit" });
  if (diff.status === 0) console.log("No schema differences: every schema change is in db/migrations.");
} catch (error) {
  console.error(error.message);
  status = 1;
} finally {
  await exec(`DROP DATABASE IF EXISTS "${scratchName}"`).catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
}
process.exitCode = status;
