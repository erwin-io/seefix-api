import { Router } from "express";
import { query } from "../database.js";
import { ApiError } from "../errors.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";
import { cachedGet } from "../cache/response-cache.js";

const router = Router();

/** Dashboard sections each role receives (server aggregates only; no raw rows). WORKER work orders are their own. */
export const SECTIONS_BY_ROLE = {
  ADMIN: ["reports", "queueAging", "workOrders", "procurement", "agent"],
  MAINTENANCE_SUPERVISOR: ["reports", "queueAging", "workOrders", "procurement", "agent"],
  MAINTENANCE_STAFF: ["reports", "queueAging", "workOrders", "procurement", "agent"],
  PROCUREMENT: ["procurement"],
  WORKER: ["workOrders"],
};

const DAY_MS = 86_400_000;

/** `from`/`to` as YYYY-MM-DD (inclusive); default the last 30 days; at most 366 days. */
export function dateRange(q, now = new Date()) {
  const parse = (value, name) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ApiError(400, `${name} must be a date (YYYY-MM-DD).`, "INVALID_DATE");
    const d = new Date(`${value}T00:00:00.000Z`);
    // Reject dates JavaScript would silently roll over (2026-02-30 → 2026-03-02).
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
      throw new ApiError(400, `${name} must be a valid date.`, "INVALID_DATE");
    }
    return d;
  };
  const to = q.to ? new Date(parse(String(q.to), "to").getTime() + DAY_MS) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + DAY_MS);
  const from = q.from ? parse(String(q.from), "from") : new Date(to.getTime() - 30 * DAY_MS);
  if (from >= to) throw new ApiError(400, "from must be on or before to.", "INVALID_DATE");
  if (to - from > 366 * DAY_MS) throw new ApiError(400, "The date range can be at most 366 days.", "INVALID_DATE");
  return { from, to }; // [from, to)
}

const count = (rows, key) => Object.fromEntries(rows.map((r) => [r[key] ?? "Unknown", Number(r.n)]));
const num = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);

/**
 * Metric definitions (each is one SQL aggregate; see docs/V2_SEARCH_ANALYTICS_MAP.md):
 *  reports.created            Reports with CreatedAt in range
 *  reports.byStatus/Category  of those, by current Status / effective category (v_ReportPriorityLive)
 *  reports.perDay             of those, per UTC day
 *  queueAging                 Reports now PENDING_REVIEW, by age since CreatedAt (<1d, 1-3d, 3-7d, >7d) — not range-bound
 *  workOrders.byStatus        all work orders by current Status (WORKER: only where they are responsible lead)
 *  workOrders.completed       work orders with ResolvedAt in range; turnaround = ResolvedAt − AssignedAt (hours)
 *  workOrders.reworkRate      of completed in range, share with any status-history move to REWORK_REQUIRED
 *  procurement.byStatus       all handoffs by current Status; open = not COMPLETED/CANCELLED
 *  procurement.overdue        open handoffs with ExpectedResponseAt < now
 *  procurement.completed      handoffs with CompletedAt in range; avgDays = CompletedAt − SubmittedAt
 *  agent.byStatus             Reports created in range by AgentStatus
 *  agent.retried              of those, AgentAttemptCount > 1
 *  agent.latency              of those COMPLETED, AgentCompletedAt − CreatedAt (seconds, p50/p95)
 *  agent.failedOpen           Reports now AgentStatus FAILED and Status SUBMITTED (needs a person) — not range-bound
 */
