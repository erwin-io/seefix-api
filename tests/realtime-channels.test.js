import test from "node:test";
import assert from "node:assert/strict";
import { canSubscribe, parseChannel, resolveChannels } from "../src/realtime/channels.js";

const R = "11111111-1111-4111-8111-111111111111";
const U = "22222222-2222-4222-8222-222222222222";
const W = "33333333-3333-4333-8333-333333333333";
const H = "44444444-4444-4444-8444-444444444444";

/** Fake query: answers "has access" lookups from a set of [sqlFragment, ...params] facts. */
function fakeQ(facts = []) {
  return async (sql, params) => {
    const hit = facts.find(([frag, ...p]) => sql.includes(frag) && p.every((v, i) => params[i] === v));
    if (sql.includes('FROM "dbo"."MaintenanceRequests" WHERE "Id"')) return { rows: hit ? [{ ReportId: R }] : [], rowCount: hit ? 1 : 0 };
    if (sql.includes('FROM "dbo"."ProcurementClarifications"')) return { rows: hit ? [{ ProcurementHandoffId: H }] : [], rowCount: hit ? 1 : 0 };
    return { rows: hit ? [{}] : [], rowCount: hit ? 1 : 0 };
  };
}

test("parseChannel accepts only the four private UUID channel types", () => {
  assert.deepEqual(parseChannel(`private-report-${R}`), { type: "report", id: R });
  assert.deepEqual(parseChannel(`private-work-order-${W}`), { type: "work-order", id: W });
  for (const bad of [`report-${R}`, `presence-user-${U}`, `private-user-${U}x`, `private-role-ADMIN`, `private-user-*`, "", null]) {
    assert.equal(parseChannel(bad), null, String(bad));
  }
});

test("resolveChannels routes outbox rows server-side and never broadcasts unknown rows", async () => {
  const q = fakeQ([['"MaintenanceRequests"', "mr"], ['"ProcurementClarifications"', "pc"]]);
  assert.deepEqual(await resolveChannels({ RecipientUserId: U, AggregateType: "NOTIFICATION" }, q), [`private-user-${U}`]);
  assert.deepEqual(await resolveChannels({ ChannelName: `report-${R}`, AggregateType: "MAINTENANCE_REQUEST" }, q), [`private-report-${R}`]);
  assert.deepEqual(await resolveChannels({ ChannelName: `work-order-${W}`, AggregateType: "WORK_ORDER" }, q), [`private-work-order-${W}`]);
  assert.deepEqual(await resolveChannels({ AggregateType: "WORK_ORDER", AggregateId: W }, q), [`private-work-order-${W}`]);
  assert.deepEqual(await resolveChannels({ AggregateType: "MAINTENANCE_REQUEST", AggregateId: "mr" }, q), [`private-report-${R}`]);
  assert.deepEqual(await resolveChannels({ AggregateType: "PROCUREMENT_CLARIFICATION", AggregateId: "pc" }, q), [`private-handoff-${H}`]);
  assert.deepEqual(await resolveChannels({ AggregateType: "PROCUREMENT_CLARIFICATION", AggregateId: "missing" }, q), []);
  assert.deepEqual(await resolveChannels({ AggregateType: "SOMETHING_ELSE", AggregateId: R, ChannelName: "public-anything" }, q), []);
});

test("canSubscribe: user channel is self-only", async () => {
  const q = fakeQ();
  assert.equal(await canSubscribe({ id: U, role: "WORKER" }, `private-user-${U}`, q), true);
  assert.equal(await canSubscribe({ id: U, role: "ADMIN" }, `private-user-${W}`, q), false);
  assert.equal(await canSubscribe(null, `private-user-${U}`, q), false);
});

test("canSubscribe: report channel mirrors GET /api/reports/:id scoping", async () => {
  const q = fakeQ([['"Reports" WHERE "Id"=$1 AND "ReporterId"', R, U], ['"WorkOrders" WHERE "ReportId"', R, W]]);
  const ch = `private-report-${R}`;
  for (const role of ["MAINTENANCE_STAFF", "MAINTENANCE_SUPERVISOR", "ADMIN"]) assert.equal(await canSubscribe({ id: "x", role }, ch, q), true, role);
  assert.equal(await canSubscribe({ id: U, role: "REPORTER" }, ch, q), true, "owner");
  assert.equal(await canSubscribe({ id: W, role: "REPORTER" }, ch, q), false, "another reporter");
  assert.equal(await canSubscribe({ id: W, role: "WORKER" }, ch, q), true, "lead on a linked work order");
  assert.equal(await canSubscribe({ id: U, role: "WORKER" }, ch, q), false, "unrelated worker");
  assert.equal(await canSubscribe({ id: U, role: "PROCUREMENT" }, ch, q), false, "no linked handoff");
});

test("canSubscribe: work-order channel is maintenance or responsible lead; handoff is procurement/maintenance", async () => {
  const q = fakeQ([['"WorkOrders" WHERE "Id"=$1 AND "ResponsibleLeadUserId"', W, U]]);
  assert.equal(await canSubscribe({ id: U, role: "WORKER" }, `private-work-order-${W}`, q), true);
  assert.equal(await canSubscribe({ id: R, role: "WORKER" }, `private-work-order-${W}`, q), false);
  assert.equal(await canSubscribe({ id: U, role: "PROCUREMENT" }, `private-work-order-${W}`, q), false);
  assert.equal(await canSubscribe({ id: U, role: "PROCUREMENT" }, `private-handoff-${H}`, q), true);
  assert.equal(await canSubscribe({ id: U, role: "WORKER" }, `private-handoff-${H}`, q), false);
  assert.equal(await canSubscribe({ id: U, role: "REPORTER" }, `private-handoff-${H}`, q), false);
});
