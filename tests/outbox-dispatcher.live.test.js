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
const OPTS = { batchSize: 7, leaseSeconds: 30, maxAttempts: 5, baseMs: 60000, maxMs: 600000, maxAgeMinutes: 60 };

test("live outbox dispatcher", { skip: !live && "set SEEFIX_INTEGRATION_DB=1" }, async (t) => {
  const { pool } = await import("../src/database.js");
  const { dispatchOnce, claimBatch, countStale } = await import("../src/realtime/outbox-dispatcher.js");
  const schema = `seefix_outbox_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const table = `"${schema}"."OutboxEvents"`;
  const q = (sql, p) => pool.query(sql, p);
  await q(`CREATE SCHEMA "${schema}"`);
  await q(`CREATE TABLE ${table} (LIKE "dbo"."OutboxEvents" INCLUDING ALL)`);
  // Enforce the strictest shipped Status CHECK (schema 2026-09-16), not whatever the dev DB allows.
  await q(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS "CK_OutboxEvents_Status"`);
  await q(`ALTER TABLE ${table} ADD CONSTRAINT "CK_OutboxEvents_Status" CHECK ("Status" IN ('PENDING','PROCESSING','SENT','FAILED'))`);
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
    assert.deepEqual(down, { claimed: 3, sent: 0, retried: 3, failed: 0, expired: 0 });
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

  await t.test("the throwaway table enforces the 2026-09-16 Status CHECK", async () => {
    await assert.rejects(
      q(`INSERT INTO ${table} ("AggregateType","AggregateId","Transport","EventName","Payload","Status") VALUES ('REPORT',$1,'PUSHER','x','{}','CANCELLED')`, [randomUUID()]),
      (e) => e.code === "23514",
    );
  });

  await t.test("a lease that lapses after the row passed max age is FAILED as expired, never stuck or published", async () => {
    await q(`DELETE FROM ${table}`);
    await seed(2); // i=0: crashes near the age cutoff; i=1: fresh control that crashes too
    const claimed = await claimBatch(q, { table, ...OPTS }); // worker A claims both, then dies
    assert.equal(claimed.length, 2);
    const old = claimed.find((r) => r.Payload.i === 0);
    // Time passes: the old row crosses the 60-minute cap while its lease is held, then both leases lapse.
    await q(`UPDATE ${table} SET "CreatedAt"=NOW()-interval '61 minutes' WHERE "Id"=$1`, [old.Id]);
    await q(`UPDATE ${table} SET "NextAttemptAt"=NOW()-interval '1 second'`);
    const published = [];
    const r = await dispatchOnce({ q, publish: async (_c, _e, d) => void published.push(d.i), table, ...OPTS });
    assert.deepEqual(published, [1], "only the fresh control row is re-sent");
    assert.equal(r.expired, 1);
    const rows = (await q(`SELECT ("Payload"->>'i')::int i,"Status","LastError" FROM ${table} ORDER BY 1`)).rows;
    assert.equal(rows[0].Status, "FAILED");
    assert.match(rows[0].LastError, /expired/);
    assert.equal(rows[1].Status, "SENT");
    assert.equal((await q(`SELECT COUNT(*)::int n FROM ${table} WHERE "Status"='PROCESSING'`)).rows[0].n, 0, "nothing left PROCESSING");
    // Worker A wakes and reports success for its old attempt: guarded, no effect.
    await q(`UPDATE ${table} SET "Status"='SENT' WHERE "Id"=$1 AND "Status"='PROCESSING' AND "AttemptCount"=$2`, [old.Id, old.AttemptCount]);
    assert.equal((await q(`SELECT "Status" FROM ${table} WHERE "Id"=$1`, [old.Id])).rows[0].Status, "FAILED");
    // An unexpired lease on an old row is left to its owner (it may still be publishing).
    await q(`DELETE FROM ${table}`);
    await seed(1);
    await claimBatch(q, { table, ...OPTS });
    await q(`UPDATE ${table} SET "CreatedAt"=NOW()-interval '61 minutes'`);
    assert.equal((await dispatchOnce({ q, publish: async () => {}, table, ...OPTS })).expired, 0);
    assert.equal((await q(`SELECT "Status" FROM ${table}`)).rows[0].Status, "PROCESSING");
  });

  await t.test("rows older than maxAgeMinutes are never claimed and stay untouched", async () => {
    await q(`DELETE FROM ${table}`);
    await seed(2);
    await q(`UPDATE ${table} SET "CreatedAt"=NOW()-interval '2 hours' WHERE ("Payload"->>'i')::int=0`);
    const r = await dispatchOnce({ q, publish: async () => {}, table, ...OPTS });
    assert.deepEqual(r, { claimed: 1, sent: 1, retried: 0, failed: 0, expired: 0 });
    const rows = (await q(`SELECT "Status","AttemptCount" FROM ${table} ORDER BY "CreatedAt"`)).rows;
    assert.deepEqual(rows, [{ Status: "PENDING", AttemptCount: 0 }, { Status: "SENT", AttemptCount: 1 }]);
    assert.equal(await countStale(q, { table, ...OPTS }), 1, "stale rows are visible to operators");
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
