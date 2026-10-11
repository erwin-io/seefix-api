/**
 * Assessment work (initial report AI, completion AI) is queued in the database, never pushed to the Agent:
 * the API saves PENDING rows, the Agent claims them, seefix-worker's agent-retry job re-queues failures.
 * Interactive previews (maintenance request draft, procurement package, work order preview/review,
 * clarification draft) and /health stay direct calls on purpose.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { agentClient } from "../src/agent-client.js";

const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

test("the Agent client exposes no assessment trigger or status call", () => {
  for (const name of ["processReport", "reportStatus", "processCompletion", "completionStatus"]) {
    assert.equal(agentClient[name], undefined, `${name} must not exist`);
  }
  assert.deepEqual(Object.keys(agentClient).sort(), [
    "draftClarification", "generateMaintenanceRequest", "health", "previewInternalWorkOrder",
    "previewProcurementPackage", "previewProcurementWorkOrder", "reviewWorkOrder", "runMonitor",
  ]);
});

test("report creation, completion submission and both status routes don't call the Agent", () => {
  for (const file of ["services/report-service.js", "routes/reports.js", "routes/work-orders.js"]) {
    assert.doesNotMatch(src(file), /agent-client\.js|agentClient|bestEffort/, `${file} must use the database queue only`);
  }
});

test("status routes answer from the database", () => {
  assert.match(src("routes/reports.js"), /"AgentStatus" AS "agentStatus"[\s\S]*source: "database"/);
  assert.match(src("routes/work-orders.js"), /"CompletionAgentStatus" AS "completionAgentStatus"[\s\S]*source: "database"/);
});
