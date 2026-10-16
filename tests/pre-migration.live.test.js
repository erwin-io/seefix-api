/**
 * Opt-in (SEEFIX_PREMIGRATION_DB=1): run against a database that has NOT received the 2026-10-16 V2 migrations,
 * to show what happens if this API code is deployed before them. Expected:
 *  - legacy endpoints and shapes unchanged, no response cache, /api/sync/versions says available:false;
 *  - shared rate limits skipped (sign-in works as before);
 *  - search and analytics work (no new schema needed);
 *  - map and admin building settings answer 503 SCHEMA_NOT_READY instead of a 500.
 * Read-only.
 */
import test from "node:test";
import assert from "node:assert/strict";

const enabled = process.env.SEEFIX_PREMIGRATION_DB === "1";

test("pre-migration: V2 code on a database without the V2 migrations degrades safely", { skip: !enabled && "set SEEFIX_PREMIGRATION_DB=1 with a pre-V2 DATABASE_URL" }, async (t) => {
  const { app } = await import("../src/app.js");
  const { pool, query } = await import("../src/database.js");
  const { signAccessToken } = await import("../src/middleware/auth.js");
  const tables = await query(`SELECT to_regclass('"dbo"."CacheDomainVersions"') AS a, to_regclass('"dbo"."RateLimitBuckets"') AS b, to_regclass('"dbo"."BuildingGeometryHistory"') AS c`);
  assert.deepEqual(Object.values(tables.rows[0]), [null, null, null], "needs a database WITHOUT the V2 migrations");
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.close();
    await pool.end();
  });
  const admin = (await query(`SELECT "Id","Role","Email","CredentialsVersion" FROM "dbo"."Users" WHERE "IsActive" AND "Role"='ADMIN' LIMIT 1`)).rows[0];
  const headers = { Authorization: `Bearer ${signAccessToken({ id: admin.Id, role: admin.Role, email: admin.Email }, admin.CredentialsVersion)}` };
  const get = (path) => fetch(base + path, { headers });

  const legacy = await get("/api/maintenance/reports");
  assert.equal(legacy.status, 200);
  assert.equal(legacy.headers.get("x-cache"), null, "no response cache before the migration");
  assert.deepEqual(Object.keys(await legacy.json()), ["items"], "legacy shape");
  assert.deepEqual(await (await get("/api/sync/versions")).json(), { available: false, versions: {} });

  const login = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier: "nobody@example.test", password: "x" }) });
  assert.equal(login.status, 401, "sign-in path works; shared limits are skipped, not failing");

  assert.equal((await get("/api/search?q=RPT")).status, 200);
  assert.equal((await get("/api/analytics/overview")).status, 200);
  for (const path of ["/api/map", "/api/admin/buildings"]) {
    const r = await get(path);
    assert.equal(r.status, 503, path);
    assert.equal((await r.json()).error.code, "SCHEMA_NOT_READY", path);
  }
});
