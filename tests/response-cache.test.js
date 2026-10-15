import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ResponseCache, cachedGet } from "../src/cache/response-cache.js";
import { versionStamp } from "../src/cache/versions.js";
import { pageParams, pageResult } from "../src/utils/pagination.js";

function appWith({ versions, handler, scope = "role", cache = new ResponseCache({ maxEntries: 10, maxBytes: 1e6, ttlMs: 60000 }) }) {
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: req.get("x-user") || "u1", role: req.get("x-role") || "ADMIN" };
    next();
  });
  app.get("/list", cachedGet({ domains: ["reports"], scope, cache, versions, enabled: true }), handler);
  app.use((err, _req, res, _next) => res.status(503).json({ error: err.message }));
  return { app, cache };
}

async function serve(app, fn) {
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test("serves a cached response only while its domain versions are unchanged", async () => {
  let version = 1;
  let calls = 0;
  const { app } = appWith({ versions: async () => ({ reports: version }), handler: (_req, res) => res.json({ n: ++calls }) });
  await serve(app, async (base) => {
    const a = await fetch(base + "/list");
    assert.equal(a.headers.get("x-cache"), "MISS");
    assert.equal(a.headers.get("x-data-versions"), "reports:1");
    assert.deepEqual(await a.json(), { n: 1 });
    const b = await fetch(base + "/list");
    assert.equal(b.headers.get("x-cache"), "HIT");
    assert.deepEqual(await b.json(), { n: 1 });
    version = 2; // a commit anywhere (API, Agent, Worker) bumped the domain
    const c = await fetch(base + "/list");
    assert.equal(c.headers.get("x-cache"), "MISS");
    assert.deepEqual(await c.json(), { n: 2 });
  });
});

test("entries are scoped by role, or by user when scope is 'user'", async () => {
  let calls = 0;
  const handler = (req, res) => res.json({ who: req.user.id, n: ++calls });
  const { app } = appWith({ versions: async () => ({ reports: 1 }), handler, scope: "user" });
  await serve(app, async (base) => {
    const one = await (await fetch(base + "/list", { headers: { "x-user": "worker-a", "x-role": "WORKER" } })).json();
    const two = await (await fetch(base + "/list", { headers: { "x-user": "worker-b", "x-role": "WORKER" } })).json();
    assert.equal(one.who, "worker-a");
    assert.equal(two.who, "worker-b", "another worker must never get worker-a's rows");
  });
  calls = 0;
  const roleScoped = appWith({ versions: async () => ({ reports: 1 }), handler }).app;
  await serve(roleScoped, async (base) => {
    await fetch(base + "/list", { headers: { "x-role": "PROCUREMENT" } });
    const admin = await fetch(base + "/list", { headers: { "x-role": "ADMIN" } });
    assert.equal(admin.headers.get("x-cache"), "MISS", "a different role is a different entry");
  });
});

test("query parameters are part of the key, in any order", async () => {
  let calls = 0;
  const { app } = appWith({ versions: async () => ({ reports: 1 }), handler: (req, res) => res.json({ q: req.query, n: ++calls }) });
  await serve(app, async (base) => {
    await fetch(base + "/list?page=1&pageSize=50");
    assert.equal((await fetch(base + "/list?pageSize=50&page=1")).headers.get("x-cache"), "HIT");
    assert.equal((await fetch(base + "/list?page=2&pageSize=50")).headers.get("x-cache"), "MISS");
  });
});

test("concurrent identical requests share one handler run (single flight)", async () => {
  let calls = 0;
  const handler = async (_req, res) => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 50));
    res.json({ ok: true });
  };
  const { app } = appWith({ versions: async () => ({ reports: 3 }), handler });
  await serve(app, async (base) => {
    const responses = await Promise.all(Array.from({ length: 5 }, () => fetch(base + "/list")));
    assert.equal(calls, 1);
    assert.deepEqual(responses.map((r) => r.headers.get("x-cache")).sort(), ["MISS", "SHARED", "SHARED", "SHARED", "SHARED"]);
  });
});

test("errors are not cached, and waiting requests then run the handler themselves", async () => {
  let calls = 0;
  const { app } = appWith({
    versions: async () => ({ reports: 1 }),
    handler: (_req, res) => (++calls === 1 ? res.status(500).json({ error: "boom" }) : res.json({ ok: true })),
  });
  await serve(app, async (base) => {
    assert.equal((await fetch(base + "/list")).status, 500);
    const ok = await fetch(base + "/list");
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("x-cache"), "MISS");
  });
});

test("when versions cannot be read the request fails instead of serving stale data; no table means no caching", async () => {
  let up = true;
  const { app } = appWith({
    versions: async () => {
      if (!up) throw new Error("database unreachable");
      return { reports: 1 };
    },
    handler: (_req, res) => res.json({ ok: true }),
  });
  await serve(app, async (base) => {
    await fetch(base + "/list"); // cached
    up = false;
    assert.equal((await fetch(base + "/list")).status, 503);
  });
  const legacy = appWith({ versions: async () => null, handler: (_req, res) => res.json({ ok: true }) }).app;
  await serve(legacy, async (base) => {
    const r = await fetch(base + "/list");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-cache"), null, "before the migration the route behaves exactly as before");
  });
});

test("LRU evicts by entry count and byte budget; TTL expires entries", () => {
  let now = 0;
  const cache = new ResponseCache({ maxEntries: 2, maxBytes: 10, ttlMs: 100, now: () => now });
  cache.set("a", "s", "1234");
  cache.set("b", "s", "1234");
  cache.get("a", "s"); // a is now most recent
  cache.set("c", "s", "1234"); // over 2 entries / 10 bytes: evicts b
  assert.equal(cache.get("b", "s"), null);
  assert.equal(cache.get("a", "s"), "1234");
  assert.ok(cache.bytes <= 10);
  cache.set("huge", "s", "x".repeat(11));
  assert.equal(cache.get("huge", "s"), null, "a body larger than the whole budget is never stored");
  now = 101;
  assert.equal(cache.get("a", "s"), null, "expired");
  assert.equal(cache.get("a", "other-stamp"), null);
});

test("version stamps only include the route's domains", () => {
  assert.equal(versionStamp({ reports: 4, users: 9 }, ["reports", "work_orders"]), "reports:4|work_orders:0");
});

test("paging is opt-in, bounded, and reports whether more pages exist", () => {
  assert.equal(pageParams({}), null);
  assert.deepEqual(pageParams({ page: "2", pageSize: "50" }), { page: 2, pageSize: 50, limit: 51, offset: 50 });
  for (const bad of [{ page: "0" }, { page: "x" }, { pageSize: "501" }, { pageSize: "-1" }, { page: "1; DROP TABLE x" }]) {
    assert.throws(() => pageParams(bad), /page/);
  }
  assert.deepEqual(pageResult([1, 2, 3], { page: 1, pageSize: 2 }), { items: [1, 2], page: 1, pageSize: 2, hasMore: true });
  assert.deepEqual(pageResult([1], { page: 3, pageSize: 2 }), { items: [1], page: 3, pageSize: 2, hasMore: false });
});
