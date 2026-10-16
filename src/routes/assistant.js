import { Router } from "express";
import { requireAuth, requireRoles } from "../middleware/auth.js";
import { limits } from "../security/policies.js";
import { pageParams, pageResult } from "../utils/pagination.js";
import {
  INTERNAL_ROLES, RECORD_TYPES, toolCatalog, navigationFor, summary, actionQueue, trends, assertRecordAccess,
  recordFact, ask, runAction, listDrafts, listReminders, reassessmentHistory,
} from "../services/assistant-service.js";
import { ApiError } from "../errors.js";

/**
 * Web Admin V2 assistant API (seefix-api#21, docs/V2_ASSISTANT.md). Internal roles only (REPORTER → 403).
 * GET tools are read-only and not cached. Every write goes through runAction: role + prohibited-action boundary,
 * `confirm: true`, idempotency key.
 */
const router = Router();
router.use(requireAuth, requireRoles(...INTERNAL_ROLES), (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

const handle = (fn) => async (req, res, next) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined) res.json(out);
  } catch (error) {
    next(error);
  }
};
const intQuery = (value, field, min, max, fallback) => {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new ApiError(400, `${field} must be an integer from ${min} to ${max}.`, "INVALID_VALUE");
  return n;
};

// --- Read-only tools.
router.get("/tools", handle((req) => toolCatalog(req.user.role)));
router.get("/tools/navigation", handle((req) => ({ items: navigationFor(req.user.role) })));
router.get("/tools/summary", handle((req) => summary(req.user)));
router.get("/tools/action-queue", handle(async (req) => ({ items: await actionQueue(req.user, intQuery(req.query.limit, "limit", 1, 50, 10)) })));
router.get("/tools/trends", handle((req) => trends(req.user, intQuery(req.query.days, "days", 7, 90, 14))));
router.get("/tools/records/:type/:id", handle(async (req) => {
  if (!RECORD_TYPES.includes(req.params.type)) throw new ApiError(400, "type must be report, work_order or handoff.", "INVALID_RECORD_TYPE");
  return { fact: recordFact(req.params.type, await assertRecordAccess(req.params.type, req.params.id, req.user)) };
}));

// --- Chat: API-chosen facts, Agent phrasing, answer re-checked against the facts.
router.post("/ask", ...limits.assistantAsk, handle((req) => ask(req.user, req.body)));

// --- Writes. Reassessment requests share the AI generation budget.
// Only a confirmed request counts against the budget; a preview costs nothing.
const reassessmentLimit = (isReassessment) => (req, res, next) =>
  (req.body?.confirm === true && isReassessment(req) ? limits.aiGenerate[0](req, res, next) : next());
const respond = (res, out) => {
  res.status(out.created ? 201 : 200);
  return out;
};
router.post("/actions", reassessmentLimit((req) => req.body.action === "request_reassessment"), handle((req, res) => runAction(req.user, req.body ?? {}).then((out) => respond(res, out))));

// REST shapes of the same actions (same checks, same confirmation).
const asAction = (action, params) => handle((req, res) =>
  runAction(req.user, { action, params: params(req), confirm: req.body?.confirm, idempotencyKey: req.body?.idempotencyKey })
    .then((out) => respond(res, out)));
router.post("/reminders", asAction("create_reminder", (req) => req.body));
router.post("/reminders/:id/cancel", asAction("cancel_reminder", (req) => ({ reminderId: req.params.id })));
router.post("/reassessments", reassessmentLimit(() => true), asAction("request_reassessment", (req) => req.body));
router.post("/reassessments/:id/cancel", asAction("cancel_reassessment", (req) => ({ jobId: req.params.id })));
router.post("/drafts", asAction("save_draft", (req) => req.body));
router.post("/drafts/:id/discard", asAction("discard_draft", (req) => ({ draftId: req.params.id })));

router.get("/reminders", handle(async (req) => {
  const paging = pageParams(req.query);
  const rows = await listReminders(req.user, String(req.query.scope ?? "received"), paging);
  return paging ? pageResult(rows, paging) : { items: rows };
}));
router.get("/reassessments", handle((req) => reassessmentHistory(req.user, req.query.reportId)));
router.get("/drafts", handle((req) => listDrafts(req.user, { entityId: req.query.entityId })));

export default router;
