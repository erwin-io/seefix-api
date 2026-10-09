import test from "node:test";
import assert from "node:assert/strict";
import { backoffMs, claimBatch, dispatchOnce } from "../src/realtime/outbox-dispatcher.js";

const OPTS = { batchSize: 10, leaseSeconds: 30, maxAttempts: 3, baseMs: 1000, maxMs: 8000 };
const RID = "11111111-1111-4111-8111-111111111111";

/** Fake query that returns `claimed` for the claim and records every outcome UPDATE. */
function harness(claimed) {
  const updates = [];
  const q = async (sql, params) => {
    if (sql.includes("FOR UPDATE SKIP LOCKED")) return { rows: claimed, rowCount: claimed.length };
    if (sql.startsWith("UPDATE")) {
      updates.push({ status: sql.includes("'SENT'") ? "SENT" : params[2], params });
      return { rowCount: 1, rows: [] };
    }
    return { rows: [], rowCount: 0 };
  };
  return { q, updates };
}
const row = (over = {}) => ({ Id: "e1", AggregateType: "REPORT", AggregateId: RID, EventName: "report.assessment.completed", Payload: { reportId: RID }, AttemptCount: 1, ...over });

test("backoff doubles per attempt and is capped", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => backoffMs(n, OPTS)), [1000, 2000, 4000, 8000, 8000]);
});

test("success publishes to the private channel with eventId, then marks SENT for that attempt only", async () => {
  const { q, updates } = harness([row()]);
  const sent = [];
  const r = await dispatchOnce({ q, publish: async (...a) => sent.push(a), ...OPTS });
  assert.deepEqual(r, { claimed: 1, sent: 1, retried: 0, failed: 0 });
  assert.deepEqual(sent[0], [[`private-report-${RID}`], "report.assessment.completed", { reportId: RID, eventId: "e1" }]);
  assert.equal(updates[0].status, "SENT");
  assert.deepEqual(updates[0].params, ["e1", 1], "guarded by Id + AttemptCount");
});

test("Pusher outage keeps the row: back to PENDING with backoff, nothing lost", async () => {
  const { q, updates } = harness([row({ AttemptCount: 2 })]);
  const r = await dispatchOnce({ q, publish: async () => { throw new Error("ECONNRESET"); }, ...OPTS });
  assert.deepEqual(r, { claimed: 1, sent: 0, retried: 1, failed: 0 });
  assert.equal(updates[0].status, "PENDING");
  assert.equal(updates[0].params[3], "ECONNRESET");
  assert.equal(updates[0].params[4], 2, "2nd attempt waits 2s");
});

test("gives up as FAILED after maxAttempts (row kept for inspection)", async () => {
  const { q, updates } = harness([row({ AttemptCount: 3 })]);
  const r = await dispatchOnce({ q, publish: async () => { throw new Error("401"); }, ...OPTS });
  assert.equal(r.failed, 1);
  assert.equal(updates[0].status, "FAILED");
});

test("unroutable rows are FAILED immediately and never published", async () => {
  const { q, updates } = harness([row({ AggregateType: "UNKNOWN", ChannelName: "public-broadcast" })]);
  let published = false;
  const r = await dispatchOnce({ q, publish: async () => { published = true; }, ...OPTS });
  assert.equal(published, false);
  assert.equal(r.failed, 1);
  assert.equal(updates[0].status, "FAILED");
});

test("claim query uses SKIP LOCKED, a lease, PUSHER-only rows and reclaims expired leases", async () => {
  let captured;
  await claimBatch(async (sql, params) => ((captured = { sql, params }), { rows: [] }), OPTS);
  assert.match(captured.sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(captured.sql, /"Transport"='PUSHER'/);
  assert.match(captured.sql, /"Status"='PROCESSING' AND "NextAttemptAt"<=NOW\(\)/);
  assert.deepEqual(captured.params, [10, 30]);
});
