// Creates an empty, timestamped migration: npm run db:new -- add-building-floors
import fs from "node:fs";
import path from "node:path";
import { MIGRATIONS_DIR, listMigrations } from "./migrate.js";

const name = process.argv.slice(2).join("-").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
if (!name) {
  console.error("Usage: npm run db:new -- <name>   (e.g. npm run db:new -- add-building-floors)");
  process.exit(1);
}
// Local YYYY-MM-DD-HHMMSS keeps the existing date-first naming (the team's local dates) and sorts after older files.
const now = new Date();
const stamp = new Date(now - now.getTimezoneOffset() * 60000).toISOString().replace("T", "-").replace(/:/g, "").slice(0, 17);
const file = `${stamp}-${name}.sql`;
const last = listMigrations().at(-1);
if (last && file < last) {
  console.error(`${file} would sort before ${last}; migrations run in filename order. Pick a later name.`);
  process.exit(1);
}
fs.writeFileSync(path.join(MIGRATIONS_DIR, file), `-- ${name}: describe what this migration changes and why.
-- Runs once, inside a transaction (no BEGIN/COMMIT needed). Prefer IF NOT EXISTS / ON CONFLICT so a re-run is harmless.
-- For CREATE INDEX CONCURRENTLY and similar, add the header line: -- migrate:no-transaction

`);
console.log(`Created db/migrations/${file}`);
