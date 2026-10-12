/**
 * Opt-in live check against PostgreSQL (SEEFIX_INTEGRATION_DB=1). Writes nothing: both transactions only take the
 * upload lock and run the read-only "already used" check, then roll back.
 * Proves a second transaction claiming the same public ID waits until the first one ends.
 */
import test from "node:test";
import assert from "node:assert/strict";

const live = process.env.SEEFIX_INTEGRATION_DB === "1";

test("live: lockUnusedUploads serializes transactions claiming the same upload", { skip: !live && "set SEEFIX_INTEGRATION_DB=1" }, async (t) => {
  const { pool } = await import("../src/database.js");
  const { lockUnusedUploads } = await import("../src/direct-uploads.js");
  const a = await pool.connect();
  const b = await pool.connect();
  t.after(async () => {
    a.release();
    b.release();
    await pool.end();
  });
  const id = `seefix/test/lock-${Date.now()}`;

  await a.query("BEGIN");
  await b.query("BEGIN");
  await lockUnusedUploads(a, [id]);
  let bDone = false;
  const bClaim = lockUnusedUploads(b, [id]).then(() => (bDone = true));
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(bDone, false, "second transaction must wait while the first holds the lock");

  await a.query("ROLLBACK");
  await bClaim;
  assert.equal(bDone, true, "second transaction continues once the first ends");
  await b.query("ROLLBACK");

  // A different upload is not blocked by an unrelated lock.
  await a.query("BEGIN");
  await lockUnusedUploads(a, [id]);
  await b.query("BEGIN");
  await lockUnusedUploads(b, [`${id}-other`]);
  await Promise.all([a.query("ROLLBACK"), b.query("ROLLBACK")]);
});
