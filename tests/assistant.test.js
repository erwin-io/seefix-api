/**
 * Assistant boundary rules without a database (seefix-api#21). Live behaviour: tests/assistant.live.test.js.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyAction, PROHIBITED_ACTIONS, ACTION_ROLES, INTERNAL_ROLES, canRemind, sanitizeAnswer, fallbackAnswer,
  navigationFor, runAction, toolCatalog,
} from "../src/services/assistant-service.js";

test("every prohibited workflow action is refused for every role, ADMIN included", () => {
  for (const role of INTERNAL_ROLES) {
    for (const action of [...PROHIBITED_ACTIONS, "approve_maintenance_request", "authorise_handoff", "completeWorkOrder", "mark_rework"]) {
      assert.throws(() => classifyAction(action, role), { status: 403, code: "ASSISTANT_ACTION_PROHIBITED" }, `${role} ${action}`);
    }
  }
});

test("unknown actions are 400; allowed actions follow their role list", () => {
  assert.throws(() => classifyAction("drop_table", "ADMIN"), { status: 400, code: "UNKNOWN_ACTION" });
  assert.throws(() => classifyAction("", "ADMIN"), { code: "UNKNOWN_ACTION" });
  assert.throws(() => classifyAction("__proto__", "ADMIN"), { code: "UNKNOWN_ACTION" });
  assert.equal(classifyAction("create_reminder", "WORKER"), "create_reminder");
  assert.throws(() => classifyAction("request_reassessment", "WORKER"), { status: 403, code: "FORBIDDEN" });
  assert.throws(() => classifyAction("request_reassessment", "PROCUREMENT"), { status: 403 });
  assert.equal(classifyAction("request_reassessment", "MAINTENANCE_STAFF"), "request_reassessment");
  for (const action of Object.keys(ACTION_ROLES)) assert.ok(!PROHIBITED_ACTIONS.includes(action));
});

test("nothing is written without confirm: true (and the boundary is checked first)", async () => {
  const user = { id: "00000000-0000-0000-0000-000000000001", role: "MAINTENANCE_SUPERVISOR" };
  for (const confirm of [undefined, false, "true", 1]) {
    const out = await runAction(user, { action: "request_reassessment", params: { reportId: "x" }, confirm });
    assert.equal(out.status, "CONFIRMATION_REQUIRED");
    assert.match(out.preview, /never changed/);
  }
  await assert.rejects(runAction(user, { action: "complete_work_order", confirm: true }), { code: "ASSISTANT_ACTION_PROHIBITED" });
  await assert.rejects(runAction(user, { action: "create_reminder", params: {}, confirm: true }), { code: "INVALID_VALUE" }, "a confirmed create needs a UUID idempotencyKey");
});

test("reminder recipients: self, supervisor → staff/worker, admin → any internal; never reporter or inactive", () => {
  const u = (id, Role, IsActive = true) => ({ Id: id, Role, IsActive });
  const me = (role) => ({ id: "me", role });
  assert.ok(canRemind(me("WORKER"), u("me", "WORKER")));
  assert.ok(!canRemind(me("WORKER"), u("other", "WORKER")));
  assert.ok(!canRemind(me("MAINTENANCE_STAFF"), u("other", "WORKER")));
  assert.ok(canRemind(me("MAINTENANCE_SUPERVISOR"), u("other", "WORKER")));
  assert.ok(canRemind(me("MAINTENANCE_SUPERVISOR"), u("other", "MAINTENANCE_STAFF")));
  assert.ok(!canRemind(me("MAINTENANCE_SUPERVISOR"), u("other", "ADMIN")));
  assert.ok(!canRemind(me("MAINTENANCE_SUPERVISOR"), u("other", "PROCUREMENT")));
  assert.ok(canRemind(me("ADMIN"), u("other", "PROCUREMENT")));
  assert.ok(!canRemind(me("ADMIN"), u("other", "REPORTER")));
  assert.ok(!canRemind(me("ADMIN"), u("other", "WORKER", false)));
  assert.ok(!canRemind(me("ADMIN"), undefined), "unknown user");
});

const facts = [
  { id: "report:abc", kind: "report", label: "RPT-1", navigation: "/reports/abc", data: {} },
  { id: "summary:current", kind: "summary", label: "Summary", navigation: "/dashboard", data: {} },
];

test("Agent answers are re-checked: unknown fact ids and foreign paths are dropped", () => {
  const out = sanitizeAnswer({
    status: "ANSWERED", answer: "See RPT-1.", citedFactIds: ["report:abc", "report:evil", "report:abc"],
    navigation: [{ factId: "report:abc", path: "https://evil.example/x" }, { factId: "user:1", path: "/admin/users" }],
    model: "m", promptVersion: "assistant-v1", processingTimeMs: 5,
  }, facts);
  assert.deepEqual(out.citedFactIds, ["report:abc"]);
  assert.deepEqual(out.navigation, [{ factId: "report:abc", path: "/reports/abc", label: "RPT-1" }], "path comes from our fact");
  assert.equal(sanitizeAnswer({ status: "APPROVED", answer: "x" }, facts), null, "unknown status → fallback");
  assert.equal(sanitizeAnswer(null, facts), null);
});

test("fallback cites every fact with the API's own navigation", () => {
  const out = fallbackAnswer(facts, "AGENT_TIMEOUT");
  assert.equal(out.status, "FALLBACK");
  assert.equal(out.fallbackReason, "AGENT_TIMEOUT");
  assert.deepEqual(out.citedFactIds, ["report:abc", "summary:current"]);
  assert.equal(out.navigation.length, 2);
});

test("navigation targets follow the web-admin route guards", () => {
  const paths = (role) => navigationFor(role).map((n) => n.path);
  assert.ok(paths("ADMIN").includes("/admin/users"));
  assert.ok(!paths("MAINTENANCE_SUPERVISOR").includes("/admin/users"));
  assert.deepEqual(paths("WORKER"), ["/dashboard", "/work-orders", "/notifications", "/account"]);
  assert.deepEqual(paths("PROCUREMENT"), ["/dashboard", "/procurement/inbox", "/notifications", "/account"]);
  assert.deepEqual(paths("REPORTER"), []);
  assert.deepEqual(toolCatalog("WORKER").actions.allowed, ["save_draft", "discard_draft", "create_reminder", "cancel_reminder"]);
});
