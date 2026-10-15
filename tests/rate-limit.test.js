import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { MemoryWindow, clientIp, hashKey, sharedRateLimit, memoryRateLimit } from "../src/security/rate-limit.js";
import { errorHandler } from "../src/middleware/errors.js";

function serve(app, fn) {
  const server = app.listen(0);
  return fn(`http://127.0.0.1:${server.address().port}`).finally(() => server.close());
}

test("shared limit returns 429 RATE_LIMITED with Retry-After once over max", async () => {
  const counts = new Map();
  const hit = async (key) => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return { count: counts.get(key), resetIn: 42.2 };
  };
  const app = express();
  app.use(express.json());
  app.post("/login", sharedRateLimit({ name: "t", windowSeconds: 60, max: 2, key: (req) => req.body.identifier, hit }), (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  await serve(app, async (base) => {
    const post = (identifier) =>
      fetch(base + "/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier }) });
    assert.equal((await post("a")).status, 200);
    assert.equal((await post("a")).status, 200);
    const blocked = await post("a");
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get("retry-after"), "43");
    assert.equal((await blocked.json()).error.code, "RATE_LIMITED");
    assert.equal((await post("b")).status, 200, "another account has its own budget");
  });
});

test("shared limit is skipped before its migration is applied, other database errors fail the request", async () => {
  const missing = Object.assign(new Error("relation does not exist"), { code: "42P01" });
  const down = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
  for (const [error, status] of [[missing, 200], [down, 500]]) {
    const app = express();
    app.get("/", sharedRateLimit({ name: "t", windowSeconds: 60, max: 1, key: () => "x", hit: async () => { throw error; } }), (_req, res) => res.json({}));
    app.use(errorHandler);
    await serve(app, async (base) => assert.equal((await fetch(base + "/")).status, status));
  }
});

test("memory window: per-key fixed window, resets, bounded key count", () => {
  let now = 0;
  const w = new MemoryWindow({ windowMs: 1000, max: 2, maxKeys: 3, now: () => now });
  assert.equal(w.hit("u1").allowed, true);
  assert.equal(w.hit("u1").allowed, true);
  assert.equal(w.hit("u1").allowed, false);
  assert.equal(w.hit("u2").allowed, true);
  now = 1000;
  assert.equal(w.hit("u1").allowed, true, "new window");
  for (const k of ["a", "b", "c", "d", "e"]) w.hit(k);
  assert.ok(w.buckets.size <= 3, "never grows past maxKeys");
});

test("general throttle allows a full 10k-row table load (20 pages) many times in a minute", () => {
  const throttle = memoryRateLimit({ windowMs: 60_000, max: 600, key: (req) => req.user.id });
  let blocked = 0;
  for (let i = 0; i < 20 * 25; i += 1) throttle({ user: { id: "staff" } }, {}, (err) => { if (err) blocked += 1; });
  assert.equal(blocked, 0);
});

test("client IP ignores spoofable X-Forwarded-For on Vercel and uses Vercel's own header", () => {
  const req = (headers, ip = "10.0.0.1") => ({ ip, get: (h) => headers[h.toLowerCase()], socket: {} });
  const saved = process.env.VERCEL;
  try {
    process.env.VERCEL = "1";
    assert.equal(clientIp(req({ "x-forwarded-for": "6.6.6.6", "x-vercel-forwarded-for": "203.0.113.9" })), "203.0.113.9");
    delete process.env.VERCEL;
    assert.equal(clientIp(req({ "x-vercel-forwarded-for": "203.0.113.9" })), "10.0.0.1", "outside Vercel the header is not trusted");
  } finally {
    if (saved === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = saved;
  }
});

test("identifiers are hashed (no raw emails in counters) and normalized", () => {
  assert.equal(hashKey(" Admin@Example.com "), hashKey("admin@example.com"));
  assert.ok(!hashKey("admin@example.com").includes("example"));
  assert.match(hashKey("x"), /^[0-9a-f]{32}$/);
});
