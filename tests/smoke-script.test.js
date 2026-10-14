/**
 * The post-deployment smoke script (scripts/smoke-report-idempotency.js) must never leave an active test report,
 * whatever fails. Runs the real script against an in-process fake of the endpoints it uses.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/smoke-report-idempotency.js", import.meta.url));
const IMAGE = path.join(os.tmpdir(), `seefix-smoke-${process.pid}.jpg`);
fs.writeFileSync(IMAGE, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
test.after(() => fs.rmSync(IMAGE, { force: true }));

/** Fake API. `failNotifications`: that lookup drops its connection. `failPost`: the n-th report POST drops at once
 * and later POSTs answer only after `delayMs` (a late success after a sibling request failed). */
function fakeApi({ failNotifications = false, failPost = 0, delayMs = 300 } = {}) {
  const reports = new Map();
  let seq = 0;
  let posts = 0;
  const active = () => [...reports.entries()].find(([, r]) => r.status !== "CANCELLED");
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw && req.headers["content-type"]?.includes("json") ? JSON.parse(raw) : {};
    const json = (status, data) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(data));

    if (req.url === "/api/auth/login") return json(200, { accessToken: "fake" });
    if (req.url === "/api/reports/my/active") {
      const found = active();
      return json(200, { canSubmit: !found, activeReport: found ? { id: found[0], reportNo: `RPT-${found[0]}` } : null });
    }
    if (req.url === "/api/uploads/sign") return json(200, { uploadUrl: `http://127.0.0.1:${server.address().port}/upload`, fields: {} });
    if (req.url === "/upload") return json(200, { public_id: `p-${++seq}` });
    if (req.url === "/api/notifications") {
      if (failNotifications) return req.socket.destroy();
      return json(200, { items: [...reports.keys()].map((id) => ({ type: "REPORT_SUBMITTED", entityId: id })) });
    }
    if (req.url === "/api/reports" && req.method === "POST") {
      posts += 1;
      if (failPost === posts) return req.socket.destroy();
      if (failPost && posts > failPost) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const same = [...reports.entries()].find(([, r]) => body.clientReportId && r.clientReportId === body.clientReportId);
      if (same) {
        if (same[1].description !== body.description) return json(409, { error: { code: "CLIENT_REPORT_ID_CONFLICT" } });
        return json(200, { id: same[0], replayed: true });
      }
      if (active()) return json(409, { error: { code: "ACTIVE_REPORT_EXISTS" } });
      const id = `r${++seq}`;
      reports.set(id, { status: "SUBMITTED", clientReportId: body.clientReportId, description: body.description });
      return json(201, { id, replayed: false });
    }
    const cancel = req.url.match(/^\/api\/reports\/([^/]+)\/cancel$/);
    if (cancel && reports.has(cancel[1])) {
      reports.get(cancel[1]).status = "CANCELLED";
      return json(200, { cancelled: true });
    }
    json(404, {});
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, reports, active })));
}

function runScript(port) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT],
      { env: { ...process.env, SMOKE_API: `http://127.0.0.1:${port}`, SMOKE_EMAIL: "smoke@example.test", SMOKE_PASSWORD: "x", SMOKE_IMAGE: IMAGE } },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, output: stdout + stderr }),
    );
  });
}

async function scenario(options) {
  const api = await fakeApi(options);
  try {
    const result = await runScript(api.server.address().port);
    // Give any late request time to land, then nothing may be active.
    await new Promise((resolve) => setTimeout(resolve, (options?.delayMs ?? 0) + 100));
    return { ...result, active: api.active(), reports: api.reports };
  } finally {
    api.server.close();
  }
}

test("all checks pass and every test report ends cancelled (exit 0)", async () => {
  const { code, output, active, reports } = await scenario();
  assert.equal(code, 0, output);
  assert.match(output, /All smoke checks passed/);
  assert.equal(active, undefined);
  assert.ok(reports.size >= 3);
});

test("a failure half-way still cancels what was created, and fails the run", async () => {
  const { code, output, active } = await scenario({ failNotifications: true });
  assert.equal(code, 1, output);
  assert.match(output, /ABORTED/);
  assert.match(output, /cleanup: no active test report remains/);
  assert.equal(active, undefined);
});

test("one concurrent request fails early while another succeeds later: the late report is cancelled too", async () => {
  // POSTs 1-3 are create / replay / conflict; 4-6 are the concurrent ones. #4 drops at once, #5 and #6 answer late.
  const { code, output, active } = await scenario({ failPost: 4, delayMs: 300 });
  assert.equal(code, 1, output);
  assert.match(output, /FAIL {2}concurrent request completed/);
  assert.equal(active, undefined, `still active: ${active?.[0]}\n${output}`);
});
