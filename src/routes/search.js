import { Router } from "express";
import { query } from "../database.js";
import { ApiError } from "../errors.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";
import { memoryRateLimit } from "../security/rate-limit.js";

const router = Router();

/**
 * Result groups each role may search. Each group's SQL applies the SAME row rules as the matching detail route
 * (getReportDetail, assertWorkAccess, procurement ACCESS, admin-only users), so search never reveals a record the
 * caller couldn't open.
 */
export const TYPES_BY_ROLE = {
  ADMIN: ["reports", "maintenance_requests", "work_orders", "procurement", "action_items", "users", "buildings"],
  MAINTENANCE_SUPERVISOR: ["reports", "maintenance_requests", "work_orders", "procurement", "action_items", "buildings"],
  MAINTENANCE_STAFF: ["reports", "maintenance_requests", "work_orders", "procurement", "action_items", "buildings"],
  PROCUREMENT: ["reports", "procurement", "buildings"],
  WORKER: ["reports", "work_orders", "buildings"],
};

const LABELS = {
  reports: "Reports",
  maintenance_requests: "Maintenance requests",
  work_orders: "Work orders",
  procurement: "Procurement",
  action_items: "Action Center",
  users: "Users",
  buildings: "Buildings",
};

/** Escapes LIKE wildcards so the query text only ever matches literally. */
export function likePattern(q) {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// Each search returns [sql, extraParams]: $1 = pattern, $2 = limit, then its own extras ($3...). Every value is bound;
// only these fixed SQL fragments vary by role.
const REPORT_SCOPE = {
  PROCUREMENT: `AND EXISTS (SELECT 1 FROM "dbo"."ProcurementHandoffs" ph JOIN "dbo"."MaintenanceRequests" mr ON mr."Id"=ph."MaintenanceRequestId" WHERE mr."ReportId"=r."Id")`,
  WORKER: `AND EXISTS (SELECT 1 FROM "dbo"."WorkOrders" w WHERE w."ReportId"=r."Id" AND w."ResponsibleLeadUserId"=$3)`,
};
const userParam = (role, user) => (role === "WORKER" ? [user.id] : []);

const SEARCHES = {
  reports: (role, user) => [`
    SELECT r."Id" AS id, r."ReportNo" AS title,
           concat_ws(' · ', r."Status", nullif(r."Building", ''), left(r."Description", 80)) AS subtitle,
           '/reports/' || r."Id" AS route
      FROM "dbo"."Reports" r
     WHERE (r."ReportNo" || ' ' || coalesce(r."Description", '') || ' ' || coalesce(r."Building", '')) ILIKE $1 ESCAPE '\\'
       ${REPORT_SCOPE[role] ?? ""}
     ORDER BY (r."ReportNo" ILIKE $1) DESC, r."CreatedAt" DESC, r."Id" LIMIT $2`, userParam(role, user)],
  maintenance_requests: () => [`
    SELECT mr."Id" AS id, mr."RequestNo" AS title,
           concat_ws(' · ', mr."Status", left(mr."ScopeOfWork", 80)) AS subtitle,
           '/reports/' || mr."ReportId" AS route
      FROM "dbo"."MaintenanceRequests" mr
     WHERE (mr."RequestNo" || ' ' || coalesce(mr."ScopeOfWork", '')) ILIKE $1 ESCAPE '\\'
     ORDER BY mr."CreatedAt" DESC, mr."Id" LIMIT $2`, []],
  work_orders: (role, user) => [`
    SELECT wo."Id" AS id, wo."WorkOrderNo" AS title,
           concat_ws(' · ', wo."Status", wo."AssignedPartyName", wo."ResponsibleLeadName") AS subtitle,
           '/work-orders/' || wo."Id" AS route
      FROM "dbo"."WorkOrders" wo
     WHERE (wo."WorkOrderNo" || ' ' || coalesce(wo."AssignedPartyName", '') || ' ' || coalesce(wo."ResponsibleLeadName", '')) ILIKE $1 ESCAPE '\\'
       ${role === "WORKER" ? `AND wo."ResponsibleLeadUserId"=$3` : ""}
     ORDER BY wo."CreatedAt" DESC, wo."Id" LIMIT $2`, userParam(role, user)],
  procurement: () => [`
    SELECT ph."Id" AS id, ph."HandoffNo" AS title,
           concat_ws(' · ', ph."Status", ph."ExternalSystemReference") AS subtitle,
           '/procurement/handoffs/' || ph."Id" AS route
      FROM "dbo"."ProcurementHandoffs" ph
     WHERE (ph."HandoffNo" || ' ' || coalesce(ph."ExternalSystemReference", '')) ILIKE $1 ESCAPE '\\'
     ORDER BY ph."CreatedAt" DESC, ph."Id" LIMIT $2`, []],
  action_items: (role) => [`
    SELECT a."EntityId" AS id, coalesce(a."ReferenceNo", a."EntityType") AS title,
           concat_ws(' · ', a."ActionType", left(a."Summary", 80)) AS subtitle,
           CASE a."EntityType" WHEN 'REPORT' THEN '/reports/' || a."EntityId"
                               WHEN 'WORK_ORDER' THEN '/work-orders/' || a."EntityId"
                               WHEN 'PROCUREMENT_HANDOFF' THEN '/procurement/handoffs/' || a."EntityId"
                               ELSE '/maintenance/action-center' END AS route
      FROM "dbo"."v_MaintenanceActionCenter" a
     WHERE (coalesce(a."ReferenceNo", '') || ' ' || coalesce(a."Summary", '')) ILIKE $1 ESCAPE '\\'
       ${["MAINTENANCE_SUPERVISOR", "ADMIN"].includes(role) ? "" : `AND a."AssignedRole"=$3`}
     ORDER BY a."PriorityScore" DESC NULLS LAST, a."EntityId" LIMIT $2`,
    ["MAINTENANCE_SUPERVISOR", "ADMIN"].includes(role) ? [] : [role]],
  users: () => [`
    SELECT u."Id" AS id, u."FullName" AS title, concat_ws(' · ', u."Role", u."Email") AS subtitle, '/admin/users' AS route
      FROM "dbo"."Users" u
     WHERE (u."FullName" || ' ' || u."Email" || ' ' || coalesce(u."Username", '')) ILIKE $1 ESCAPE '\\'
     ORDER BY u."FullName", u."Id" LIMIT $2`, []],
  buildings: () => [`
    SELECT b."Id" AS id, b."Name" AS title, b."Code" AS subtitle, NULL::text AS route
      FROM "dbo"."Buildings" b
     WHERE b."IsActive" AND (b."Name" || ' ' || b."Code") ILIKE $1 ESCAPE '\\'
     ORDER BY b."SortOrder", b."Name" LIMIT $2`, []],
};

// Typeahead fires per keystroke (debounced by the client); bounded per user and instance.
const searchThrottle = memoryRateLimit({
  windowMs: 60_000,
  max: 120,
  key: (req) => req.user?.id,
  message: "Too many searches. Please slow down.",
});

/**
 * GET /api/search?q=...&types=reports,work_orders&limit=5 → { q, groups: [{ type, label, items: [{ id, title, subtitle, route }] }] }
 * Not cached (unbounded keys); every value is a bound parameter. `route` is a web-admin path the caller may open
 * (null for buildings: no detail page yet).
 */
router.get("/", requireAuth, requireRoles(...Object.keys(TYPES_BY_ROLE)), searchThrottle, async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q.length < 2 || q.length > 100) throw new ApiError(400, "Search text must be 2 to 100 characters.", "INVALID_QUERY");
    const limit = req.query.limit === undefined ? 5 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new ApiError(400, "limit must be an integer from 1 to 20.", "INVALID_LIMIT");
    const allowed = TYPES_BY_ROLE[req.user.role];
    const requested = typeof req.query.types === "string" && req.query.types.trim()
      ? req.query.types.split(",").map((t) => t.trim())
      : allowed;
    const unknown = requested.filter((t) => !LABELS[t]);
    if (unknown.length) throw new ApiError(400, `Unknown search type: ${unknown.join(", ")}.`, "INVALID_TYPES");
    const types = requested.filter((t) => allowed.includes(t)); // types the role can't read are silently dropped

    const pattern = likePattern(q);
    const groups = await Promise.all(types.map(async (type) => {
      const [sql, extra] = SEARCHES[type](req.user.role, req.user);
      const r = await query(sql, [pattern, limit, ...extra]);
      return { type, label: LABELS[type], items: r.rows };
    }));
    res.set("Cache-Control", "no-store");
    res.json({ q, groups: groups.filter((g) => g.items.length) });
  } catch (error) {
    next(error);
  }
});

export default router;
