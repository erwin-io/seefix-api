/**
 * Web Admin V2 assistant (seefix-api#21, docs/V2_ASSISTANT.md).
 * Read-only tools run here, after RBAC, with the same row rules as the detail routes. The Agent only phrases answers
 * from the facts we send; it never chooses tools, sees SQL or triggers actions. The only writes are user-owned drafts,
 * reminders and reassessment requests, each behind explicit confirmation. Workflow decisions stay with humans.
 */
import { query, withTransaction } from "../database.js";
import { ApiError } from "../errors.js";
import { agentClient } from "../agent-client.js";
import { assertReportAccess } from "./report-service.js";
import { assertWorkAccess } from "../routes/work-orders.js";
import { displayPriority } from "./report-presentation.js";

export const INTERNAL_ROLES = ["ADMIN", "MAINTENANCE_SUPERVISOR", "MAINTENANCE_STAFF", "PROCUREMENT", "WORKER"];
const MAINT = ["ADMIN", "MAINTENANCE_SUPERVISOR", "MAINTENANCE_STAFF"];
const WORK = [...MAINT, "WORKER"];
const PROC_READERS = ["PROCUREMENT", ...MAINT];
const SUPERVISORS = ["ADMIN", "MAINTENANCE_SUPERVISOR"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const forbidden = (message, code = "FORBIDDEN") => new ApiError(403, message, code);
const conflict = (message, code, details) => Object.assign(new ApiError(409, message, code), details ? { details } : {});

function uuid(value, field) {
  if (typeof value !== "string" || !UUID.test(value)) throw new ApiError(400, `${field} must be a UUID.`, "INVALID_VALUE");
  return value.toLowerCase();
}

function text(value, field, { min = 1, max }) {
  const t = typeof value === "string" ? value.trim() : "";
  if (t.length < min || t.length > max) throw new ApiError(400, `${field} must be ${min} to ${max} characters.`, "INVALID_VALUE");
  return t;
}

function intParam(value, field, { min, max, fallback }) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new ApiError(400, `${field} must be an integer from ${min} to ${max}.`, "INVALID_VALUE");
  return n;
}

