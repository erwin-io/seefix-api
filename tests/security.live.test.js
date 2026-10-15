/**
 * Opt-in live checks (SEEFIX_INTEGRATION_DB=1) after db/migrations/2026-10-16-v2-rate-limits.sql.
 * Uses throwaway rate-limit keys and a nonexistent login identifier; deletes its counter rows afterwards.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const live = process.env.SEEFIX_INTEGRATION_DB === "1";

test("live: shared counters are atomic under concurrency and reset per window", { skip: !live && "set SEEFIX_INTEGRATION_DB=1" }, async (t) => {
  const { query } = await import("../src/database.js");
  const { hitSharedBucket } = await import("../src/security/rate-limit.js");
  const key = `test:${randomUUID()}`;
  t.after(async () => {
    await query(`DELETE FROM "dbo"."RateLimitBuckets" WHERE "Key" LIKE 'test:%'`);
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
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.close();
    await query(`DELETE FROM "dbo"."RateLimitBuckets" WHERE "Key" LIKE 'login-%'`);
    await pool.end();
  });

  const identifier = `nobody-${randomUUID()}@example.test`;
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
});
