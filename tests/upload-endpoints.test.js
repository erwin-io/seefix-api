/**
 * HTTP contract for the three upload endpoints (issue #12), with an in-memory database and Cloudinary stand-in:
 * - every endpoint accepts the legacy multipart format AND the direct-upload JSON format;
 * - two concurrent requests attaching the same direct upload: exactly one succeeds, the other gets 409.
 * The fake database models what the fix relies on: advisory locks held until COMMIT/ROLLBACK, and rows visible to
 * other transactions only after COMMIT.
 */
import test from "node:test";
import assert from "node:assert/strict";

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

const USERS = {
  reporter: { id: "11111111-1111-4111-8111-111111111111", role: "REPORTER" },
  worker: { id: "22222222-2222-4222-8222-222222222222", role: "WORKER" },
  procurement: { id: "33333333-3333-4333-8333-333333333333", role: "PROCUREMENT" },
};
const WORK_ORDER = "44444444-4444-4444-8444-444444444444";
const HANDOFF = "55555555-5555-4555-8555-555555555555";

// --- in-memory database -------------------------------------------------------------------------------------
const db = { attached: new Set(), locks: new Map(), log: [] };
const isAssetId = (v) => typeof v === "string" && v.startsWith("seefix/");

function lock(key) {
  const previous = db.locks.get(key) ?? Promise.resolve();
  let release;
  const held = new Promise((resolve) => (release = resolve));
  db.locks.set(key, previous.then(() => held));
  return previous.then(() => release);
}

async function run(sql, params = [], tx = null) {
  db.log.push(sql);
  const none = { rows: [], rowCount: 0 };
  if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) {
    if (sql === "COMMIT") tx.pending.forEach((id) => db.attached.add(id));
    if (sql !== "BEGIN") tx.releases.splice(0).forEach((release) => release());
    tx.pending = [];
    return none;
  }
  if (sql.includes("hashtextextended")) {
    tx.releases.push(await lock(params[0]));
    return none;
  }
  if (sql.includes('UNION ALL SELECT 1 FROM "dbo"."WorkOrderImages"')) {
    return db.attached.has(params[0]) ? { rows: [{}], rowCount: 1 } : none;
  }
  if (/FROM "dbo"\."Users" WHERE "Id"=\$1/.test(sql)) {
    const user = Object.values(USERS).find((u) => u.id === params[0]);
    return { rows: [{ ...user, isActive: true, credentialsVersion: 0 }], rowCount: 1 };
  }
  if (/SELECT \* FROM "dbo"\."WorkOrders" WHERE "Id"=\$1/.test(sql)) {
    return { rows: [{ Id: WORK_ORDER, Status: "IN_PROGRESS", ResponsibleLeadUserId: USERS.worker.id }], rowCount: 1 };
  }
  if (/FROM "dbo"\."ProcurementHandoffs"\s+WHERE "Id"=\$1/.test(sql)) return { rows: [{ Id: HANDOFF }], rowCount: 1 };
  if (/^\s*INSERT INTO "dbo"\."(ReportImages|WorkOrderImages|ProcurementDocuments)"/.test(sql)) {
    await new Promise((resolve) => setTimeout(resolve, 30)); // keep the transaction open so requests overlap
    tx.pending.push(...params.filter(isAssetId));
    return { rows: [{ Id: "doc-row" }], rowCount: 1 };
  }
  if (/^\s*(INSERT|UPDATE)/.test(sql)) {
    return {
      rows: [{ id: "r1", reportNo: "RPT-1", status: "SUBMITTED", createdAt: new Date(), Id: WORK_ORDER, WorkOrderNo: "WO-1", ReportId: "r1", CompletionSubmittedAt: new Date() }],
      rowCount: 1,
    };
  }
  return none; // other SELECTs: no active report, no recipients, ...
}

pool.query = (sql, params) => run(sql, params);
pool.connect = async () => {
  const tx = { pending: [], releases: [] };
  return { query: (sql, params) => run(sql, params, tx), release() {} };
};

// --- Cloudinary stand-in ----------------------------------------------------------------------------------------
const resources = new Map();
function directUpload(publicId, user, purpose, resourceType = "image") {
  resources.set(publicId, {
    public_id: publicId, resource_type: resourceType, format: resourceType === "image" ? "jpg" : undefined, bytes: 1000,
    secure_url: `https://res.cloudinary.com/demo/${publicId}`, tags: [PENDING_TAG, ownerTag(user.id), purposeTag(purpose)],
  });
  return publicId;
}
cloudinary.api.resource = async (publicId) => {
  if (resources.has(publicId)) return resources.get(publicId);
  throw { error: { http_code: 404 } };
};
let legacySeq = 0;
cloudinary.uploader.upload_stream = (options, callback) => ({
  end() {
    legacySeq += 1;
    callback(null, { public_id: `seefix/legacy/${legacySeq}`, secure_url: "https://res.cloudinary.com/demo/legacy", resource_type: options.resource_type === "auto" ? "raw" : "image", bytes: 4 });
  },
});
cloudinary.uploader.destroy = async () => ({ result: "ok" });

