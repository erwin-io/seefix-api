/**
 * Client realtime availability is an explicit opt-in, separate from PUSHER_* credentials:
 * clients must keep polling unless an operator confirmed a publisher and set REALTIME_CLIENTS_ENABLED=on.
 * Each case runs the real /api/realtime route handlers in a child process with its own env (no DB).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const routes = new URL("../src/routes/realtime.js", import.meta.url).href;
const PUSHER = { PUSHER_APP_ID: "1", PUSHER_KEY: "pk_test", PUSHER_SECRET: "sk_test_secret", PUSHER_CLUSTER: "ap1" };
const USER = "22222222-2222-4222-8222-222222222222";

// Calls GET /config and POST /auth (own channel) handlers directly; prints {config, auth}.
const probe = `
const { default: router } = await import(${JSON.stringify(routes)});
const handler = (path) => router.stack.find((l) => l.route?.path === path).route.stack.at(-1).handle;
const call = (path, body) => new Promise((resolve) => {
  const req = { user: { id: "${USER}", role: "ADMIN" }, body };
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json: (b) => resolve({ status: res.statusCode, body: b }) };
  handler(path)(req, res, (e) => resolve({ status: e?.status ?? 500, code: e?.code }));
});
console.log(JSON.stringify({
  config: await call("/config"),
  auth: await call("/auth", { socket_id: "123.456", channel_name: "private-user-${USER}" }),
}));
process.exit(0);`;

function run(env) {
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DOTENV_CONFIG_PATH: "nonexistent.env", ...env },
    encoding: "utf8",
  });
  return JSON.parse(out.trim().split("\n").at(-1));
}

test("PUSHER_* configured but client realtime not enabled: /config says disabled, /auth refuses (clients poll)", () => {
  for (const env of [PUSHER, { ...PUSHER, OUTBOX_DISPATCHER: "on" }, { ...PUSHER, REALTIME_CLIENTS_ENABLED: "yes" }]) {
    const r = run(env);
    assert.deepEqual(r.config.body, { enabled: false, key: null, cluster: null, userChannel: `private-user-${USER}` }, JSON.stringify(env));
    assert.deepEqual([r.auth.status, r.auth.code], [503, "REALTIME_DISABLED"]);
  }
});

test("REALTIME_CLIENTS_ENABLED=on without PUSHER_* still disabled", () => {
  const r = run({ REALTIME_CLIENTS_ENABLED: "on" });
  assert.equal(r.config.body.enabled, false);
  assert.equal(r.auth.status, 503);
});

test("deliberately enabled (credentials + REALTIME_CLIENTS_ENABLED=on): advertised and authorizable, secret never returned", () => {
  // Works whether this instance dispatches or a dedicated `npm run outbox:dispatch` worker does.
  for (const env of [{ ...PUSHER, REALTIME_CLIENTS_ENABLED: "on" }, { ...PUSHER, REALTIME_CLIENTS_ENABLED: "on", OUTBOX_DISPATCHER: "off" }]) {
    const r = run(env);
    assert.deepEqual(r.config.body, { enabled: true, key: "pk_test", cluster: "ap1", userChannel: `private-user-${USER}` });
    assert.equal(r.auth.status, 200);
    assert.deepEqual(Object.keys(r.auth.body), ["auth"]);
    assert.ok(!JSON.stringify(r).includes("sk_test_secret"));
  }
});
