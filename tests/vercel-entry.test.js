/**
 * server.js on Vercel must only export the app: no listen() and no outbox dispatcher loop
 * (the platform serves requests; delivery runs in `npm run outbox:dispatch` elsewhere).
 * Locally (`node server.js`) it still listens. No DB connection is made in either case.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const baseEnv = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  DOTENV_CONFIG_PATH: "nonexistent.env",
  DATABASE_URL: "postgresql://test@127.0.0.1:1/test",
  JWT_SECRET: "x".repeat(32),
  OTP_PEPPER: "y".repeat(32),
  SMTP_HOST: "smtp.invalid",
  SMTP_FROM: "test@seefix.invalid",
  LOCAL_AGENT_SECRET: "test-only",
  HOST: "127.0.0.1",
  PORT: String(40000 + Math.floor(Math.random() * 20000)),
  // Realtime fully configured: proves the dispatcher is skipped on Vercel even when it would otherwise start.
  PUSHER_APP_ID: "1", PUSHER_KEY: "k", PUSHER_SECRET: "s", PUSHER_CLUSTER: "ap1",
  OUTBOX_DISPATCHER: "on",
};
const run = (env, timeout) => spawnSync(process.execPath, ["server.js"], { cwd, env: { ...baseEnv, ...env }, encoding: "utf8", timeout });

test("with VERCEL set, server.js neither listens nor starts the dispatcher, and exits on its own", () => {
  const r = run({ VERCEL: "1" }, 15000);
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.signal, null, `should exit by itself, got ${r.signal}: ${out}`);
  assert.equal(r.status, 0, out);
  assert.doesNotMatch(out, /running at|dispatcher running/);
});

test("without VERCEL, `node server.js` still listens and starts the dispatcher", () => {
  const r = run({}, 4000); // keeps running, so the timeout ends it
  const out = `${r.stdout}${r.stderr}`;
  assert.match(out, /SEEFIX API running at/);
  assert.match(out, /OutboxEvents -> Pusher dispatcher running/);
});
