/**
 * Opt-in live check against PostgreSQL (SEEFIX_INTEGRATION_DB=1), after db/migrations/2026-10-14-report-client-id.sql.
 * Commits nothing: every insert happens inside a transaction that is rolled back.
 * Proves the (ReporterId, ClientReportId) unique index makes a concurrent duplicate wait and then fail, and that the
 * replay lookup query runs on the real schema.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const live = process.env.SEEFIX_INTEGRATION_DB === "1";

test("live: one report per (Reporter, clientReportId), concurrent duplicates wait then fail", { skip: !live && "set SEEFIX_INTEGRATION_DB=1" }, async (t) => {
  const { pool } = await import("../src/database.js");
  const { findClientReport } = await import("../src/services/report-service.js");
  const a = await pool.connect();
  const b = await pool.connect();
  t.after(async () => {
    a.release();
    b.release();
    await pool.end();
  });

  const reporter = (await a.query(`SELECT "Id" FROM "dbo"."Users" WHERE "Role"='REPORTER' LIMIT 1`)).rows[0];
  assert.ok(reporter, "needs one REPORTER user");
  const clientReportId = randomUUID();
  const hash = "a".repeat(64);
  // CANCELLED keeps the one-active-report index out of the way, and an explicit ReportNo keeps the ReportNo
  // index out of it too: only the new index is under test.
  const insert = (c) =>
    c.query(
      `INSERT INTO "dbo"."Reports" ("ReportNo","ReporterId","Description","Status","ClientReportId","ClientRequestHash")
       VALUES ($1,$2,'live idempotency test (rolled back)','CANCELLED',$3,$4) RETURNING "Id"`,
      [`LIVE-${randomUUID().slice(0, 8)}`, reporter.Id, clientReportId, hash],
    );

  await a.query("BEGIN");
  await b.query("BEGIN");
  const first = await insert(a);
  let bDone = false;
  const second = insert(b).then(
    () => (bDone = "inserted"),
    (error) => (bDone = error.code),
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(bDone, false, "the duplicate insert waits while the first transaction is open");

  // The replay lookup sees the first transaction's own row on the real schema.
  const found = await findClientReport(a.query.bind(a), reporter.Id, clientReportId, hash);
  assert.equal(found.id, first.rows[0].Id);
  assert.equal(found.replayed, true);
  await assert.rejects(findClientReport(a.query.bind(a), reporter.Id, clientReportId, "b".repeat(64)), { code: "CLIENT_REPORT_ID_CONFLICT" });

  await a.query("ROLLBACK");
  await second;
  assert.equal(bDone, "inserted", "after the first rolls back, the second may insert");

  await b.query("SAVEPOINT dup");
  await assert.rejects(insert(b), (error) => error.code === "23505" && /ClientReportId/i.test(error.constraint));
  await b.query("ROLLBACK TO SAVEPOINT dup");
  await b.query("ROLLBACK");
});
