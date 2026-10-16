/**
 * Opt-in live checks (SEEFIX_INTEGRATION_DB=1) after db/migrations/2026-10-16-v2-rate-limits.sql.
 * Uses throwaway rate-limit keys and a nonexistent login identifier, and cleans up ONLY the exact keys it touched:
 * its own keys are deleted, the loopback IP counter is restored to what it was. Refuses non-local databases.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { requireTestDatabase } from "./helpers/require-test-db.js";

const live = process.env.SEEFIX_INTEGRATION_DB === "1";
if (live) requireTestDatabase();

test("live: shared counters are atomic under concurrency and reset per window", { skip: !live && "set SEEFIX_INTEGRATION_DB=1" }, async (t) => {
  const { query } = await import("../src/database.js");
  const { hitSharedBucket } = await import("../src/security/rate-limit.js");
  const key = `test:${randomUUID()}`;
  t.after(async () => {
    await query(`DELETE FROM "dbo"."RateLimitBuckets" WHERE "Key"=$1`, [key]);
  });
  const results = await Promise.all(Array.from({ length: 40 }, () => hitSharedBucket(key, 60)));
  assert.deepEqual(results.map((r) => r.count).sort((a, b) => a - b), Array.from({ length: 40 }, (_, i) => i + 1), "no lost or duplicated increments");
  assert.ok(results.every((r) => r.resetIn > 0 && r.resetIn <= 60));
  await query(`UPDATE "dbo"."RateLimitBuckets" SET "WindowStart"=now()-interval '61 seconds' WHERE "Key"=$1`, [key]);
  assert.equal((await hitSharedBucket(key, 60)).count, 1, "expired window starts over");
});

test("live: login is limited per account; SQL-shaped input is just data", { skip: !live && "set SEEFIX_INTEGRATION_DB=1" }, async (t) => {
  const { app } = await import("../src/app.js");
  const { pool, query } = await import("../src/database.js");
  const { signAccessToken } = await import("../src/middleware/auth.js");
  const { hashKey } = await import("../src/security/rate-limit.js");
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const identifier = `nobody-${randomUUID()}@example.test`;
  // Exact keys this test may touch: its own account key, and the loopback IP key in whichever form req.ip takes.
  const ownKey = `login-id:${hashKey(identifier)}`;
  const ipKeys = ["127.0.0.1", "::ffff:127.0.0.1", "::1"].map((a) => `login-ip:${a}`);
  const before = (await query(`SELECT "Key","WindowStart","Count" FROM "dbo"."RateLimitBuckets" WHERE "Key" = ANY($1)`, [ipKeys])).rows;
  // An unrelated counter that must survive the cleanup (regression for wildcard deletes).
  const unrelatedKey = `login-id:unrelated-${randomUUID()}`;
  await query(`INSERT INTO "dbo"."RateLimitBuckets" ("Key","WindowStart","Count") VALUES ($1, now(), 3)`, [unrelatedKey]);
  const cleanup = async () => {
    await query(`DELETE FROM "dbo"."RateLimitBuckets" WHERE "Key" = ANY($1)`, [[ownKey, ...ipKeys]]);
    for (const row of before) {
      await query(`INSERT INTO "dbo"."RateLimitBuckets" ("Key","WindowStart","Count") VALUES ($1,$2,$3)`, [row.Key, row.WindowStart, row.Count]);
    }
  };
  t.after(async () => {
    server.close();
    await cleanup();
    await query(`DELETE FROM "dbo"."RateLimitBuckets" WHERE "Key"=$1`, [unrelatedKey]);
    await pool.end();
  });

  const login = (body) =>
    fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  for (let i = 0; i < 10; i += 1) assert.equal((await login({ identifier, password: "wrong-password" })).status, 401);
  const blocked = await login({ identifier, password: "wrong-password" });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  // Same account through the other accepted field names and casing: same budget, still blocked.
  assert.equal((await login({ email: identifier.toUpperCase(), password: "x" })).status, 429);
  assert.equal((await login({ username: ` ${identifier} `, password: "x" })).status, 429);

  // Injection-shaped values are parameters: no 500, no extra rows.
  const admin = (await query(`SELECT "Id","Role","Email","CredentialsVersion" FROM "dbo"."Users" WHERE "IsActive" AND "Role"='ADMIN' LIMIT 1`)).rows[0];
  const auth = { Authorization: `Bearer ${signAccessToken({ id: admin.Id, role: admin.Role, email: admin.Email }, admin.CredentialsVersion)}` };
  const evil = encodeURIComponent(`' OR 1=1 --`);
  for (const path of [
    `/api/maintenance/reports?status=${evil}`,
    `/api/work-orders?status=${evil}`,
    `/api/maintenance/reports?status=${encodeURIComponent(`'; DROP TABLE "dbo"."Users"; --`)}`,
  ]) {
    const r = await fetch(base + path, { headers: auth });
    assert.equal(r.status, 200, path);
    assert.deepEqual((await r.json()).items, [], `${path} matches nothing`);
  }
  for (const path of [`/api/maintenance/reports?triage=${evil}`, `/api/maintenance/review-queue?triage=${evil}`]) {
    assert.equal((await fetch(base + path, { headers: auth })).status, 400, path);
  }
  assert.ok((await query(`SELECT COUNT(*)::int AS n FROM "dbo"."Users"`)).rows[0].n > 0, "Users table intact");

  // Cleanup touches only this test's keys: the unrelated counter survives, the IP counter is back to its old value.
  await cleanup();
  const unrelated = (await query(`SELECT "Count" FROM "dbo"."RateLimitBuckets" WHERE "Key"=$1`, [unrelatedKey])).rows[0];
  assert.equal(unrelated?.Count, 3, "an unrelated login counter must survive the test cleanup");
  const after = (await query(`SELECT "Key","WindowStart","Count" FROM "dbo"."RateLimitBuckets" WHERE "Key" = ANY($1)`, [ipKeys])).rows;
  assert.deepEqual(after.map((r) => [r.Key, r.Count]).sort(), before.map((r) => [r.Key, r.Count]).sort(), "IP counters restored");
  assert.equal((await query(`SELECT 1 FROM "dbo"."RateLimitBuckets" WHERE "Key"=$1`, [ownKey])).rowCount, 0, "own key removed");
});
