/**
 * CORS: listed origins get Access-Control-Allow-Origin; an unlisted Origin must never fail the request
 * (the web admin's Vercel rewrite forwards the browser's Origin, so a 500 there broke every POST).
 * Runs the app in a child process because CORS_ORIGINS is read once at import.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const script = `
  const { app } = await import("./src/app.js");
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const out = {};
  for (const origin of ["https://localhost", "https://seefix-web-admin.vercel.app"]) {
    const pre = await fetch(base + "/api/auth/login", { method: "OPTIONS", headers: {
      Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
    const post = await fetch(base + "/api/nope", { method: "POST", headers: { Origin: origin } });
    out[origin] = { preflight: pre.status, allow: pre.headers.get("access-control-allow-origin"), post: post.status };
  }
  server.close();
  console.log(JSON.stringify(out));
  process.exit(0);
`;

test("listed origins are allowed; unlisted origins get no CORS header but are never rejected", () => {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd,
    encoding: "utf8",
    timeout: 30000,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      DOTENV_CONFIG_PATH: "nonexistent.env",
      DATABASE_URL: "postgresql://test@127.0.0.1:1/test",
      CORS_ORIGINS: "https://localhost,http://localhost:4200",
    },
  });
  const line = r.stdout.trim().split("\n").pop();
  assert.ok(line?.startsWith("{"), `child failed: ${r.stdout}${r.stderr}`);
  const out = JSON.parse(line);
  assert.deepEqual(out["https://localhost"], { preflight: 204, allow: "https://localhost", post: 404 });
  // Unlisted: no allow header (the browser blocks cross-site use), and the request is processed normally (404 route).
  assert.deepEqual(out["https://seefix-web-admin.vercel.app"], { preflight: 204, allow: null, post: 404 });
});
