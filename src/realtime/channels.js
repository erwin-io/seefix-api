/**
 * Realtime channel model. Every channel is a Pusher *private* channel, so a
 * client can only subscribe after POST /api/realtime/auth checks access here.
 *
 *   private-user-{userId}         the user only
 *   private-report-{reportId}     whoever may GET /api/reports/:id
 *   private-work-order-{woId}     maintenance roles, or the Worker who is responsible lead
 *   private-handoff-{handoffId}   Procurement + maintenance roles
 *
 * Outbox rows never choose an arbitrary channel: routing is derived from the
 * row's recipient / aggregate here, on the server.
 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CHANNEL = new RegExp(`^private-(user|report|work-order|handoff)-(${UUID})$`, "i");
const LEGACY = new RegExp(`^(report|work-order)-(${UUID})$`, "i");

export const MAINTENANCE_ROLES = ["MAINTENANCE_STAFF", "MAINTENANCE_SUPERVISOR", "ADMIN"];

export const channel = {
  user: (id) => `private-user-${id}`,
  report: (id) => `private-report-${id}`,
  workOrder: (id) => `private-work-order-${id}`,
  handoff: (id) => `private-handoff-${id}`,
};

/** `{ type, id }` for a well-formed channel name, else null. */
export function parseChannel(name) {
  const m = CHANNEL.exec(String(name || ""));
  return m ? { type: m[1].toLowerCase(), id: m[2].toLowerCase() } : null;
}

/**
 * Private channel(s) for an OutboxEvents row. Returns [] when the row cannot be
 * routed safely (it is then marked FAILED instead of being broadcast).
 * `q(sql, params)` resolves parent ids for child aggregates.
 */
export async function resolveChannels(row, q) {
  if (row.RecipientUserId) return [channel.user(row.RecipientUserId)];

  // Rows written by seefix-agents carry public-style names ("report-{id}"); map to the private equivalent.
  const legacy = LEGACY.exec(String(row.ChannelName || ""));
  if (legacy) return [legacy[1].toLowerCase() === "report" ? channel.report(legacy[2]) : channel.workOrder(legacy[2])];

  const id = row.AggregateId;
  switch (row.AggregateType) {
    case "REPORT":
      return [channel.report(id)];
    case "WORK_ORDER":
      return [channel.workOrder(id)];
    case "PROCUREMENT_HANDOFF":
      return [channel.handoff(id)];
    case "MAINTENANCE_REQUEST": {
      const r = await q(`SELECT "ReportId" FROM "dbo"."MaintenanceRequests" WHERE "Id"=$1`, [id]);
      return r.rows[0] ? [channel.report(r.rows[0].ReportId)] : [];
    }
    case "PROCUREMENT_CLARIFICATION": {
      const r = await q(`SELECT "ProcurementHandoffId" FROM "dbo"."ProcurementClarifications" WHERE "Id"=$1`, [id]);
      return r.rows[0] ? [channel.handoff(r.rows[0].ProcurementHandoffId)] : [];
    }
    default:
      return [];
  }
}

/**
 * May `user` (the authenticated req.user) subscribe to `name`? Mirrors the
 * REST read rules so realtime never reveals more than GET would.
 */
export async function canSubscribe(user, name, q) {
  const parsed = parseChannel(name);
  if (!parsed || !user?.id) return false;
  const { type, id } = parsed;
  const isMaintenance = MAINTENANCE_ROLES.includes(user.role);

  if (type === "user") return id === String(user.id).toLowerCase();

  if (type === "handoff") return isMaintenance || user.role === "PROCUREMENT";

  if (type === "work-order") {
    if (isMaintenance) return true;
    if (user.role !== "WORKER") return false;
    const r = await q(`SELECT 1 FROM "dbo"."WorkOrders" WHERE "Id"=$1 AND "ResponsibleLeadUserId"=$2`, [id, user.id]);
    return r.rowCount > 0;
  }

  // report: same scoping as getReportDetail()
  if (isMaintenance) return true;
  if (user.role === "REPORTER") {
    const r = await q(`SELECT 1 FROM "dbo"."Reports" WHERE "Id"=$1 AND "ReporterId"=$2`, [id, user.id]);
    return r.rowCount > 0;
  }
  if (user.role === "PROCUREMENT") {
    const r = await q(
      `SELECT 1 FROM "dbo"."ProcurementHandoffs" ph JOIN "dbo"."MaintenanceRequests" mr ON mr."Id"=ph."MaintenanceRequestId" WHERE mr."ReportId"=$1 LIMIT 1`,
      [id],
    );
    return r.rowCount > 0;
  }
  if (user.role === "WORKER") {
    const r = await q(`SELECT 1 FROM "dbo"."WorkOrders" WHERE "ReportId"=$1 AND "ResponsibleLeadUserId"=$2 LIMIT 1`, [id, user.id]);
    return r.rowCount > 0;
  }
  return false;
}
