/**
 * Opt-in live check (SEEFIX_INTEGRATION_DB=1) after db/migrations/2026-10-16-v2-cache-domain-versions.sql.
 * Two separate API processes share one database. Commits by another instance or by a non-API writer (the Agent/Worker
 * stand-in below) must invalidate the other instance's cache; rolled-back writes must not.
 * Writes are no-op touches (a column set to its own value; only UpdatedAt moves). Run only against a test database.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const live = process.env.SEEFIX_INTEGRATION_DB === "1";
const root = fileURLToPath(new URL("..", import.meta.url));

function startInstance(cache = "on") {
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", `import { app } from "./src/app.js"; const s = app.listen(0, () => console.log("PORT=" + s.address().port));`],
    { cwd: root, env: { ...process.env, RESPONSE_CACHE: cache }, stdio: ["ignore", "pipe", "inherit"] },
  );
  return new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      const m = /PORT=(\d+)/.exec(String(chunk));
      if (m) resolve({ base: `http://127.0.0.1:${m[1]}`, stop: () => child.kill() });
    });
    child.on("exit", (code) => reject(new Error(`instance exited ${code}`)));
  });
}

test("live: domain versions invalidate caches across instances and writers", { skip: !live && "set SEEFIX_INTEGRATION_DB=1" }, async (t) => {
  const { pool, query, withTransaction } = await import("../src/database.js");
  const { signAccessToken } = await import("../src/middleware/auth.js");
  const token = async (role) => {
    const u = (await query(`SELECT "Id","Role","Email","CredentialsVersion" FROM "dbo"."Users" WHERE "IsActive" AND "Role"=$1 LIMIT 1`, [role])).rows[0];
    assert.ok(u, `needs an active ${role}`);
    return { Authorization: `Bearer ${signAccessToken({ id: u.Id, role: u.Role, email: u.Email }, u.CredentialsVersion)}` };
  };
  const admin = await token("ADMIN");
  const worker = await token("WORKER");
  const [a, b, nocache] = await Promise.all([startInstance(), startInstance(), startInstance("off")]);
  t.after(async () => {
    a.stop();
    b.stop();
    nocache.stop();
    await pool.end();
  });
  const get = (inst, path, headers = admin) => fetch(inst.base + path, { headers });
  const cacheState = async (inst, path) => (await get(inst, path)).headers.get("x-cache");
  const touchReport = (client) =>
    client.query(`UPDATE "dbo"."Reports" SET "Building"="Building" WHERE "Id"=(SELECT "Id" FROM "dbo"."Reports" ORDER BY "CreatedAt" LIMIT 1)`);

  const list = "/api/maintenance/reports?page=1&pageSize=5";
  assert.equal(await cacheState(a, list), "MISS");
  assert.equal(await cacheState(a, list), "HIT");

  // A rolled-back write by any writer changes nothing.
  await assert.rejects(withTransaction(null, async (client) => {
    await touchReport(client);
    throw new Error("abort"); // withTransaction rolls back
  }), /abort/);
  assert.equal(await cacheState(a, list), "HIT", "rolled back: version unchanged");

  // A committed write by a non-API writer (the Agent/Worker path: plain SQL in its own transaction).
  await withTransaction(null, (client) => touchReport(client));
  assert.equal(await cacheState(a, list), "MISS", "Agent/Worker-style commit invalidates instance A");

  // A committed write through the OTHER API instance.
  const users = "/api/admin/users?page=1&pageSize=5";
  assert.equal(await cacheState(a, users), "MISS");
  assert.equal(await cacheState(a, users), "HIT");
  const me = await (await get(b, "/api/auth/me")).json();
  const patch = await fetch(b.base + "/api/auth/me", {
    method: "PATCH",
    headers: { ...admin, "Content-Type": "application/json" },
    body: JSON.stringify({ fullName: me.user.fullName }),
  });
  assert.equal(patch.status, 200);
  assert.equal(await cacheState(a, users), "MISS", "instance B's commit invalidates instance A");

  // Versions endpoint: never cached, role-filtered.
  const adminVersions = await get(a, "/api/sync/versions");
  assert.equal(adminVersions.headers.get("cache-control"), "no-store");
  const av = await adminVersions.json();
  assert.equal(av.available, true);
  assert.deepEqual(Object.keys(av.versions).sort(), ["action_items", "procurement", "reference", "reports", "users", "work_orders"]);
  const wv = await (await get(a, "/api/sync/versions", worker)).json();
  assert.deepEqual(Object.keys(wv.versions).sort(), ["reference", "reports", "work_orders"]);

  // Every row exactly once across pages, same order as a direct query.
  const expected = (await query(`SELECT "Id" FROM "dbo"."Users" ORDER BY "CreatedAt" DESC, "Id" DESC`)).rows.map((r) => r.Id);
  const seen = [];
  for (let page = 1; ; page += 1) {
    const body = await (await get(b, `/api/admin/users?page=${page}&pageSize=2`)).json();
    seen.push(...body.items.map((u) => u.id));
    if (!body.hasMore) break;
  }
  assert.deepEqual(seen, expected);

  // Legacy callers (no paging params) keep the old response shape.
  const legacy = await (await get(a, "/api/admin/users")).json();
  assert.deepEqual(Object.keys(legacy), ["items"]);

  // Overhead of the version check: cached vs uncached p50/p95 (evidence for the PR, not a hard limit).
  const timeIt = async (inst, path) => {
    const ms = [];
    for (let i = 0; i < 30; i += 1) {
      const t0 = performance.now();
      await (await get(inst, path)).arrayBuffer();
      ms.push(performance.now() - t0);
    }
    ms.sort((x, y) => x - y);
    return { p50: ms[14].toFixed(1), p95: ms[28].toFixed(1) };
  };
  const reportsAll = "/api/maintenance/reports?page=1&pageSize=500";
  for (const path of [reportsAll, "/api/maintenance/action-center?page=1&pageSize=500"]) {
    const cached = await timeIt(a, path);
    const direct = await timeIt(nocache, path);
    console.log(`${path}: cached p50=${cached.p50}ms p95=${cached.p95}ms | no cache p50=${direct.p50}ms p95=${direct.p95}ms`);
  }
});