async function audit(client, user, action, entityType, entityId, data) {
  await client.query(
    `INSERT INTO "dbo"."AuditLogs" ("ActorUserId","ActorType","Action","EntityType","EntityId","NewData")
     VALUES ($1,'USER',$2,$3,$4,$5::jsonb)`,
    [user.id, action, entityType, entityId, JSON.stringify(data)],
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Navigation, tools and the action boundary.

const NAVIGATION = [
  { path: "/dashboard", label: "Dashboard", roles: INTERNAL_ROLES },
  { path: "/maintenance/action-center", label: "Action Center", roles: MAINT },
  { path: "/maintenance/review-queue", label: "Review Queue", roles: MAINT },
  { path: "/maintenance/reports", label: "Reports", roles: MAINT },
  { path: "/work-orders", label: "Work Orders", roles: WORK },
  { path: "/procurement/inbox", label: "Procurement Inbox", roles: PROC_READERS },
  { path: "/admin/users", label: "Users", roles: ["ADMIN"] },
  { path: "/admin/knowledge", label: "AI Knowledge", roles: ["ADMIN"] },
  { path: "/notifications", label: "Notifications", roles: INTERNAL_ROLES },
  { path: "/account", label: "Account", roles: INTERNAL_ROLES },
];
export const navigationFor = (role) => NAVIGATION.filter((n) => n.roles.includes(role)).map(({ path, label }) => ({ path, label }));

export const TOOLS = ["summary", "action-queue", "trends", "records", "navigation"];

/** Assistant actions and the roles that may run them. Everything else is refused. */
export const ACTION_ROLES = {
  save_draft: INTERNAL_ROLES,
  discard_draft: INTERNAL_ROLES,
  create_reminder: INTERNAL_ROLES,
  cancel_reminder: INTERNAL_ROLES,
  request_reassessment: MAINT,
  cancel_reassessment: MAINT,
};

/**
 * Human-only workflow decisions. Never available through the assistant, for any role (ADMIN included): the human uses
 * the normal screen and route. Named explicitly, plus a pattern so a renamed variant is refused too, not "unknown".
 */
export const PROHIBITED_ACTIONS = [
  "review_report", "approve_routing", "route_internal", "route_procurement",
  "create_work_order", "authorize_work_order", "assign_work_order", "start_work_order", "update_work_order_status",
  "complete_work_order", "rework_work_order",
  "submit_procurement_handoff", "acknowledge_procurement_handoff", "record_procurement_outcome",
  "answer_procurement_clarification", "upload_procurement_document", "cancel_procurement_handoff",
];
const PROHIBITED_PATTERN = /approv|authori[sz]|complet|rework|procure|work_?order|rout|review|assign/i;

export function classifyAction(action, role) {
  if (typeof action !== "string" || !action) throw new ApiError(400, "action is required.", "UNKNOWN_ACTION");
  if (Object.hasOwn(ACTION_ROLES, action)) {
    if (!ACTION_ROLES[action].includes(role)) throw forbidden("Your role cannot use this assistant action.");
    return action;
  }
  if (PROHIBITED_ACTIONS.includes(action) || PROHIBITED_PATTERN.test(action)) {
    throw forbidden(
      "The assistant cannot make workflow decisions. Use the normal screen to review, route, authorize, complete or rework, or for procurement actions.",
      "ASSISTANT_ACTION_PROHIBITED",
    );
  }
  throw new ApiError(400, `Unknown assistant action: ${action.slice(0, 60)}.`, "UNKNOWN_ACTION");
}

export function toolCatalog(role) {
  return {
    role,
    tools: TOOLS,
    actions: { allowed: Object.keys(ACTION_ROLES).filter((a) => ACTION_ROLES[a].includes(role)), prohibited: PROHIBITED_ACTIONS },
    navigation: navigationFor(role),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Records: one rule per type, identical to the detail route (404, then 403).

export const RECORD_TYPES = ["report", "work_order", "handoff"];

export async function assertRecordAccess(type, id, user) {
  uuid(id, "id");
  if (type === "report") return assertReportAccess(id, user);
  if (type === "work_order") {
    if (!WORK.includes(user.role)) throw forbidden("You do not have permission for this operation.");
    return assertWorkAccess(id, user);
  }
  if (type === "handoff") {
    if (!PROC_READERS.includes(user.role)) throw forbidden("You do not have permission for this operation.");
    const r = await query(`SELECT * FROM "dbo"."ProcurementHandoffs" WHERE "Id"=$1`, [id]);
    if (!r.rows[0]) throw new ApiError(404, "Procurement handoff was not found.", "PROCUREMENT_HANDOFF_NOT_FOUND");
    return r.rows[0];
  }
  throw new ApiError(400, "type must be report, work_order or handoff.", "INVALID_RECORD_TYPE");
}

const cut = (value, n) => (value == null ? null : String(value).slice(0, n));

/** A compact, PII-free fact (no names, emails, phones or image URLs). Free text is truncated; the Agent treats it as untrusted. */
export function recordFact(type, row) {
  if (type === "report") {
    return {
      id: `report:${row.Id}`, kind: "report", label: `${row.ReportNo} ${row.EffectiveCategory ?? row.AiCategory ?? ""}`.trim(),
      navigation: `/reports/${row.Id}`,
      data: {
        reportNo: row.ReportNo, status: row.Status, agentStatus: row.AgentStatus,
        category: row.EffectiveCategory ?? row.AiCategory ?? null, urgency: row.EffectiveUrgency ?? row.AiRecommendedUrgency ?? null,
        priority: displayPriority(row, row.LivePriorityScore), building: row.Building, floor: row.Floor, roomOrArea: row.RoomOrArea,
        aiSummary: cut(row.AiSummary, 500), description: cut(row.Description, 500), createdAt: row.CreatedAt,
      },
    };
  }
  if (type === "work_order") {
    return {
      id: `work_order:${row.Id}`, kind: "work_order", label: row.WorkOrderNo, navigation: `/work-orders/${row.Id}`,
      data: {
        workOrderNo: row.WorkOrderNo, status: row.Status, executionType: row.ExecutionType, assignedParty: row.AssignedPartyName,
        plannedStartAt: row.PlannedStartAt, deadline: row.Deadline, completionCheck: row.CompletionAgentStatus, createdAt: row.CreatedAt,
      },
    };
  }
  return {
    id: `handoff:${row.Id}`, kind: "handoff", label: row.HandoffNo, navigation: `/procurement/handoffs/${row.Id}`,
    data: {
      handoffNo: row.HandoffNo, status: row.Status, submittedAt: row.SubmittedAt, expectedResponseAt: row.ExpectedResponseAt,
      nextFollowUpAt: row.NextFollowUpAt, externalReference: row.ExternalSystemReference,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Summary, action queue, trends. Each role sees exactly what its list routes show.

const OPEN_WO = `wo."Status" NOT IN ('COMPLETED','CANCELLED')`;
const OPEN_HANDOFF = `ph."Status" NOT IN ('COMPLETED','CANCELLED')`;
const byStatus = (rows) => Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));

export async function summary(user) {
  const role = user.role;
  const out = { role };
  if (MAINT.includes(role)) {
    const [reports, wos, actions] = await Promise.all([
      query(`SELECT "Status" AS status, COUNT(*) n FROM "dbo"."Reports" WHERE "Status" NOT IN ('RESOLVED','NO_ACTION','DUPLICATE','CANCELLED') GROUP BY 1`),
      query(`SELECT wo."Status" AS status, COUNT(*) n FROM "dbo"."WorkOrders" wo WHERE ${OPEN_WO} GROUP BY 1`),
      query(`SELECT COUNT(*) n FROM "dbo"."v_MaintenanceActionCenter" WHERE "AssignedRole"=$1 OR $1 IN ('MAINTENANCE_SUPERVISOR','ADMIN')`, [role]),
    ]);
    Object.assign(out, { openReports: byStatus(reports.rows), openWorkOrders: byStatus(wos.rows), actionItems: Number(actions.rows[0].n) });
  }
  if (PROC_READERS.includes(role)) {
    const h = await query(
      `SELECT ph."Status" AS status, COUNT(*) n, COUNT(*) FILTER (WHERE ph."ExpectedResponseAt" < now()) overdue
         FROM "dbo"."ProcurementHandoffs" ph WHERE ${OPEN_HANDOFF} GROUP BY 1`);
    out.openHandoffs = byStatus(h.rows);
    out.overdueHandoffs = h.rows.reduce((a, r) => a + Number(r.overdue), 0);
  }
  if (role === "WORKER") {
    const w = await query(`SELECT wo."Status" AS status, COUNT(*) n FROM "dbo"."WorkOrders" wo WHERE wo."ResponsibleLeadUserId"=$1 AND ${OPEN_WO} GROUP BY 1`, [user.id]);
    out.myOpenWorkOrders = byStatus(w.rows);
  }
  return out;
}

const ROUTE_BY_ENTITY = { REPORT: "/reports/", WORK_ORDER: "/work-orders/", PROCUREMENT_HANDOFF: "/procurement/handoffs/" };

export async function actionQueue(user, limit) {
  if (MAINT.includes(user.role)) {
    // Same filter and ranking as GET /api/maintenance/action-center.
    const r = await query(
      `SELECT "EntityType","EntityId","ActionType","ReferenceNo","Summary","PriorityScore","ActionCreatedAt"
         FROM "dbo"."v_MaintenanceActionCenter"
        WHERE "AssignedRole"=$1 OR $1 IN ('MAINTENANCE_SUPERVISOR','ADMIN')
        ORDER BY "PriorityScore" DESC NULLS LAST, "ActionCreatedAt" ASC, "EntityId", "ActionType" LIMIT $2`,
      [user.role, limit]);
    return r.rows.map((a) => ({
      entityType: a.EntityType, entityId: a.EntityId, action: a.ActionType, reference: a.ReferenceNo,
      summary: cut(a.Summary, 300), priority: a.PriorityScore, since: a.ActionCreatedAt,
      route: ROUTE_BY_ENTITY[a.EntityType] ? ROUTE_BY_ENTITY[a.EntityType] + a.EntityId : "/maintenance/action-center",
    }));
  }
  if (user.role === "PROCUREMENT") {
    // Same ranking as GET /api/procurement/inbox.
    const r = await query(
      `SELECT "HandoffId","HandoffNo","Status","ExpectedResponseAt","EffectiveUrgency","LivePriorityScore","SubmittedAt"
         FROM "dbo"."v_ProcurementInbox" ORDER BY "LivePriorityScore" DESC NULLS LAST, "SubmittedAt" ASC, "HandoffId" LIMIT $1`,
      [limit]);
    return r.rows.map((h) => ({
      entityType: "PROCUREMENT_HANDOFF", entityId: h.HandoffId, action: h.Status, reference: h.HandoffNo,
      summary: `Urgency ${h.EffectiveUrgency ?? "n/a"}`, priority: h.LivePriorityScore, since: h.SubmittedAt,
      dueAt: h.ExpectedResponseAt, route: `/procurement/handoffs/${h.HandoffId}`,
    }));
  }
  // WORKER: open work orders they lead (the GET /api/work-orders rule), soonest deadline first.
  const r = await query(
    `SELECT wo."Id", wo."WorkOrderNo", wo."Status", wo."Deadline", wo."CreatedAt" FROM "dbo"."WorkOrders" wo
      WHERE wo."ResponsibleLeadUserId"=$1 AND ${OPEN_WO}
      ORDER BY wo."Deadline" ASC NULLS LAST, wo."CreatedAt" ASC, wo."Id" LIMIT $2`,
    [user.id, limit]);
  return r.rows.map((w) => ({
    entityType: "WORK_ORDER", entityId: w.Id, action: w.Status, reference: w.WorkOrderNo, summary: null,
    priority: null, since: w.CreatedAt, dueAt: w.Deadline, route: `/work-orders/${w.Id}`,
  }));
}

/** Per-UTC-day counts for the last `days` days (today included), zero-filled. */
export async function trends(user, days) {
  const series = {};
  const daily = async (name, table, column, where = "", params = []) => {
    const r = await query(
      `SELECT to_char(d, 'YYYY-MM-DD') AS day, COUNT(t."Id")::int AS n
         FROM generate_series((now() AT TIME ZONE 'UTC')::date - ($1::int - 1), (now() AT TIME ZONE 'UTC')::date, interval '1 day') d
         LEFT JOIN "dbo"."${table}" t ON (t."${column}" AT TIME ZONE 'UTC')::date = d::date ${where}
        GROUP BY d ORDER BY d`,
      [days, ...params]);
    series[name] = r.rows.map((x) => ({ day: x.day, count: x.n }));
  };
  // Only fixed table/column names reach the SQL text; values are bound.
  if (MAINT.includes(user.role)) {
    await daily("reportsCreated", "Reports", "CreatedAt");
    await daily("workOrdersCompleted", "WorkOrders", "ResolvedAt", `AND t."Status"='COMPLETED'`);
  }
  if (PROC_READERS.includes(user.role)) {
    await daily("handoffsSubmitted", "ProcurementHandoffs", "SubmittedAt");
    await daily("handoffsCompleted", "ProcurementHandoffs", "CompletedAt");
  }
  if (user.role === "WORKER") {
    await daily("myWorkOrdersAssigned", "WorkOrders", "AssignedAt", `AND t."ResponsibleLeadUserId"=$2`, [user.id]);
    await daily("myWorkOrdersCompleted", "WorkOrders", "ResolvedAt", `AND t."Status"='COMPLETED' AND t."ResponsibleLeadUserId"=$2`, [user.id]);
  }
  return { days, series };
}

// ---------------------------------------------------------------------------------------------------------------
// Ask: API-chosen facts → Agent phrasing → re-checked answer.

const ASK_STATUSES = new Set(["ANSWERED", "NO_FACTS", "FALLBACK"]);

export async function buildFacts(user, context) {
  const facts = [];
  if (context) {
    const row = await assertRecordAccess(context.type, context.id, user);
    facts.push(recordFact(context.type, row));
  }
  facts.push({ id: "summary:current", kind: "summary", label: "Current workload summary", data: await summary(user), navigation: "/dashboard" });
  (await actionQueue(user, 10)).forEach((item, i) => facts.push({
    id: `queue:${i + 1}`, kind: "action_item", label: [item.reference, item.action].filter(Boolean).join(" "),
    data: item, navigation: item.route,
  }));
  return facts;
}

/** Never trust the Agent's ids or paths: keep only facts we sent, with OUR navigation path. */
export function sanitizeAnswer(response, facts) {
  const byId = new Map(facts.map((f) => [f.id, f]));
  if (!response || !ASK_STATUSES.has(response.status) || typeof response.answer !== "string") return null;
  const cited = Array.isArray(response.citedFactIds) ? [...new Set(response.citedFactIds.filter((id) => byId.has(id)))] : [];
  const navigation = (Array.isArray(response.navigation) ? response.navigation : [])
    .filter((n) => byId.get(n?.factId)?.navigation)
    .map((n) => ({ factId: n.factId, path: byId.get(n.factId).navigation, label: byId.get(n.factId).label }));
  return {
    status: response.status, answer: response.answer.slice(0, 1500), citedFactIds: cited, navigation,
    fallbackReason: response.fallbackReason ?? null, model: response.model ?? null,
    promptVersion: response.promptVersion ?? null, processingTimeMs: response.processingTimeMs ?? null,
  };
}

export function fallbackAnswer(facts, reason) {
  const nav = facts.filter((f) => f.navigation);
  return {
    status: "FALLBACK",
    answer: "The assistant is unavailable right now. Here are the records found for your question.",
    citedFactIds: facts.map((f) => f.id),
    navigation: nav.map((f) => ({ factId: f.id, path: f.navigation, label: f.label })),
    fallbackReason: reason, model: null, promptVersion: null, processingTimeMs: null,
  };
}

export async function ask(user, body, respond = agentClient.assistantRespond) {
  const question = text(body?.question, "question", { max: 1000 });
  let context = null;
  if (body?.context != null) {
    if (!RECORD_TYPES.includes(body.context.type)) throw new ApiError(400, "context.type must be report, work_order or handoff.", "INVALID_RECORD_TYPE");
    context = { type: body.context.type, id: uuid(body.context.id, "context.id") };
  }
  const facts = await buildFacts(user, context);
  try {
    return sanitizeAnswer(await respond({ role: user.role, question, facts }), facts) ?? fallbackAnswer(facts, "INVALID_AGENT_RESPONSE");
  } catch (error) {
    return fallbackAnswer(facts, error?.code || "AGENT_UNAVAILABLE");
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Drafts: private text; never a workflow write.

const DRAFT_KINDS = {
  REVIEW_NOTE: { type: "report", roles: MAINT },
  WORK_ORDER_UPDATE: { type: "work_order", roles: WORK },
  CLARIFICATION_REPLY: { type: "handoff", roles: PROC_READERS },
};

const presentDraft = (d) => ({
  id: d.Id, kind: d.Kind, entityType: d.EntityType, entityId: d.EntityId, body: d.Body, status: d.Status,
  createdAt: d.CreatedAt, updatedAt: d.UpdatedAt,
});

async function saveDraft(user, params, key) {
  const spec = DRAFT_KINDS[params?.kind];
  if (!spec) throw new ApiError(400, "kind must be REVIEW_NOTE, WORK_ORDER_UPDATE or CLARIFICATION_REPLY.", "INVALID_DRAFT_KIND");
  if (!spec.roles.includes(user.role)) throw forbidden("Your role cannot prepare this kind of draft.", "DRAFT_KIND_FORBIDDEN");
  const entityId = uuid(params.entityId, "entityId");
  const body = text(params.body, "body", { max: 8000 });
  await assertRecordAccess(spec.type, entityId, user);
  return withTransaction(user.id, async (c) => {
    const ins = await c.query(
      `INSERT INTO "dbo"."AssistantDrafts" ("UserId","Kind","EntityType","EntityId","Body","IdempotencyKey")
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT ON CONSTRAINT "UQ_AssistantDrafts_Idempotency" DO NOTHING RETURNING *`,
      [user.id, params.kind, spec.type, entityId, body, key]);
    if (ins.rows[0]) return { created: true, draft: presentDraft(ins.rows[0]) };
    const old = await c.query(`SELECT * FROM "dbo"."AssistantDrafts" WHERE "UserId"=$1 AND "IdempotencyKey"=$2`, [user.id, key]);
    return { created: false, draft: presentDraft(old.rows[0]) };
  });
}

async function discardDraft(user, params) {
  const id = uuid(params?.draftId, "draftId");
  const r = await query(
    `UPDATE "dbo"."AssistantDrafts" SET "Status"='DISCARDED' WHERE "Id"=$1 AND "UserId"=$2 RETURNING *`, [id, user.id]);
  if (!r.rows[0]) throw new ApiError(404, "Draft was not found.", "DRAFT_NOT_FOUND");
  return { draft: presentDraft(r.rows[0]) };
}

export async function listDrafts(user, { entityId } = {}) {
  const r = await query(
    `SELECT * FROM "dbo"."AssistantDrafts" WHERE "UserId"=$1 AND "Status"='DRAFT' AND ($2::uuid IS NULL OR "EntityId"=$2)
      ORDER BY "CreatedAt" DESC, "Id" LIMIT 200`,
    [user.id, entityId ? uuid(entityId, "entityId") : null]);
  return { items: r.rows.map(presentDraft) };
}

// ---------------------------------------------------------------------------------------------------------------
// Guarded assessment regeneration (queue only; the Agent claims via dbo."ClaimNextAssessmentRegeneration").

export const MAX_REASSESSMENTS_PER_REPORT = 5;

const presentJob = (j) => ({
  id: j.Id, reportId: j.ReportId, status: j.Status, reason: j.Reason, requestedBy: j.RequestedBy,
  attemptCount: j.AttemptCount, baseAgentAttempt: j.BaseAgentAttempt, lastError: j.LastError,
  createdAt: j.CreatedAt, claimedAt: j.ClaimedAt, finishedAt: j.FinishedAt,
});

async function requestReassessment(user, params, key) {
  const reportId = uuid(params?.reportId, "reportId");
  const reason = text(params?.reason, "reason", { min: 3, max: 1000 });
  return withTransaction(user.id, async (c) => {
    // The report lock serializes concurrent requests and the review route (which locks the same row).
    const rep = await c.query(`SELECT "Id","Status","AgentStatus","AgentAttemptCount" FROM "dbo"."Reports" WHERE "Id"=$1 FOR UPDATE`, [reportId]);
    const report = rep.rows[0];
    if (!report) throw new ApiError(404, "Report was not found.", "REPORT_NOT_FOUND");
    const replay = await c.query(`SELECT * FROM "dbo"."AssessmentRegenerationJobs" WHERE "RequestedBy"=$1 AND "IdempotencyKey"=$2`, [user.id, key]);
    if (replay.rows[0]) {
      if (replay.rows[0].ReportId !== reportId) throw conflict("This idempotencyKey was already used for another report.", "IDEMPOTENCY_KEY_REUSED");
      return { created: false, job: presentJob(replay.rows[0]) };
    }
    if (report.Status !== "PENDING_REVIEW" || report.AgentStatus !== "COMPLETED") {
      throw conflict("Only a report waiting for Maintenance Review with a completed assessment can be reassessed.", "REPORT_NOT_REASSESSABLE");
    }
    const ok = await c.query(`SELECT "dbo"."IsReportReassessable"($1) AS ok`, [reportId]);
    if (!ok.rows[0].ok) throw conflict("A human decision has already been recorded for this report.", "HUMAN_DECISION_EXISTS");
    const jobs = await c.query(`SELECT * FROM "dbo"."AssessmentRegenerationJobs" WHERE "ReportId"=$1 ORDER BY "CreatedAt" DESC`, [reportId]);
    const active = jobs.rows.find((j) => ["PENDING", "PROCESSING"].includes(j.Status));
    if (active) throw conflict("A reassessment is already queued for this report.", "REASSESSMENT_IN_PROGRESS", { job: presentJob(active) });
    if (jobs.rows.length >= MAX_REASSESSMENTS_PER_REPORT) {
      throw conflict(`This report has reached the limit of ${MAX_REASSESSMENTS_PER_REPORT} reassessments.`, "REASSESSMENT_LIMIT_REACHED");
    }
    const ins = await c.query(
      `INSERT INTO "dbo"."AssessmentRegenerationJobs" ("ReportId","RequestedBy","Reason","IdempotencyKey","BaseAgentAttempt")
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [reportId, user.id, reason, key, report.AgentAttemptCount]);
    await audit(c, user, "ASSESSMENT_REGENERATION_REQUESTED", "REPORT", reportId, { jobId: ins.rows[0].Id, reason });
    return { created: true, job: presentJob(ins.rows[0]) };
  });
}

async function cancelReassessment(user, params) {
  const id = uuid(params?.jobId, "jobId");
  return withTransaction(user.id, async (c) => {
    const r = await c.query(`SELECT * FROM "dbo"."AssessmentRegenerationJobs" WHERE "Id"=$1 FOR UPDATE`, [id]);
    const job = r.rows[0];
    if (!job) throw new ApiError(404, "Reassessment was not found.", "REASSESSMENT_NOT_FOUND");
    if (job.RequestedBy !== user.id && !SUPERVISORS.includes(user.role)) throw forbidden("Only the requester or a supervisor can cancel this reassessment.");
    if (job.Status === "CANCELLED") return { job: presentJob(job) };
    if (!["PENDING", "PROCESSING"].includes(job.Status)) throw conflict(`The reassessment is already ${job.Status}.`, "REASSESSMENT_FINISHED");
    const u = await c.query(
      `UPDATE "dbo"."AssessmentRegenerationJobs" SET "Status"='CANCELLED',"CancelledBy"=$2,"FinishedAt"=now() WHERE "Id"=$1 RETURNING *`,
      [id, user.id]);
    await audit(c, user, "ASSESSMENT_REGENERATION_CANCELLED", "REPORT", job.ReportId, { jobId: id });
    return { job: presentJob(u.rows[0]) };
  });
}

export async function reassessmentHistory(user, reportId) {
  if (!MAINT.includes(user.role)) throw forbidden("You do not have permission for this operation.");
  const id = uuid(reportId, "reportId");
  await assertReportAccess(id, user);
  const [jobs, attempts] = await Promise.all([
    query(`SELECT * FROM "dbo"."AssessmentRegenerationJobs" WHERE "ReportId"=$1 ORDER BY "CreatedAt" DESC, "Id"`, [id]),
    query(
      `SELECT "AgentAttemptCount" AS attempt, "ScopeDecision" AS "scopeDecision", "AiCategory" AS category,
              "AiRecommendedUrgency" AS urgency, "PriorityScore" AS "priorityScore", "AiModelId" AS model,
              "AiPromptVersion" AS "promptVersion", "CreatedAt" AS "createdAt"
         FROM "dbo"."ReportAssessmentHistory" WHERE "ReportId"=$1 ORDER BY "AgentAttemptCount" DESC`, [id]),
  ]);
  return { reportId: id, jobs: jobs.rows.map(presentJob), assessments: attempts.rows };
}

// ---------------------------------------------------------------------------------------------------------------
// Reminders. Scheduled in UTC; seefix-worker delivers (dbo."ClaimDueAssistantReminders" / "FinishAssistantReminder").

export const MAX_ACTIVE_REMINDERS = 50;

/** Who may receive a reminder from whom. Self always; never a REPORTER or an inactive account. */
export const REMINDER_RECIPIENT_ROLES = {
  ADMIN: INTERNAL_ROLES,
  MAINTENANCE_SUPERVISOR: ["MAINTENANCE_STAFF", "WORKER"],
};

export function canRemind(creator, recipient) {
  if (!recipient?.IsActive || !INTERNAL_ROLES.includes(recipient.Role)) return false;
  if (recipient.Id === creator.id) return true;
  return (REMINDER_RECIPIENT_ROLES[creator.role] ?? []).includes(recipient.Role);
}

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

const presentReminder = (r) => ({
  id: r.Id, createdBy: r.CreatedBy, recipientUserId: r.RecipientUserId, title: r.Title, message: r.Message,
  entityType: r.EntityType, entityId: r.EntityId, dueAt: r.DueAt, timeZone: r.TimeZone, status: r.Status,
  attempts: r.Attempts, sentAt: r.SentAt, cancelledAt: r.CancelledAt, lastError: r.LastError, createdAt: r.CreatedAt,
});

async function createReminder(user, params, key) {
  const title = text(params?.title, "title", { max: 250 });
  const message = params?.message == null || params.message === "" ? null : text(params.message, "message", { max: 2000 });
  const timeZone = text(params?.timeZone, "timeZone", { max: 64 });
  const dueAt = typeof params?.dueAt === "string" ? params.dueAt.trim() : "";
  if (!LOCAL_TIME.test(dueAt) && !INSTANT.test(dueAt)) {
    throw new ApiError(400, "dueAt must be a local time YYYY-MM-DDTHH:mm[:ss] or an ISO instant with an offset.", "INVALID_DUE_AT");
  }
  const recipientId = params?.recipientUserId == null ? user.id : uuid(params.recipientUserId, "recipientUserId");
  let entity = null;
  if (params?.entity != null) {
    if (!RECORD_TYPES.includes(params.entity.type)) throw new ApiError(400, "entity.type must be report, work_order or handoff.", "INVALID_RECORD_TYPE");
    entity = { type: params.entity.type, id: uuid(params.entity.id, "entity.id") };
  }

  const zone = await query(`SELECT 1 FROM pg_timezone_names WHERE name=$1`, [timeZone]);
  if (!zone.rowCount) throw new ApiError(400, "timeZone must be an IANA time zone such as Asia/Manila.", "INVALID_TIME_ZONE");
  let due;
  try {
    // Local wall time is read in timeZone; an instant keeps its offset. Stored as UTC timestamptz either way.
    due = (await query(
      `SELECT CASE WHEN $3 THEN $1::timestamp AT TIME ZONE $2 ELSE $1::timestamptz END AS due, now() AS now`,
      [dueAt, timeZone, LOCAL_TIME.test(dueAt)])).rows[0];
  } catch (error) {
    if (["22007", "22008"].includes(error?.code)) throw new ApiError(400, "dueAt is not a valid date and time.", "INVALID_DUE_AT");
    throw error;
  }
  if (due.due <= due.now) throw new ApiError(400, "dueAt must be in the future.", "INVALID_DUE_AT");
  if (due.due - due.now > 366 * 86400_000) throw new ApiError(400, "dueAt must be within one year.", "INVALID_DUE_AT");

  // Unknown, inactive, REPORTER or out-of-policy recipients all get the same answer (no account probing).
  const rec = (await query(`SELECT "Id","Role","IsActive" FROM "dbo"."Users" WHERE "Id"=$1`, [recipientId])).rows[0];
  if (!canRemind(user, rec)) throw forbidden("You cannot send a reminder to this user.", "REMINDER_RECIPIENT_FORBIDDEN");
  if (entity) {
    await assertRecordAccess(entity.type, entity.id, user);
    try {
      await assertRecordAccess(entity.type, entity.id, { id: rec.Id, role: rec.Role });
    } catch (error) {
      if (error?.status === 403) throw forbidden("The recipient cannot open this record.", "REMINDER_ENTITY_FORBIDDEN");
      throw error;
    }
  }

  return withTransaction(user.id, async (c) => {
    const old = await c.query(`SELECT * FROM "dbo"."AssistantReminders" WHERE "CreatedBy"=$1 AND "IdempotencyKey"=$2`, [user.id, key]);
    if (old.rows[0]) return { created: false, reminder: presentReminder(old.rows[0]) };
    // Per-creator lock: the limit check and insert can't race with another request from the same user.
    await c.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [`assistant-reminders:${user.id}`]);
    const active = await c.query(
      `SELECT COUNT(*)::int n FROM "dbo"."AssistantReminders" WHERE "CreatedBy"=$1 AND "Status" IN ('SCHEDULED','PROCESSING')`, [user.id]);
    if (active.rows[0].n >= MAX_ACTIVE_REMINDERS) throw conflict(`You can have at most ${MAX_ACTIVE_REMINDERS} active reminders.`, "REMINDER_LIMIT_REACHED");
    const ins = await c.query(
      `INSERT INTO "dbo"."AssistantReminders"
         ("CreatedBy","RecipientUserId","Title","Message","EntityType","EntityId","DueAt","TimeZone","NextRunAt","IdempotencyKey")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$7,$9)
       ON CONFLICT ON CONSTRAINT "UQ_AssistantReminders_Idempotency" DO NOTHING RETURNING *`,
      [user.id, rec.Id, title, message, entity?.type ?? null, entity?.id ?? null, due.due, timeZone, key]);
    if (!ins.rows[0]) {
      const again = await c.query(`SELECT * FROM "dbo"."AssistantReminders" WHERE "CreatedBy"=$1 AND "IdempotencyKey"=$2`, [user.id, key]);
      return { created: false, reminder: presentReminder(again.rows[0]) };
    }
    await audit(c, user, "ASSISTANT_REMINDER_CREATED", "ASSISTANT_REMINDER", ins.rows[0].Id,
      { recipientUserId: rec.Id, dueAt: due.due, timeZone, entityType: entity?.type ?? null, entityId: entity?.id ?? null });
    return { created: true, reminder: presentReminder(ins.rows[0]) };
  });
}

async function cancelReminder(user, params) {
  const id = uuid(params?.reminderId, "reminderId");
  return withTransaction(user.id, async (c) => {
    const r = await c.query(
      `SELECT * FROM "dbo"."AssistantReminders" WHERE "Id"=$1 AND ($2 IN ("CreatedBy","RecipientUserId")) FOR UPDATE`, [id, user.id]);
    const rem = r.rows[0];
    if (!rem) throw new ApiError(404, "Reminder was not found.", "REMINDER_NOT_FOUND");
    if (rem.Status === "CANCELLED") return { reminder: presentReminder(rem) };
    if (rem.Status === "SENT") throw conflict("The reminder has already been sent.", "REMINDER_ALREADY_SENT");
    // A PROCESSING reminder can be cancelled too: the Worker's FinishAssistantReminder is fenced on PROCESSING.
    const u = await c.query(
      `UPDATE "dbo"."AssistantReminders" SET "Status"='CANCELLED',"CancelledAt"=now(),"CancelledBy"=$2 WHERE "Id"=$1 RETURNING *`, [id, user.id]);
    await audit(c, user, "ASSISTANT_REMINDER_CANCELLED", "ASSISTANT_REMINDER", id, { previousStatus: rem.Status });
    return { reminder: presentReminder(u.rows[0]) };
  });
}

export async function listReminders(user, scope, paging) {
  if (!["received", "created"].includes(scope)) throw new ApiError(400, "scope must be received or created.", "INVALID_SCOPE");
  const column = scope === "received" ? `"RecipientUserId"` : `"CreatedBy"`; // fixed identifier, never request text
  const r = await query(
    `SELECT * FROM "dbo"."AssistantReminders" WHERE ${column}=$1 ORDER BY "DueAt" DESC, "Id" LIMIT $2 OFFSET $3`,
    [user.id, paging?.limit ?? 200, paging?.offset ?? 0]);
  return r.rows.map(presentReminder);
}

// ---------------------------------------------------------------------------------------------------------------
// The single write entry point: role + boundary check, explicit confirmation, idempotency key.

const HANDLERS = {
  save_draft: saveDraft,
  discard_draft: discardDraft,
  create_reminder: createReminder,
  cancel_reminder: cancelReminder,
  request_reassessment: requestReassessment,
  cancel_reassessment: cancelReassessment,
};
const NEEDS_KEY = new Set(["save_draft", "create_reminder", "request_reassessment"]);

const PREVIEWS = {
  save_draft: (p) => `Save a private ${p?.kind ?? ""} draft. Nothing is submitted; you submit it yourself on the record's page.`,
  discard_draft: () => "Discard this draft.",
  create_reminder: (p) => `Remind ${p?.recipientUserId ? "the selected user" : "you"} at ${p?.dueAt ?? "?"} (${p?.timeZone ?? "?"}): ${p?.title ?? ""}`,
  cancel_reminder: () => "Cancel this reminder.",
  request_reassessment: () => "Queue a new AI assessment for this report. The current assessment stays until the new one is ready, and your review decision is never changed.",
  cancel_reassessment: () => "Cancel the queued reassessment.",
};

export async function runAction(user, { action, params, confirm, idempotencyKey } = {}) {
  classifyAction(action, user.role);
  if (confirm !== true) {
    return { status: "CONFIRMATION_REQUIRED", action, preview: PREVIEWS[action](params) };
  }
  const key = NEEDS_KEY.has(action) ? uuid(idempotencyKey, "idempotencyKey") : null;
  const result = await HANDLERS[action](user, params ?? {}, key);
  return { status: "DONE", action, ...result };
}
