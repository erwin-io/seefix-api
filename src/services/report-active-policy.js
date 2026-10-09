import { ApiError } from "../errors.js";

/**
 * These are the only report states that release the Reporter's submission slot.
 * NO_ACTION and DUPLICATE are final human Maintenance Review decisions.
 * A FAILED Agent attempt, NEEDS_INFORMATION, ON_HOLD and all routed jobs
 * remain active until one of the terminal states is reached.
 */
export const REPORT_TERMINAL_STATUSES = Object.freeze([
  "RESOLVED", "CANCELLED", "NO_ACTION", "DUPLICATE",
]);

export function isReportActive(status) {
  return !REPORT_TERMINAL_STATUSES.includes(status);
}

export function activeReportConflict(report) {
  const name = report?.reportNo || "existing report";
  const state = report?.status || "active";
  return new ApiError(
    409,
    `You already have ${name} (${state}) in progress. Cancel it while eligible or wait until it is resolved or closed by Maintenance before submitting another report.`,
    "ACTIVE_REPORT_EXISTS",
    { activeReport: report },
  );
}

export async function findActiveReport(queryFn, reporterId) {
  const result = await queryFn(
    `SELECT "Id" AS id, "ReportNo" AS "reportNo", "Status" AS status,
            "AgentStatus" AS "agentStatus", "CreatedAt" AS "createdAt"
       FROM "dbo"."Reports"
      WHERE "ReporterId"=$1
        AND "Status" NOT IN ('RESOLVED','CANCELLED','NO_ACTION','DUPLICATE')
      ORDER BY "CreatedAt" DESC, "Id" DESC
      LIMIT 1`,
    [reporterId],
  );
  return result.rows[0] ?? null;
}

export async function assertNoActiveReport(queryFn, reporterId) {
  const active = await findActiveReport(queryFn, reporterId);
  if (active) throw activeReportConflict(active);
}