// --- HTTP ----------------------------------------------------------------------------------------------------------
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => {
  server.closeAllConnections();
  server.close();
});

const auth = (user) => ({ Authorization: `Bearer ${signAccessToken({ ...user, email: `${user.role}@test.invalid` }, 0)}` });
const postJson = (path, user, body) =>
  fetch(base + path, { method: "POST", headers: { ...auth(user), "Content-Type": "application/json" }, body: JSON.stringify(body) });
const postForm = (path, user, entries) => {
  const form = new FormData();
  for (const [key, value, name] of entries) name ? form.append(key, value, name) : form.append(key, value);
  return fetch(base + path, { method: "POST", headers: auth(user), body: form });
};
const jpeg = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" });

test("reports: legacy multipart and direct-upload JSON are both accepted", async () => {
  const legacy = await postForm("/api/reports", USERS.reporter, [["images", jpeg(), "a.jpg"], ["description", "Leak"]]);
  assert.equal(legacy.status, 201, await legacy.clone().text());

  const id = directUpload("seefix/reports/direct-1", USERS.reporter, "report-image");
  const direct = await postJson("/api/reports", USERS.reporter, { imagePublicIds: [id], description: "Leak" });
  assert.equal(direct.status, 201, await direct.clone().text());
  assert.ok(db.attached.has(id));

  const both = await postForm("/api/reports", USERS.reporter, [["images", jpeg(), "a.jpg"], ["imagePublicIds", "x"]]);
  assert.equal(both.status, 400);
  assert.equal((await postForm("/api/reports", USERS.reporter, [["description", "no photo"]])).status, 400);
});

test("completion: legacy multipart and direct-upload JSON are both accepted", async () => {
  const path = `/api/work-orders/${WORK_ORDER}/completion`;
  const legacy = await postForm(path, USERS.worker, [["images", jpeg(), "a.jpg"], ["repairNotes", "Fixed"]]);
  assert.equal(legacy.status, 200, await legacy.clone().text());

  const id = directUpload("seefix/work-orders/direct-1", USERS.worker, "completion-image");
  const direct = await postJson(path, USERS.worker, { imagePublicIds: [id], repairNotes: "Fixed" });
  assert.equal(direct.status, 200, await direct.clone().text());
  assert.ok(db.attached.has(id));
});

test("procurement documents: legacy multipart and direct-upload JSON are both accepted", async () => {
  const path = `/api/procurement/handoffs/${HANDOFF}/documents`;
  const pdf = new Blob(["%PDF-1.4"], { type: "application/pdf" });
  const legacy = await postForm(path, USERS.procurement, [["file", pdf, "po.pdf"], ["documentType", "OTHER"]]);
  assert.equal(legacy.status, 201, await legacy.clone().text());

  const id = directUpload("seefix/procurement/direct-1", USERS.procurement, "procurement-document", "raw");
  const direct = await postJson(path, USERS.procurement, { publicId: id, resourceType: "raw", fileName: "po.pdf", documentType: "OTHER" });
  assert.equal(direct.status, 201, await direct.clone().text());
  assert.ok(db.attached.has(id));

  assert.equal((await postJson(path, USERS.procurement, { documentType: "OTHER" })).status, 400);
});

test("concurrent requests attaching the same upload: exactly one succeeds, the other gets 409", async () => {
  // Same Cloudinary asset, tagged for the reporter: two report submissions race for it.
  const id = directUpload("seefix/reports/raced", USERS.reporter, "report-image");
  const responses = await Promise.all([
    postJson("/api/reports", USERS.reporter, { imagePublicIds: [id], description: "first" }),
    postJson("/api/reports", USERS.reporter, { imagePublicIds: [id], description: "second" }),
  ]);
  const statuses = responses.map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, 409]);
  const conflict = await responses.find((r) => r.status === 409).json();
  assert.equal(conflict.error.code, "UPLOAD_ALREADY_USED");
});

test("concurrent requests attaching one upload to different record types: exactly one succeeds", async () => {
  // Tagged for both users and purposes, so only the database check (not the tag check) can stop the second attach.
  const id = directUpload("seefix/shared/cross", USERS.reporter, "report-image");
  resources.get(id).tags.push(ownerTag(USERS.worker.id), purposeTag("completion-image"));
  const [report, completion] = await Promise.all([
    postJson("/api/reports", USERS.reporter, { imagePublicIds: [id], description: "report" }),
    postJson(`/api/work-orders/${WORK_ORDER}/completion`, USERS.worker, { imagePublicIds: [id], repairNotes: "completion" }),
  ]);
  const outcomes = [report.status === 201, completion.status === 200];
  assert.equal(outcomes.filter(Boolean).length, 1, `statuses ${report.status}/${completion.status}`);
  assert.ok([report.status, completion.status].includes(409));
});
