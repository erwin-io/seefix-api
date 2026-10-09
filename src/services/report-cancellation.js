import { withTransaction } from "../database.js";
import { ApiError } from "../errors.js";
import { createNotification } from "./notifications.js";

/**
 * Cancellation is a final Reporter-owned decision, not a report deletion.
 * It is deliberately allowed only before human routing.
 */
export const REPORTER_CANCELLABLE_STATUSES = Object.freeze([
  "SUBMITTED",
  "PENDING_REVIEW",
]);

export function cancellationEligibility({ status, hasReview = false, hasDownstream = false }) {
  if (status === "CANCELLED") return { canCancel: false, reason: "ALREADY_CANCELLED" };
  if (!REPORTER_CANCELLABLE_STATUSES.includes(status)) {
    return { canCancel: false, reason: "CANCELLATION_WINDOW_CLOSED" };
  }
  if (hasReview || hasDownstream) {
    return { canCancel: false, reason: "MAINTENANCE_ALREADY_STARTED" };
  }
  return { canCancel: true, reason: null };
}

export function validateCancellationReason(input) {
  if (typeof input !== "string") {
    throw new ApiError(400, "A cancellation reason is required.", "CANCELLATION_REASON_REQUIRED");
  }
  const reason = input.trim();
  if (reason.length < 5 || reason.length > 500) {
    throw new ApiError(400, "Cancellation reason must be 5 to 500 characters.", "INVALID_CANCELLATION_REASON");
  }
  return reason;
}

async function performCancel(reportId, user, reason) {
  return withTransaction(user.id, async (client) => {
    // Same parent row lock is used by Maintenance Review and Agent completion.
    // This serializes the actual decision against both workflows.
    const found = await client.query(
      `SELECT "Id", "ReportNo", "Status", "AgentStatus", "ReporterId"
         FROM "dbo"."Reports"
        WHERE "Id"=$1
        FOR UPDATE`,
      [reportId],
    );
    const report = found.rows[0];
    // Do not expose another Reporter's report existence.
    if (!report || user.role !== "REPORTER" || String(report.ReporterId) !== String(user.id)) {
      throw new ApiError(404, "Report was not found.", "REPORT_NOT_FOUND");
    }

    // A repeat request from the owner is safe and does not send another notification.
    if (report.Status === "CANCELLED") {
      const previous = await client.query(
        `SELECT "CreatedAt" AS "cancelledAt", "Reason" AS reason
           FROM "dbo"."ReportStatusHistory"
          WHERE "ReportId"=$1 AND "StatusType"='REPORT' AND "NewStatus"='CANCELLED'
          ORDER BY "CreatedAt" DESC, "Id" DESC LIMIT 1`,
        [reportId],
      );
      return {
        reportId: report.Id, reportNo: report.ReportNo,
        status: "CANCELLED", agentStatus: report.AgentStatus,
        cancelledAt: previous.rows[0]?.cancelledAt ?? null,
        reason: previous.rows[0]?.reason ?? null, canCancel: false, alreadyCancelled: true,
      };
    }

    const links = await client.query(
      `SELECT
         EXISTS(SELECT 1 FROM "dbo"."MaintenanceReviews" WHERE "ReportId"=$1) AS "hasReview",
         EXISTS(SELECT 1 FROM "dbo"."WorkOrders" WHERE "ReportId"=$1) AS "hasWorkOrder",
         EXISTS(
           SELECT 1 FROM "dbo"."ProcurementHandoffs" ph
           JOIN "dbo"."MaintenanceRequests" mr ON mr."Id"=ph."MaintenanceRequestId"
           WHERE mr."ReportId"=$1
         ) AS "hasProcurement",
         EXISTS(
           SELECT 1 FROM "dbo"."MaintenanceRequests"
           WHERE "ReportId"=$1 AND "Status" <> 'DRAFT'
         ) AS "hasCommittedRequest"`,
      [reportId],
    );
    const linked = links.rows[0];
    const eligibility = cancellationEligibility({
      status: report.Status,
      hasReview: linked.hasReview,
      hasDownstream: linked.hasWorkOrder || linked.hasProcurement || linked.hasCommittedRequest,
    });
    if (!eligibility.canCancel) {
      throw new ApiError(
        409,
        "This report can no longer be cancelled because maintenance processing has already started or its cancellation window has closed.",
        eligibility.reason,
      );
    }

    const changed = await client.query(
      `UPDATE "dbo"."Reports" SET "Status"='CANCELLED'
         WHERE "Id"=$1 AND "Status" IN ('SUBMITTED','PENDING_REVIEW')
         RETURNING "Status" AS status, "AgentStatus" AS "agentStatus"`,
      [reportId],
    );
    if (!changed.rows[0]) {
      throw new ApiError(409, "The report state changed. Refresh and try again.", "CANCELLATION_WINDOW_CLOSED");
    }

    // The existing status-history trigger writes the actor and state transition.
    // Attach the human reason to that exact transition instead of adding tables.
    const audited = await client.query(
      `UPDATE "dbo"."ReportStatusHistory" h
          SET "Reason"=$2
        WHERE h."Id"=(
          SELECT h2."Id" FROM "dbo"."ReportStatusHistory" h2
          WHERE h2."ReportId"=$1 AND h2."StatusType"='REPORT'
            AND h2."NewStatus"='CANCELLED' AND h2."Reason" IS NULL
          ORDER BY h2."CreatedAt" DESC, h2."Id" DESC LIMIT 1
        )
        RETURNING "CreatedAt" AS "cancelledAt"`,
      [reportId, reason],
    );
    if (!audited.rows[0]) {
      // Fail closed: a cancellation must leave an attributable reason in history.
      throw new ApiError(500, "Unable to record the cancellation audit. Please retry.", "CANCELLATION_AUDIT_FAILED");
    }

    // An AI-produced DRAFT is never a human approval. Close it if present.
    await client.query(
      `UPDATE "dbo"."MaintenanceRequests"
          SET "Status"='CANCELLED'
        WHERE "ReportId"=$1 AND "Status"='DRAFT'`,
      [reportId],
    );

    await createNotification(client, {
      userId: user.id,
      type: "REPORT_CANCELLED",
      title: "Report cancelled",
      message: `Your report ${report.ReportNo} was cancelled as requested. No maintenance action will be initiated.`,
      entityType: "REPORT",
      entityId: report.Id,
      payload: { reportNo: report.ReportNo, status: "CANCELLED" },
      deduplicationKey: `report:${report.Id}:cancelled`,
    });

    return {
      reportId: report.Id,
      reportNo: report.ReportNo,
      status: "CANCELLED",
      agentStatus: changed.rows[0].agentStatus,
      cancelledAt: audited.rows[0].cancelledAt,
      reason,
      canCancel: false,
      alreadyCancelled: false,
    };
  });
}

export async function cancelReport(reportId, user, inputReason) {
  const reason = validateCancellationReason(inputReason);
  // A late Agent DRAFT and a Reporter cancellation may briefly lock in opposite
  // order. PostgreSQL aborts a deadlock participant; retry only that SQLSTATE.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await performCancel(reportId, user, reason); }
    catch (error) {
      if (error?.code !== "40P01" || attempt === 2) throw error;
    }
  }
}
