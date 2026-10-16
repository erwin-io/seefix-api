/**
 * Offline Reporter D1: POST /api/reports with clientReportId is idempotent, also under concurrency.
 * The in-memory database models what the real one guarantees: advisory locks held until COMMIT/ROLLBACK, rows
 * visible to other requests only after COMMIT, the one-active-report rule and the (ReporterId, ClientReportId) index.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

Object.assign(process.env, {
  DATABASE_URL: "postgresql://u@db.invalid/seefixdb",
  JWT_SECRET: "x".repeat(40),
  CLOUDINARY_CLOUD_NAME: "demo",
  CLOUDINARY_API_KEY: "key",
  CLOUDINARY_API_SECRET: "secret",
  OUTBOX_DISPATCHER: "off",
});
const { app } = await import("../src/app.js");
const { pool } = await import("../src/database.js");
const { signAccessToken } = await import("../src/middleware/auth.js");
const { v2: cloudinary } = await import("cloudinary");
const { ownerTag, purposeTag, PENDING_TAG } = await import("../src/direct-uploads.js");

// --- in-memory database -------------------------------------------------------------------------------------
let db;
function resetDb() {
  db = { reports: [], attached: new Set(), locks: new Map(), log: [], notifications: 0, outbox: 0, commits: [] };
}
resetDb();

function lock(key) {
  const previous = db.locks.get(key) ?? Promise.resolve();
  let release;
  const held = new Promise((resolve) => (release = resolve));
  db.locks.set(key, previous.then(() => held));
  return previous.then(() => release);
}

const ACTIVE = (r) => !["RESOLVED", "CANCELLED", "NO_ACTION", "DUPLICATE"].includes(r.status);
let seq = 0;

async function run(sql, params = [], tx = null) {
  db.log.push(sql);
  const none = { rows: [], rowCount: 0 };
  if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) {
    if (sql === "COMMIT") {
      db.reports.push(...tx.reports);
      tx.attached.forEach((id) => db.attached.add(id));
      db.notifications += tx.notifications;
      db.outbox += tx.outbox;
      db.commits.splice(0).forEach((notify) => notify());
    }
    if (sql !== "BEGIN") tx.releases.splice(0).forEach((release) => release());
    Object.assign(tx, { reports: [], attached: [], notifications: 0, outbox: 0 });
    return none;
  }
  if (sql.includes("pg_advisory_xact_lock")) {
    tx.releases.push(await lock(params[0]));
    return none;
  }
  if (/FROM "dbo"\."Users" WHERE "Id"=\$1/.test(sql)) {
    return { rows: [{ id: params[0], role: "REPORTER", isActive: true, credentialsVersion: 0 }], rowCount: 1 };
  }
  if (sql.includes('r."ClientReportId"=$2')) {
    const r = db.reports.find((x) => x.reporterId === params[0] && x.clientReportId === params[1]);
    return r ? { rows: [{ ...r.row, clientRequestHash: r.clientRequestHash, imageCount: r.imageCount }], rowCount: 1 } : none;
  }
  if (sql.includes('"Status" NOT IN')) {
    const r = db.reports.find((x) => x.reporterId === params[0] && ACTIVE(x));
    return r ? { rows: [r.row], rowCount: 1 } : none;
  }
  if (sql.includes('UNION ALL SELECT 1 FROM "dbo"."WorkOrderImages"')) {
    return db.attached.has(params[0]) ? { rows: [{}], rowCount: 1 } : none;
  }
  if (/^\s*INSERT INTO "dbo"\."Reports"/.test(sql)) {
    const withClientId = sql.includes('"ClientReportId"');
    const [reporterId] = params;
    const clientReportId = withClientId ? params[9] : null;
    const duplicate = clientReportId && db.reports.some((x) => x.reporterId === reporterId && x.clientReportId === clientReportId);
    if (duplicate) throw Object.assign(new Error("duplicate key"), { code: "23505", constraint: "UX_Reports_Reporter_ClientReportId" });
    seq += 1;
    const row = { id: `report-${seq}`, reportNo: `RPT-${seq}`, status: "SUBMITTED", agentStatus: "PENDING", createdAt: new Date() };
    tx.reports.push({ row, reporterId, status: "SUBMITTED", clientReportId, clientRequestHash: withClientId ? params[10] : null, imageCount: 0 });
    return { rows: [row], rowCount: 1 };
  }
  if (/^\s*INSERT INTO "dbo"\."ReportImages"/.test(sql)) {
    await new Promise((resolve) => setTimeout(resolve, 20)); // keep the transaction open so requests overlap
    tx.attached.push(params[2]);
    tx.reports.at(-1).imageCount += 1;
    return { rows: [{}], rowCount: 1 };
  }
  if (/^\s*INSERT INTO "dbo"\."(Notifications|OutboxEvents)"/.test(sql)) {
    if (sql.includes("OutboxEvents")) tx.outbox += 1;
    else tx.notifications += 1;
    return { rows: [{ Id: "n1", id: "n1" }], rowCount: 1 };
  }
  return none;
}

pool.query = (sql, params) => run(sql, params);
pool.connect = async () => {
  const tx = { reports: [], attached: [], notifications: 0, outbox: 0, releases: [] };
  return { query: (sql, params) => run(sql, params, tx), release() {} };
};
const afterNextCommit = () => new Promise((resolve) => db.commits.push(resolve));

// --- Cloudinary stand-in ----------------------------------------------------------------------------------------
const resources = new Map();
let resourceCalls = 0;
let resourceGate = null; // when set, Cloudinary lookups wait for it (simulates a slow claim)
cloudinary.api.resource = async (publicId) => {
  resourceCalls += 1;
  if (resourceGate) await resourceGate;
  if (resources.has(publicId)) return resources.get(publicId);
  throw { error: { http_code: 404 } };
};
let legacySeq = 0;
cloudinary.uploader.upload_stream = (options, callback) => ({
  end() {
    legacySeq += 1;
    callback(null, { public_id: `seefix/legacy/${legacySeq}`, secure_url: "https://res.cloudinary.com/demo/legacy", resource_type: "image", bytes: 4 });
  },
});
cloudinary.uploader.destroy = async () => ({ result: "ok" });

function upload(user, name) {
  const publicId = `seefix/reports/${name}-${randomUUID()}`;
  resources.set(publicId, {
    public_id: publicId, resource_type: "image", format: "jpg", bytes: 1000,
    secure_url: `https://res.cloudinary.com/demo/${publicId}`, tags: [PENDING_TAG, ownerTag(user.id), purposeTag("report-image")],
  });
  return publicId;
}
const digest = (text) => createHash("sha256").update(text).digest("hex");

// --- HTTP ----------------------------------------------------------------------------------------------------------
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => {
  server.closeAllConnections();
  server.close();
});

const newReporter = () => ({ id: randomUUID(), role: "REPORTER" });
const auth = (user) => ({ Authorization: `Bearer ${signAccessToken({ ...user, email: "r@test.invalid" }, 0)}` });
const post = (user, body) =>
  fetch(`${base}/api/reports`, { method: "POST", headers: { ...auth(user), "Content-Type": "application/json" }, body: JSON.stringify(body) });
const offlineReport = (user, clientReportId, extra = {}) => ({
  clientReportId,
  imagePublicIds: [upload(user, "photo")],
  imageDigests: [digest("photo-bytes")],
  description: "Water leak near stairs",
  ...extra,
});

test.beforeEach(() => {
  resetDb();
  resourceCalls = 0;
  resourceGate = null;
});

test("retry with the same clientReportId returns the same report (200), with no new claim or notification", async () => {
  const user = newReporter();
  const id = randomUUID();
  const body = offlineReport(user, id);

  const first = await post(user, body);
  assert.equal(first.status, 201, await first.clone().text());
  const created = await first.json();
  assert.equal(created.replayed, false);
  const claimsAfterFirst = resourceCalls;

  const retry = await post(user, body);
  assert.equal(retry.status, 200, await retry.clone().text());
  const replayed = await retry.json();
  assert.equal(replayed.id, created.id);
  assert.equal(replayed.reportNo, created.reportNo);
  assert.equal(replayed.imageCount, 1);
  assert.equal(replayed.replayed, true);

  assert.equal(db.reports.length, 1);
  assert.equal(db.notifications, 1, "no second notification");
  assert.equal(db.outbox, 1, "no second outbox event");
  assert.equal(resourceCalls, claimsAfterFirst, "a replay never claims uploads again");
});

test("a retry that re-uploaded a photo (new publicId, same bytes) is still the same report", async () => {
  const user = newReporter();
  const id = randomUUID();
  await post(user, offlineReport(user, id));
  const retry = await post(user, offlineReport(user, id)); // fresh publicId, same digest
  assert.equal(retry.status, 200);
  assert.equal(db.reports.length, 1);
});

test("same clientReportId with different content is refused with 409 CLIENT_REPORT_ID_CONFLICT", async () => {
  const user = newReporter();
  const id = randomUUID();
  await post(user, offlineReport(user, id));

  const otherText = await post(user, offlineReport(user, id, { description: "A different issue" }));
  assert.equal(otherText.status, 409);
  assert.equal((await otherText.json()).error.code, "CLIENT_REPORT_ID_CONFLICT");

  const otherPhoto = await post(user, offlineReport(user, id, { imageDigests: [digest("another photo")] }));
  assert.equal(otherPhoto.status, 409);
  assert.equal((await otherPhoto.json()).error.code, "CLIENT_REPORT_ID_CONFLICT");
  assert.equal(db.reports.length, 1);
});

test("concurrent: the first request commits before the second reaches its upload claim -> one report, both get it", async () => {
  const user = newReporter();
  const id = randomUUID();
  const photo = upload(user, "shared");
  const body = { clientReportId: id, imagePublicIds: [photo], imageDigests: [digest("photo-bytes")], description: "Broken window" };

  // Request A runs through; request B's Cloudinary lookup (its upload claim) waits until A has committed.
  let releaseB;
  const callsBefore = resourceCalls;
  const a = post(user, body);
  // A passes its lookup first (a fixed sleep raced on slow CI runners: A then hit the gate too and nothing committed).
  while (resourceCalls === callsBefore) await new Promise((resolve) => setImmediate(resolve));
  resourceGate = new Promise((resolve) => (releaseB = resolve));
  const committed = afterNextCommit();
  const b = post(user, body);
  await committed;
  releaseB();

  const [ra, rb] = await Promise.all([a, b]);
  const statuses = [ra.status, rb.status].sort();
  assert.deepEqual(statuses, [200, 201], `statuses ${ra.status}/${rb.status}: ${await rb.clone().text()}`);
  const [ja, jb] = await Promise.all([ra.json(), rb.json()]);
  assert.equal(ja.id, jb.id);
  assert.equal(db.reports.length, 1);
  assert.equal(db.notifications, 1);
  assert.equal(db.outbox, 1);
});

test("concurrent: two identical requests at the same instant -> exactly one report", async () => {
  const user = newReporter();
  const id = randomUUID();
  const photo = upload(user, "same-instant");
  const body = { clientReportId: id, imagePublicIds: [photo], imageDigests: [digest("photo-bytes")], description: "Ceiling crack" };

  const responses = await Promise.all([post(user, body), post(user, body), post(user, body)]);
  const statuses = responses.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 200, 201]);
  const ids = new Set(await Promise.all(responses.map(async (r) => (await r.json()).id)));
  assert.equal(ids.size, 1);
  assert.equal(db.reports.length, 1);
  assert.equal(db.notifications, 1);
  assert.equal(db.outbox, 1);
});

test("an unrelated active report is still a real conflict, never treated as this submission", async () => {
  const user = newReporter();
  const first = await post(user, offlineReport(user, randomUUID()));
  assert.equal(first.status, 201);

  const other = await post(user, offlineReport(user, randomUUID(), { description: "Another issue" }));
  assert.equal(other.status, 409);
  assert.equal((await other.json()).error.code, "ACTIVE_REPORT_EXISTS");
});

test("validation: clientReportId must be a UUID; direct uploads need one SHA-256 digest per image", async () => {
  const user = newReporter();
  const cases = [
    offlineReport(user, "not-a-uuid"),
    offlineReport(user, randomUUID(), { imageDigests: undefined }),
    offlineReport(user, randomUUID(), { imageDigests: [] }),
    offlineReport(user, randomUUID(), { imageDigests: ["abc"] }),
  ];
  for (const body of cases) {
    const response = await post(user, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).error.code, "VALIDATION_ERROR");
  }
  assert.equal(db.reports.length, 0);
});

test("legacy requests without clientReportId are unchanged and never touch the new columns", async () => {
  const user = newReporter();
  const response = await post(user, { imagePublicIds: [upload(user, "legacy")], description: "Loose tile" });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).replayed, false);
  assert.ok(!db.log.some((sql) => sql.includes("ClientReportId")), "no lookup or insert of the new columns");
});

test("multipart with clientReportId: the server digests the bytes itself, and a retry replays", async () => {
  const user = newReporter();
  const id = randomUUID();
  const send = () => {
    const form = new FormData();
    form.append("images", new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1])], { type: "image/jpeg" }), "a.jpg");
    form.append("description", "Flickering light");
    form.append("clientReportId", id);
    return fetch(`${base}/api/reports`, { method: "POST", headers: auth(user), body: form });
  };
  assert.equal((await send()).status, 201);
  assert.equal((await send()).status, 200);
  assert.equal(db.reports.length, 1);
});
