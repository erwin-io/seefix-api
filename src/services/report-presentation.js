/**
 * Reporter-friendly, deterministic presentation of existing SEEFIX report states.
 *
 * This module does not change Report.Status, AgentStatus, scope decisions,
 * routing permissions, database contents, or Agent execution behavior.
 * Model explanation/Agent errors are NEVER presented as trusted user copy.
 */

function firstDefined(row, ...keys) {
  for (const key of keys) {
    if (row?.[key] !== undefined) return row[key];
  }
  return null;
}

function reportFields(row) {
  return {
    status: firstDefined(row, "Status", "status", "businessStatus", "ReportStatus"),
    agentStatus: firstDefined(row, "AgentStatus", "agentStatus"),
    scopeDecision: firstDefined(row, "ScopeDecision", "scopeDecision", "ScreeningScopeDecision"),
    scopeShouldAnalyze: firstDefined(row, "ScopeShouldAnalyze", "scopeShouldAnalyze", "ScreeningShouldAnalyze"),
    priorityScore: firstDefined(row, "PriorityScore", "storedPriorityScore", "StoredPriorityScore"),
  };
}

export function isActionableReport(row) {
  const f = reportFields(row);
  return f.status !== "CANCELLED" && f.agentStatus === "COMPLETED" &&
    f.scopeDecision === "Facility Issue" &&
    f.scopeShouldAnalyze !== false;
}

/** Null means not assessed. This is NOT the same as a genuine 0 priority. */
export function displayPriority(row, livePriority) {
  return isActionableReport(row) ? (livePriority ?? null) : null;
}

export function reportScreening(row) {
  const { status, agentStatus, scopeDecision } = reportFields(row);

  // A Reporter cancellation is final, even when an old Agent attempt is still running.
  if (status === "CANCELLED") {
    return {
      code: "REPORTER_CANCELLED",
      title: "Report cancelled",
      message: "You cancelled this report before maintenance processing began. No maintenance work will be initiated from this report.",
      nextAction: "NONE",
      source: "REPORTER",
      needsMaintenanceReview: false,
      isActionable: false,
    };
  }

  // Final human decisions outrank preliminary AI screening in the user copy.
  if (status === "NO_ACTION") {
    return {
      code: "HUMAN_NO_ACTION",
      title: "No maintenance action required",
      message: "The Maintenance Team reviewed your report and determined that no corrective maintenance is required at this time.",
      nextAction: "NONE",
      source: "MAINTENANCE_REVIEW",
      needsMaintenanceReview: false,
      isActionable: false,
    };
  }
  if (status === "DUPLICATE") {
    return {
      code: "HUMAN_DUPLICATE",
      title: "Related report already exists",
      message: "The Maintenance Team linked this submission to an existing report.",
      nextAction: "NONE",
      source: "MAINTENANCE_REVIEW",
      needsMaintenanceReview: false,
      isActionable: false,
    };
  }

  if (agentStatus === "FAILED") {
    return {
      code: "AGENT_PROCESSING_FAILED",
      title: "We couldn't finish the assessment",
      message: "Your report was saved, but its automated assessment could not be completed. Please contact support if the issue persists. You do not need to create a duplicate report.",
      nextAction: "CONTACT_SUPPORT",
      source: "SYSTEM",
      needsMaintenanceReview: false,
      isActionable: false,
    };
  }
  if (agentStatus === "PENDING" || agentStatus === "PROCESSING" || agentStatus == null) {
    return {
      code: "ASSESSMENT_PENDING",
      title: "Checking your report",
      message: "Your report has been saved and is being prepared for automated assessment.",
      nextAction: "WAIT_FOR_ASSESSMENT",
      source: "SYSTEM",
      needsMaintenanceReview: false,
      isActionable: false,
    };
  }

  const awaitingReview = status === "PENDING_REVIEW";
  const suffix = awaitingReview
    ? " The Maintenance Team will review the report before deciding what happens next."
    : "";

  if (scopeDecision === "No Visible Maintenance Issue") {
    return {
      code: "NO_VISIBLE_ISSUE",
      title: "No visible maintenance issue identified",
      message: "The photo does not clearly show a maintenance defect. This does not rule out hidden or intermittent problems." + suffix,
      nextAction: awaitingReview ? "WAIT_FOR_MAINTENANCE_REVIEW" : "VIEW_REPORT",
      source: "AI_PRELIMINARY",
      needsMaintenanceReview: awaitingReview,
      isActionable: false,
    };
  }
  if (scopeDecision === "Out of Scope") {
    return {
      code: "OUT_OF_SCOPE",
      title: "Photo may be unrelated to facility maintenance",
      message: "The automated check could not identify a facility-maintenance issue in the photo." + suffix,
      nextAction: awaitingReview ? "WAIT_FOR_MAINTENANCE_REVIEW" : "VIEW_REPORT",
      source: "AI_PRELIMINARY",
      needsMaintenanceReview: awaitingReview,
      isActionable: false,
    };
  }
  if (scopeDecision === "Insufficient Image") {
    return {
      code: "INSUFFICIENT_IMAGE",
      title: "The photo needs clarification",
      message: "The submitted photo does not provide enough visual detail to assess the reported condition." + suffix,
      nextAction: awaitingReview ? "WAIT_FOR_MAINTENANCE_REVIEW" : "VIEW_REPORT",
      source: "AI_PRELIMINARY",
      needsMaintenanceReview: awaitingReview,
      isActionable: false,
    };
  }
  if (isActionableReport(row)) {
    return {
      code: "FACILITY_ISSUE",
      title: "Potential maintenance issue identified",
      message: "The automated assessment identified a potential facility issue." + suffix,
      nextAction: awaitingReview ? "WAIT_FOR_MAINTENANCE_REVIEW" : "VIEW_REPORT",
      source: "AI_PRELIMINARY",
      needsMaintenanceReview: awaitingReview,
      isActionable: true,
    };
  }

  return {
    code: "REVIEW_REQUIRED",
    title: "Report awaiting review",
    message: "Your report is saved and its maintenance decision is pending human review.",
    nextAction: "WAIT_FOR_MAINTENANCE_REVIEW",
    source: "SYSTEM",
    needsMaintenanceReview: awaitingReview,
    isActionable: false,
  };
}

/** Additive response wrapper. Never alter audit/event/DB values. */
export function presentReport(row, { reporter = false } = {}) {
  if (!row) return row;
  const result = { ...row, screening: reportScreening(row) };
  if ("LivePriorityScore" in result)
    result.LivePriorityScore = displayPriority(row, result.LivePriorityScore);
  if ("priorityScore" in result)
    result.priorityScore = displayPriority(row, result.priorityScore);
  if ("PriorityScoreAtReview" in result)
    result.PriorityScoreAtReview = displayPriority(row, result.PriorityScoreAtReview);
  if (reporter && "AgentLastError" in result) result.AgentLastError = null;
  if (reporter && "lastError" in result) result.lastError = null;
  return result;
}

/** Maintains the existing Agent-status payload while hiding internal failures. */
export function presentAgentStatus(payload, report, { reporter = false } = {}) {
  const out = { ...(payload || {}) };
  out.screening = reportScreening(report);
  if (reporter) {
    // Pydantic/Ollama exception detail must never be returned to a Reporter.
    delete out.upstreamDetail;
    delete out.errorDetail;
    out.lastError = null;
  }
  return out;
}
