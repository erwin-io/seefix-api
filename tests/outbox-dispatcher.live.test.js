/**
 * Opt-in live tests against PostgreSQL (SEEFIX_INTEGRATION_DB=1).
 * The dispatcher tests run in a throwaway schema copied from dbo."OutboxEvents"
 * (created and dropped here); the notification test runs inside a transaction
 * that is rolled back. No existing rows are read-modified or deleted.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const live = process.env.SEEFIX_INTEGRATION_DB === "1";
// One shared pool for the file; close it once after every test.
after(async () => {
  if (live) await (await import("../src/database.js")).pool.end();
});
const OPTS = { batchSize: 7, leaseSeconds: 30, maxAttempts: 5, baseMs: 60000, maxMs: 600000 };

test("live outbox dispatcher", { skip: !live && "set SEEFIX_INTEGRATION_DB=1" }, async (t) => {
  const { pool } = await import("../src/database.js");
  const { dispatchOnce, claimBatch } = await import("../src/realtime/outbox-dispatcher.js");
  const schema = `seefix_outbox_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const table = `"${schema}"."OutboxEvents"`;
  const q = (sql, p) => pool.query(sql, p);
  await q(`CREATE SCHEMA "${schema}"`);
  await q(`CREATE TABLE ${table} (LIKE "dbo"."OutboxEvents" INCLUDING ALL)`);
  t.after(async () => {
    await q(`DROP SCHEMA "${schema}" CASCADE`);
  });
  const seed = async (n) => {
    for (let i = 0; i < n; i += 1) {
      await q(
        `INSERT INTO ${table} ("AggregateType","AggregateId","Transport","EventName","Payload","CreatedAt") VALUES ('REPORT',$1,'PUSHER','report.test',$2::jsonb,NOW()-make_interval(secs => $3))`,
        [randomUUID(), JSON.stringify({ i }), n - i],
      );
    }
  };
  const status = async () => (await q(`SELECT "Status", COUNT(*)::int n FROM ${table} GROUP BY 1`)).rows;

  await t.test("concurrent dispatchers deliver each event exactly once", async () => {
    await seed(40);
    const seen = [];
    const publish = async (_channels, _event, data) => {
      await new Promise((r) => setTimeout(r, 5));
      seen.push(data.eventId);
    };
    // Four workers, separate pool connections, racing until the queue is empty.
    const worker = async () => {
      for (;;) {
        const r = await dispatchOnce({ q, publish, table, ...OPTS });
        if (!r.claimed) return;
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    assert.equal(seen.length, 40);
    assert.equal(new Set(seen).size, 40, "no duplicates");
    assert.deepEqual(await status(), [{ Status: "SENT", n: 40 }]);
  });

  await t.test("Pusher outage keeps rows PENDING with backoff; they are delivered once it recovers", async () => {
    await q(`DELETE FROM ${table}`);
    await seed(3);
    const down = await dispatchOnce({ q, publish: async () => { throw new Error("pusher down"); }, table, ...OPTS });
    assert.deepEqual(down, { claimed: 3, sent: 0, retried: 3, failed: 0 });
    const rows = (await q(`SELECT "Status","AttemptCount","LastError","NextAttemptAt">NOW() AS later FROM ${table}`)).rows;
    assert.ok(rows.every((r) => r.Status === "PENDING" && r.AttemptCount === 1 && r.LastError === "pusher down" && r.later));
    assert.equal((await dispatchOnce({ q, publish: async () => {}, table, ...OPTS })).claimed, 0, "not before backoff");
    await q(`UPDATE ${table} SET "NextAttemptAt"=NOW()-interval '1 second'`); // fast-forward the backoff
    assert.equal((await dispatchOnce({ q, publish: async () => {}, table, ...OPTS })).sent, 3);
  });

  await t.test("a crashed worker's lease is reclaimed, and the stale worker cannot overwrite it", async () => {
    await q(`DELETE FROM ${table}`);
    await seed(1);
    const [stale] = await claimBatch(q, { table, ...OPTS }); // worker A claims, then "crashes"
    assert.equal((await claimBatch(q, { table, ...OPTS })).length, 0, "lease blocks others");
    await q(`UPDATE ${table} SET "NextAttemptAt"=NOW()-interval '1 second'`); // lease expires
    const r = await dispatchOnce({ q, publish: async () => {}, table, ...OPTS }); // worker B recovers it
    assert.equal(r.sent, 1);
    // Worker A wakes up and tries to report failure for its old attempt: guarded, no effect.
    await q(`UPDATE ${table} SET "Status"='PENDING' WHERE "Id"=$1 AND "Status"='PROCESSING' AND "AttemptCount"=$2`, [stale.Id, stale.AttemptCount]);
    const after = (await q(`SELECT "Status","AttemptCount" FROM ${table}`)).rows[0];
    assert.deepEqual(after, { Status: "SENT", AttemptCount: 2 });
  });
});

test("live: notification outbox row commits and rolls back with its transaction", { skip: !live && "set SEEFIX_INTEGRATION_DB=1" }, async () => {
  const { pool } = await import("../src/database.js");
  const { createNotification } = await import("../src/services/notifications.js");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const user = (await client.query(`SELECT "Id" FROM "dbo"."Users" WHERE "IsActive"=TRUE LIMIT 1`)).rows[0];
    const n = await createNotification(client, { userId: user.Id, type: "TEST", title: "t", message: "m" });
    const outbox = (await client.query(`SELECT "Transport","RecipientUserId","EventName","Payload","Status" FROM "dbo"."OutboxEvents" WHERE "DeduplicationKey"=$1`, [`notification:${n.id}:created`])).rows;
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].Transport, "PUSHER");
    assert.equal(outbox[0].RecipientUserId, user.Id);
    assert.equal(outbox[0].EventName, "notification.created");
    assert.equal(outbox[0].Status, "PENDING");
    assert.deepEqual(Object.keys(outbox[0].Payload).sort(), ["entityId", "entityType", "notificationId", "type"]);
    await client.query("ROLLBACK");
    const gone = await client.query(`SELECT 1 FROM "dbo"."OutboxEvents" WHERE "DeduplicationKey"=$1`, [`notification:${n.id}:created`]);
    assert.equal(gone.rowCount, 0, "rolled back with the business transaction");
  } finally {
    client.release();
  }
});
