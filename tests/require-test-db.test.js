import test from "node:test";
import assert from "node:assert/strict";
import { requireTestDatabase } from "./helpers/require-test-db.js";

test("live tests refuse non-local databases unless the exact target is confirmed", () => {
  const saved = process.env.SEEFIX_TEST_DB_CONFIRM;
  try {
    delete process.env.SEEFIX_TEST_DB_CONFIRM;
    assert.equal(requireTestDatabase("postgresql://u:p@127.0.0.1:5432/seefix_v2_dev"), "127.0.0.1/seefix_v2_dev");
    assert.equal(requireTestDatabase("postgresql://u:p@localhost/db"), "localhost/db");
    assert.throws(() => requireTestDatabase("postgresql://u:p@ep-x-pooler.us-east-2.aws.neon.tech/seefixdb?sslmode=require"), /Refusing/);
    assert.throws(() => requireTestDatabase(""), /DATABASE_URL/);
    process.env.SEEFIX_TEST_DB_CONFIRM = "ep-branch.neon.tech/seefixdb";
    assert.equal(requireTestDatabase("postgresql://u:p@ep-branch.neon.tech/seefixdb"), "ep-branch.neon.tech/seefixdb");
    assert.throws(() => requireTestDatabase("postgresql://u:p@ep-prod.neon.tech/seefixdb"), /Refusing/, "confirm must match exactly");
  } finally {
    if (saved === undefined) delete process.env.SEEFIX_TEST_DB_CONFIRM;
    else process.env.SEEFIX_TEST_DB_CONFIRM = saved;
  }
});
