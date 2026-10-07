import { Router } from "express";
import { query, withTransaction } from "../database.js";
import { ApiError } from "../errors.js";
import { requireAuth } from "../middleware/auth.js";
import { memoryUpload, requireImageFiles } from "../uploads.js";
import { createReport, getReportDetail } from "../services/report-service.js";
import { agentClient, bestEffort } from "../agent-client.js";

const router = Router();
router.use(requireAuth);
router.post("/", memoryUpload.array("images"), async (req, res, next) => {
  try {
    const files = requireImageFiles(req.files, { min: 1 });
    const gpsLat =
      req.body.gpsLat == null || req.body.gpsLat === ""
        ? null
        : Number(req.body.gpsLat);
    const gpsLng =
      req.body.gpsLng == null || req.body.gpsLng === ""
        ? null
        : Number(req.body.gpsLng);
    if (
      gpsLat !== null &&
      (!Number.isFinite(gpsLat) || gpsLat < -90 || gpsLat > 90)
    )
      throw new ApiError(
        400,
        "gpsLat must be between -90 and 90.",
        "VALIDATION_ERROR",
      );
    if (
      gpsLng !== null &&
      (!Number.isFinite(gpsLng) || gpsLng < -180 || gpsLng > 180)
    )
      throw new ApiError(
        400,
        "gpsLng must be between -180 and 180.",
        "VALIDATION_ERROR",
      );
    const report = await createReport(
      req.user,
      {
        description: req.body.description,
        notes: req.body.notes,
        building: req.body.building,
        floor: req.body.floor,
        roomOrArea: req.body.roomOrArea,
        gpsLat,
        gpsLng,
      },
      files,
    );
    res.status(201).json(report);
  } catch (e) {
    next(e);
  }
});

router.get("/my", async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const status = req.query.status ? String(req.query.status) : null;
    const result = await query(
      `SELECT r."Id" AS id,r."ReportNo" AS "reportNo",r."Status" AS status,r."AgentStatus" AS "agentStatus",r."AnalysisStatus" AS "analysisStatus",r."ScopeDecision" AS "scopeDecision",p."EffectiveCategory" AS "effectiveCategory",p."EffectiveUrgency" AS "effectiveUrgency",p."LivePriorityScore" AS "priorityScore",r."AiSummary" AS summary,r."CreatedAt" AS "createdAt",(SELECT ri."SecureUrl" FROM "dbo"."ReportImages" ri WHERE ri."ReportId"=r."Id" ORDER BY ri."IsPrimary" DESC,ri."CreatedAt" LIMIT 1) AS "primaryImageUrl" FROM "dbo"."Reports" r LEFT JOIN "dbo"."v_ReportPriorityLive" p ON p."Id"=r."Id" WHERE r."ReporterId"=$1 AND ($2::text IS NULL OR r."Status"=$2) ORDER BY r."CreatedAt" DESC LIMIT $3`,
      [req.user.id, status, limit],
    );
    res.json({ items: result.rows });
  } catch (e) {
    next(e);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    res.json(await getReportDetail(req.params.id, req.user));
  } catch (e) {
    next(e);
  }
});
router.get("/:id/agent-status", async (req, res, next) => {
  try {
    await getReportDetail(req.params.id, req.user);
    const attempt = await bestEffort("report status", () =>
      agentClient.reportStatus(req.params.id),
    );
    if (attempt.ok) return res.json(attempt.value);
    const db = await query(
      `SELECT "Id" AS "reportId","ReportNo" AS "reportNo","Status" AS "businessStatus","AgentStatus" AS "agentStatus","AgentAttemptCount" AS "attemptCount","AgentStartedAt" AS "agentStartedAt","AgentCompletedAt" AS "agentCompletedAt","AgentLastError" AS "lastError" FROM "dbo"."Reports" WHERE "Id"=$1`,
      [req.params.id],
    );
    res.json({ ...db.rows[0], source: "database", agentReachable: false });
  } catch (e) {
    next(e);
  }
});
router.post("/:id/verifications", async (req, res, next) => {
  try {
    const report = await query(
      `SELECT "ReporterId","Status" FROM "dbo"."Reports" WHERE "Id"=$1`,
      [req.params.id],
    );
    if (!report.rows[0])
      throw new ApiError(404, "Report was not found.", "REPORT_NOT_FOUND");
    if (String(report.rows[0].ReporterId) === String(req.user.id))
      throw new ApiError(
        409,
        "A Reporter cannot independently verify their own report.",
        "SELF_VERIFICATION_NOT_ALLOWED",
      );
    const row = await withTransaction(req.user.id, async (client) => {
      const r = await client.query(
        `INSERT INTO "dbo"."ReportVerifications" ("ReportId","UserId","Source","Note") VALUES ($1,$2,'APP',$3) ON CONFLICT ("ReportId","UserId") DO UPDATE SET "Note"=EXCLUDED."Note" RETURNING "Id" AS id,"CreatedAt" AS "createdAt"`,
        [req.params.id, req.user.id, req.body?.note || null],
      );
      return r.rows[0];
    });
    res.status(201).json(row);
  } catch (e) {
    next(e);
  }
});
export default router;
