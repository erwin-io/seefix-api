import test from "node:test";
import assert from "node:assert/strict";
import {
  displayPriority,
  isActionableReport,
  presentAgentStatus,
  presentReport,
  reportScreening,
} from "../src/services/report-presentation.js";

const normal = Object.freeze({
  Id: "report-clean",
  Status: "PENDING_REVIEW",
  AgentStatus: "COMPLETED",
  ScopeDecision: "No Visible Maintenance Issue",
  ScopeShouldAnalyze: false,
  PriorityScore: null,
  LivePriorityScore: 0,
  AgentLastError: null,
});

test("clean image remains in existing human-review state; no fake priority zero", () => {
  const output = presentReport(normal, { reporter: true });
  assert.equal(output.Status, "PENDING_REVIEW");
  assert.equal(output.LivePriorityScore, null);
  assert.equal(output.screening.code, "NO_VISIBLE_ISSUE");
  assert.equal(output.screening.needsMaintenanceReview, true);
  assert.equal(output.screening.nextAction, "WAIT_FOR_MAINTENANCE_REVIEW");
  assert.equal(output.screening.isActionable, false);
});

test("a valid facility issue retains its actual non-zero priority", () => {
  const issue = {
    Status: "PENDING_REVIEW", AgentStatus: "COMPLETED",
    ScopeDecision: "Facility Issue", ScopeShouldAnalyze: true,
    PriorityScore: 75, LivePriorityScore: 90,
  };
  assert.equal(isActionableReport(issue), true);
  assert.equal(displayPriority(issue, 90), 90);
  assert.equal(presentReport(issue).LivePriorityScore, 90);
  assert.equal(reportScreening(issue).code, "FACILITY_ISSUE");
});

test("human NO_ACTION remains a human decision, not AI automatic rejection", () => {
  const result = reportScreening({ ...normal, Status: "NO_ACTION" });
  assert.equal(result.code, "HUMAN_NO_ACTION");
  assert.equal(result.source, "MAINTENANCE_REVIEW");
  assert.equal(result.nextAction, "NONE");
});

test("human DUPLICATE remains a human decision", () => {
  const result = reportScreening({ ...normal, Status: "DUPLICATE" });
  assert.equal(result.code, "HUMAN_DUPLICATE");
});

test("out-of-scope and insufficient image are routed for human review with readable copy", () => {
  for (const [scope,code] of [
    ["Out of Scope", "OUT_OF_SCOPE"],
    ["Insufficient Image", "INSUFFICIENT_IMAGE"],
  ]) {
    const result=reportScreening({ ...normal, ScopeDecision: scope });
    assert.equal(result.code, code);
    assert.equal(result.nextAction, "WAIT_FOR_MAINTENANCE_REVIEW");
    assert.ok(!result.message.includes("Pydantic"));
  }
});

test("Reporter never receives Ollama or Pydantic raw errors", () => {
  const technical = "Ollama returned Pydantic ValidationError: secret traceback";
  const failed = { ...normal, AgentStatus: "FAILED", AgentLastError: technical };
  const output = presentReport(failed, { reporter: true });
  assert.equal(output.AgentLastError, null);
  assert.equal(output.screening.code, "AGENT_PROCESSING_FAILED");
  assert.equal(output.screening.nextAction, "CONTACT_SUPPORT");
  assert.ok(!JSON.stringify(output.screening).includes("Pydantic"));
  const status = presentAgentStatus({ agentStatus:"FAILED", lastError:technical }, failed, { reporter: true });
  assert.equal(status.lastError, null);
  assert.equal(status.screening.code, "AGENT_PROCESSING_FAILED");
  const staffStatus = presentAgentStatus({lastError: technical}, failed, { reporter:false });
  assert.equal(staffStatus.lastError, technical);
});

test("pending status never claims Agent assessment succeeded", () => {
  const pending=reportScreening({ Status:"SUBMITTED", AgentStatus:"PENDING" });
  assert.equal(pending.code,"ASSESSMENT_PENDING");
  assert.equal(pending.needsMaintenanceReview,false);
});

test("camelCase list fields display priority as null when scope is not actionable", () => {
  const row = { status:"PENDING_REVIEW",agentStatus:"COMPLETED",scopeDecision:"No Visible Maintenance Issue",scopeShouldAnalyze:false,priorityScore:0 };
  assert.equal(presentReport(row).priorityScore, null);
  assert.equal(presentReport({ ...row,scopeDecision:"Facility Issue",scopeShouldAnalyze:true,priorityScore:0 }).priorityScore, 0);
});
