/*
 * Post-deployment smoke test for idempotent report creation (offline plan D1, PR #17), against the RUNNING API.
 * Run it yourself; it never prints credentials or tokens.
 *
 *   SMOKE_API=https://seefix-api.vercel.app SMOKE_EMAIL=<test reporter> SMOKE_PASSWORD=<…> \
 *   SMOKE_IMAGE=C:\path\to\photo.jpg node scripts/smoke-report-idempotency.js
 *
 * Use a dedicated REPORTER test account with NO active report, and run it promptly after deploying (cancelling is
 * only allowed until Maintenance reviews a report). Every report it creates is titled "SMOKE TEST", remembered,
 * and cancelled: inline after each step and again in `finally` if a step failed half-way. A failed cancellation
 * fails the run, and a last check confirms the account has no active report left. "Cleaned up" means no active test
 * report remains; the cancelled reports, their images and notifications stay as history.
 * Checks: 201 create → 200 replay (same report, one notification) → 409 CLIENT_REPORT_ID_CONFLICT;
 * 3 concurrent identical requests → one report, one notification; legacy request without clientReportId → 201.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const API = (process.env.SMOKE_API || "").replace(/\/$/, "");
const { SMOKE_EMAIL: email, SMOKE_PASSWORD: password, SMOKE_IMAGE: imagePath } = process.env;
if (!API || !email || !password || !imagePath) {
  console.error("Set SMOKE_API, SMOKE_EMAIL, SMOKE_PASSWORD and SMOKE_IMAGE.");
  process.exit(2);
}

const image = fs.readFileSync(imagePath);
const digest = createHash("sha256").update(image).digest("hex");
const type = /\.png$/i.test(imagePath) ? "image/png" : /\.webp$/i.test(imagePath) ? "image/webp" : "image/jpeg";
let token = null;
let failures = 0;

async function api(method, route, body) {
  const response = await fetch(`${API}${route}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures += 1;
}

/** A fresh direct upload of SMOKE_IMAGE; returns its public ID. */
async function upload() {
  const signed = await api("POST", "/api/uploads/sign", { purpose: "report-image" });
  if (signed.status !== 200) throw new Error(`sign failed: ${signed.status}`);
  const form = new FormData();
  for (const [key, value] of Object.entries(signed.json.fields)) form.append(key, String(value));
  form.append("file", new Blob([image], { type }), path.basename(imagePath));
  const response = await fetch(signed.json.uploadUrl, { method: "POST", body: form });
  const json = await response.json();
  if (!response.ok) throw new Error(`Cloudinary upload failed: ${response.status}`);
  return json.public_id;
}

const body = (publicId, clientReportId, description = "SMOKE TEST — idempotency check, please ignore") => ({
  description,
  building: "SMOKE TEST",
  imagePublicIds: [publicId],
  ...(clientReportId ? { clientReportId, imageDigests: [digest] } : {}),
});

async function submittedNotifications(reportId) {
  const { json } = await api("GET", "/api/notifications");
  return (json.items || []).filter((n) => n.type === "REPORT_SUBMITTED" && n.entityId === reportId).length;
}

/** Every report this run created and has not cancelled yet; cancelled in `finally` whatever happens. */
const toCancel = new Set();

/** POST /api/reports, remembering any report it created (or replayed) for cleanup. */
async function postReport(payload) {
  const response = await api("POST", "/api/reports", payload);
  if ((response.status === 200 || response.status === 201) && response.json.id) toCancel.add(response.json.id);
  return response;
}

async function cancel(reportId) {
  const { status } = await api("POST", `/api/reports/${reportId}/cancel`, { reason: "Smoke test cleanup" });
  check(`cleanup: ${reportId} cancelled`, status === 200, `HTTP ${status}`);
  if (status === 200) toCancel.delete(reportId);
}

async function cleanUp() {
  if (!token) return;
  for (const reportId of [...toCancel]) await cancel(reportId).catch((error) => check(`cleanup: ${reportId}`, false, error.message));
  const active = await api("GET", "/api/reports/my/active").catch(() => null);
  check(
    "cleanup: no active test report remains",
    active?.status === 200 && active.json.canSubmit === true,
    active?.json?.activeReport?.reportNo ? `${active.json.activeReport.reportNo} is still active` : `HTTP ${active?.status ?? "none"}`,
  );
}

async function main() {
  const login = await api("POST", "/api/auth/login", { identifier: email, password });
  if (login.status !== 200) throw new Error(`login failed: HTTP ${login.status}`);
  token = login.json.accessToken;
  const active = await api("GET", "/api/reports/my/active");
  if (!active.json.canSubmit) throw new Error("this account already has an active report; use one without");

  // 1. create → replay → conflict
  const id = randomUUID();
  const publicId = await upload();
  const created = await postReport(body(publicId, id));
  check("new clientReportId → 201", created.status === 201 && created.json.replayed === false, `HTTP ${created.status}`);
  const replay = await postReport(body(publicId, id));
  check(
    "same ID + content → 200 replay of the same report",
    replay.status === 200 && replay.json.replayed === true && replay.json.id === created.json.id,
    `HTTP ${replay.status}`,
  );
  const conflict = await postReport(body(publicId, id, "SMOKE TEST — different content"));
  check(
    "same ID + different content → 409 CLIENT_REPORT_ID_CONFLICT",
    conflict.status === 409 && conflict.json.error?.code === "CLIENT_REPORT_ID_CONFLICT",
    `HTTP ${conflict.status}`,
  );
  check("one submission notification", (await submittedNotifications(created.json.id)) === 1);
  await cancel(created.json.id);

  // 2. concurrent duplicates
  const concurrentId = randomUUID();
  const concurrentUpload = await upload();
  // allSettled: wait for every request (a late success must still be cleaned up), and count failures.
  const settled = await Promise.allSettled([1, 2, 3].map(() => postReport(body(concurrentUpload, concurrentId))));
  settled
    .filter((outcome) => outcome.status === "rejected")
    .forEach((outcome) => check("concurrent request completed", false, outcome.reason?.message ?? String(outcome.reason)));
  const results = settled.filter((outcome) => outcome.status === "fulfilled").map((outcome) => outcome.value);
  const statuses = results.map((r) => r.status).sort();
  const ids = new Set(results.map((r) => r.json.id));
  check("3 concurrent identical requests → one report", ids.size === 1 && statuses.join() === "200,200,201", statuses.join());
  const reportId = [...ids][0];
  if (reportId) {
    check("one submission notification under concurrency", (await submittedNotifications(reportId)) === 1);
    await cancel(reportId);
  }

  // 3. legacy client (no clientReportId)
  const legacy = await postReport(body(await upload(), null));
  check("legacy request without clientReportId → 201", legacy.status === 201, `HTTP ${legacy.status}`);
  if (legacy.json.id) await cancel(legacy.json.id);
}

try {
  await main();
} catch (error) {
  console.error(`ABORTED: ${error.message}`);
  failures += 1;
} finally {
  await cleanUp();
}
console.log(failures ? `\n${failures} check(s) failed.` : "\nAll smoke checks passed.");
process.exitCode = failures ? 1 : 0;
