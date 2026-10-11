import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dispatchAfterWrite, dispatchNow, hasDispatchSecret } from "../src/realtime/dispatch-now.js";

const U = "22222222-2222-4222-8222-222222222222";
const row = (i) => ({ Id: `e${i}`, RecipientUserId: U, EventName: "notification.created", Payload: {}, AttemptCount: 1 });

/** Fake DB: the claim query returns the next queued batch; every outcome UPDATE succeeds. */
function fakeQ(batches) {
  const queue = [...batches];
  let claims = 0;
  const q = async (sql) => {
    if (sql.includes("FOR UPDATE SKIP LOCKED")) {
      claims += 1;
      const rows = queue.shift() ?? [];
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: sql.includes("lease lapsed") ? 0 : 1 };
  };
  return { q, claims: () => claims };
}

test("dispatchNow drains full batches until a partial one, and sends every claimed row once", async () => {
  const full = Array.from({ length: 10 }, (_, i) => row(i)); // OUTBOX_BATCH_SIZE default = 10
  const db = fakeQ([full, full.map((r) => ({ ...r, Id: `${r.Id}b` })), [row(99)]]);
  const sent = [];
  const total = await dispatchNow({ q: db.q, send: async (_c, _e, d) => void sent.push(d.eventId), enabled: true });
  assert.equal(db.claims(), 3, "stops after the partial batch");
  assert.deepEqual({ passes: total.passes, claimed: total.claimed, sent: total.sent }, { passes: 3, claimed: 21, sent: 21 });
  assert.equal(new Set(sent).size, 21);
});

test("dispatchNow does nothing when Pusher is not configured", async () => {
  const db = fakeQ([[row(1)]]);
  const total = await dispatchNow({ q: db.q, send: async () => assert.fail("must not publish"), enabled: false });
  assert.equal(db.claims(), 0);
  assert.equal(total.sent, 0);
});

test("dispatchNow stops at its time budget", async () => {
  const full = Array.from({ length: 10 }, (_, i) => row(i));
  const db = fakeQ(Array.from({ length: 10 }, () => full));
  let t = 0;
  const total = await dispatchNow({ q: db.q, send: async () => {}, enabled: true, now: () => (t += 15000) });
  assert.ok(total.passes < 10, `budget should cut the drain short, ran ${total.passes}`);
});

test("hasDispatchSecret: Bearer secret only, constant-time, never with an empty secret", () => {
  assert.equal(hasDispatchSecret("Bearer s3cret", "s3cret"), true);
  assert.equal(hasDispatchSecret("bearer s3cret", "s3cret"), true);
  assert.equal(hasDispatchSecret("Bearer wrong", "s3cret"), false);
  assert.equal(hasDispatchSecret("", "s3cret"), false);
  assert.equal(hasDispatchSecret("Bearer ", ""), false, "no secret configured = always refused");
});

test("dispatchAfterWrite drains only after successful write requests outside /api/realtime", async () => {
  const runs = [];
  const scheduled = [];
  const mw = dispatchAfterWrite({ run: async () => runs.push(1), schedule: (p) => scheduled.push(p) });
  const call = (method, url, status) => {
    const res = Object.assign(new EventEmitter(), { statusCode: status });
    let nexted = false;
    mw({ method, originalUrl: url }, res, () => (nexted = true));
    res.emit("finish");
    assert.ok(nexted, "never blocks the request");
  };
  call("POST", "/api/work-orders/x/status", 200);
  call("PATCH", "/api/reports/x", 201);
  call("GET", "/api/work-orders", 200);
  call("POST", "/api/work-orders/x/status", 409);
  call("POST", "/api/realtime/auth", 200);
  call("POST", "/api/realtime/dispatch", 200);
  await Promise.all(scheduled);
  assert.equal(runs.length, 2, "only the two successful business writes");
  assert.equal(scheduled.length, 2, "handed to waitUntil so Vercel keeps the function alive");
});

// The real /api/realtime/dispatch handler, per env, in a child process (no DB reached on these paths).
const routes = new URL("../src/routes/realtime.js", import.meta.url).href;
const probe = `
const { default: router } = await import(${JSON.stringify(routes)});
const handle = router.stack.find((l) => l.route?.path === "/dispatch").route.stack.at(-1).handle;
const status = await new Promise((resolve) => {
  const req = { get: (h) => (h.toLowerCase() === "authorization" ? process.env.PROBE_AUTH : undefined) };
  const res = { status() { return this; }, json: () => resolve(200) };
  handle(req, res, (e) => resolve(e?.status ?? 500));
});
console.log(status); process.exit(0);`;
const run = (env) => Number(execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DOTENV_CONFIG_PATH: "nonexistent.env", ...env },
  encoding: "utf8",
}).trim().split("\n").at(-1));

test("POST /api/realtime/dispatch: 404 unconfigured, 401 bad secret, 503 without Pusher", () => {
  assert.equal(run({ PROBE_AUTH: "Bearer anything" }), 404, "no OUTBOX_CRON_SECRET = endpoint hidden");
  assert.equal(run({ OUTBOX_CRON_SECRET: "s3cret", PROBE_AUTH: "Bearer nope" }), 401);
  assert.equal(run({ OUTBOX_CRON_SECRET: "s3cret" }), 401, "missing header");
  assert.equal(run({ OUTBOX_CRON_SECRET: "s3cret", PROBE_AUTH: "Bearer s3cret" }), 503, "right secret, Pusher not configured");
});