async function section(name, { from, to }, user) {
  const range = [from, to];
  switch (name) {
    case "reports": {
      const [status, category, perDay] = await Promise.all([
        query(`SELECT "Status" AS k, COUNT(*) AS n FROM "dbo"."Reports" WHERE "CreatedAt" >= $1 AND "CreatedAt" < $2 GROUP BY 1`, range),
        query(`SELECT p."EffectiveCategory" AS k, COUNT(*) AS n FROM "dbo"."Reports" r LEFT JOIN "dbo"."v_ReportPriorityLive" p ON p."Id"=r."Id"
                WHERE r."CreatedAt" >= $1 AND r."CreatedAt" < $2 GROUP BY 1`, range),
        query(`SELECT to_char(date_trunc('day', "CreatedAt" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS k, COUNT(*) AS n
                 FROM "dbo"."Reports" WHERE "CreatedAt" >= $1 AND "CreatedAt" < $2 GROUP BY 1 ORDER BY 1`, range),
      ]);
      const byStatus = count(status.rows, "k");
      return {
        created: Object.values(byStatus).reduce((a, b) => a + b, 0),
        byStatus,
        byCategory: count(category.rows, "k"),
        perDay: perDay.rows.map((r) => ({ day: r.k, count: Number(r.n) })),
      };
    }
    case "queueAging": {
      const r = await query(`
        SELECT COUNT(*) FILTER (WHERE age < interval '1 day') AS "under1d",
               COUNT(*) FILTER (WHERE age >= interval '1 day' AND age < interval '3 days') AS "d1to3",
               COUNT(*) FILTER (WHERE age >= interval '3 days' AND age < interval '7 days') AS "d3to7",
               COUNT(*) FILTER (WHERE age >= interval '7 days') AS "over7d",
               COUNT(*) AS total
          FROM (SELECT now() - "CreatedAt" AS age FROM "dbo"."Reports" WHERE "Status"='PENDING_REVIEW') q`);
      return Object.fromEntries(Object.entries(r.rows[0]).map(([k, v]) => [k, Number(v)]));
    }
    case "workOrders": {
      const own = user.role === "WORKER";
      const lead = own ? `AND wo."ResponsibleLeadUserId"=$3` : "";
      const params = own ? [...range, user.id] : range;
      const [status, done] = await Promise.all([
        query(`SELECT wo."Status" AS k, COUNT(*) AS n FROM "dbo"."WorkOrders" wo WHERE TRUE ${own ? `AND wo."ResponsibleLeadUserId"=$1` : ""} GROUP BY 1`, own ? [user.id] : []),
        query(`
          SELECT COUNT(*) AS completed,
                 AVG(EXTRACT(EPOCH FROM (wo."ResolvedAt" - wo."AssignedAt")) / 3600) AS "avgTurnaroundHours",
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (wo."ResolvedAt" - wo."AssignedAt")) / 3600) AS "p50TurnaroundHours",
                 COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM "dbo"."WorkOrderStatusHistory" h
                                                 WHERE h."WorkOrderId"=wo."Id" AND h."NewStatus"='REWORK_REQUIRED')) AS reworked
            FROM "dbo"."WorkOrders" wo
           WHERE wo."Status"='COMPLETED' AND wo."ResolvedAt" >= $1 AND wo."ResolvedAt" < $2 ${lead}`, params),
      ]);
      const d = done.rows[0];
      const completed = Number(d.completed);
      return {
        byStatus: count(status.rows, "k"),
        completed,
        avgTurnaroundHours: num(d.avgTurnaroundHours),
        p50TurnaroundHours: num(d.p50TurnaroundHours),
        reworkRate: completed ? num((Number(d.reworked) / completed) * 100) : null,
      };
    }
    case "procurement": {
      const [status, overdue, done] = await Promise.all([
        query(`SELECT "Status" AS k, COUNT(*) AS n FROM "dbo"."ProcurementHandoffs" GROUP BY 1`),
        query(`SELECT COUNT(*) AS n FROM "dbo"."ProcurementHandoffs"
                WHERE "Status" NOT IN ('COMPLETED','CANCELLED') AND "ExpectedResponseAt" < now()`),
        query(`SELECT COUNT(*) AS n, AVG(EXTRACT(EPOCH FROM ("CompletedAt" - "SubmittedAt")) / 86400) AS "avgDays"
                 FROM "dbo"."ProcurementHandoffs" WHERE "CompletedAt" >= $1 AND "CompletedAt" < $2`, range),
      ]);
      const byStatus = count(status.rows, "k");
      return {
        byStatus,
        open: Object.entries(byStatus).filter(([k]) => !["COMPLETED", "CANCELLED"].includes(k)).reduce((a, [, n]) => a + n, 0),
        overdue: Number(overdue.rows[0].n),
        completed: Number(done.rows[0].n),
        avgDaysToOutcome: num(done.rows[0].avgDays),
      };
    }
    case "agent": {
      const [status, stats, failed] = await Promise.all([
        query(`SELECT "AgentStatus" AS k, COUNT(*) AS n FROM "dbo"."Reports" WHERE "CreatedAt" >= $1 AND "CreatedAt" < $2 GROUP BY 1`, range),
        query(`
          SELECT COUNT(*) FILTER (WHERE "AgentAttemptCount" > 1) AS retried,
                 percentile_cont(0.5)  WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM ("AgentCompletedAt" - "CreatedAt")))
                   FILTER (WHERE "AgentStatus"='COMPLETED' AND "AgentCompletedAt" IS NOT NULL) AS "p50Seconds",
                 percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM ("AgentCompletedAt" - "CreatedAt")))
                   FILTER (WHERE "AgentStatus"='COMPLETED' AND "AgentCompletedAt" IS NOT NULL) AS "p95Seconds"
            FROM "dbo"."Reports" WHERE "CreatedAt" >= $1 AND "CreatedAt" < $2`, range),
        query(`SELECT COUNT(*) AS n FROM "dbo"."Reports" WHERE "AgentStatus"='FAILED' AND "Status"='SUBMITTED'`),
      ]);
      const s = stats.rows[0];
      return {
        byStatus: count(status.rows, "k"),
        retried: Number(s.retried),
        latencyP50Seconds: num(s.p50Seconds),
        latencyP95Seconds: num(s.p95Seconds),
        failedOpen: Number(failed.rows[0].n),
      };
    }
    default:
      throw new Error(`unknown section ${name}`);
  }
}

/** GET /api/analytics/overview?from=YYYY-MM-DD&to=YYYY-MM-DD → { from, to, sections: { ... } } (role-scoped). */
router.get(
  "/overview",
  requireAuth,
  requireRoles(...Object.keys(SECTIONS_BY_ROLE)),
  cachedGet({ domains: ["reports", "work_orders", "procurement", "reference"], scope: "user" }),
  async (req, res, next) => {
    try {
      const range = dateRange(req.query);
      const names = SECTIONS_BY_ROLE[req.user.role];
      const values = await Promise.all(names.map((name) => section(name, range, req.user)));
      res.json({
        from: range.from.toISOString().slice(0, 10),
        to: new Date(range.to.getTime() - DAY_MS).toISOString().slice(0, 10),
        sections: Object.fromEntries(names.map((name, i) => [name, values[i]])),
      });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
