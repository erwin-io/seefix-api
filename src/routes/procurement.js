import { Router } from "express";
import { query, withTransaction } from "../database.js";
import { ApiError } from "../errors.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";
import { agentClient, bestEffort } from "../agent-client.js";
import { notifyRole } from "../services/notifications.js";
import { ensureWorkOrderForOutcome } from "../services/work-order-service.js";
import { memoryUpload } from "../uploads.js";
import { uploadBuffer, destroyAsset } from "../cloudinary.js";
import { config } from "../config.js";
const router = Router();
router.use(requireAuth);
const ACCESS = requireRoles("PROCUREMENT", "PPO_HEAD", "PPO_STAFF", "ADMIN");
router.get("/inbox", ACCESS, async (req, res, next) => {
  try {
    const r = await query(
      `SELECT * FROM "dbo"."v_ProcurementInbox" ORDER BY "EffectiveUrgency" DESC,"SubmittedAt" ASC`,
    );
    res.json({ items: r.rows });
  } catch (e) {
    next(e);
  }
});
router.get("/handoffs/:id", ACCESS, async (req, res, next) => {
  try {
    const h = await query(
      `SELECT ph.*,mr."RequestNo",mr."EffectiveCategory",mr."EffectiveUrgency",mr."RequiredService",mr."RequiredCapability",mr."ScopeOfWork",mr."SafetyRequirements",r."ReportNo" FROM "dbo"."ProcurementHandoffs" ph JOIN "dbo"."MaintenanceRequests" mr ON mr."Id"=ph."MaintenanceRequestId" JOIN "dbo"."Reports" r ON r."Id"=mr."ReportId" WHERE ph."Id"=$1`,
      [req.params.id],
    );
    if (!h.rows[0])
      throw new ApiError(
        404,
        "Procurement handoff was not found.",
        "HANDOFF_NOT_FOUND",
      );
    const [clarifications, docs, outcome] = await Promise.all([
      query(
        `SELECT * FROM "dbo"."ProcurementClarifications" WHERE "ProcurementHandoffId"=$1 ORDER BY "AskedAt"`,
        [req.params.id],
      ),
      query(
        `SELECT * FROM "dbo"."ProcurementDocuments" WHERE "ProcurementHandoffId"=$1 ORDER BY "CreatedAt"`,
        [req.params.id],
      ),
      query(
        `SELECT * FROM "dbo"."ProcurementOutcomes" WHERE "ProcurementHandoffId"=$1`,
        [req.params.id],
      ),
    ]);
    res.json({
      handoff: h.rows[0],
      clarifications: clarifications.rows,
      documents: docs.rows,
      outcome: outcome.rows[0] || null,
    });
  } catch (e) {
    next(e);
  }
});
router.post(
  "/handoffs/:id/acknowledge",
  requireRoles("PROCUREMENT", "ADMIN"),
  async (req, res, next) => {
    try {
      const r = await withTransaction(req.user.id, (c) =>
        c.query(
          `UPDATE "dbo"."ProcurementHandoffs" SET "Status"=CASE WHEN "Status"='SUBMITTED' THEN 'ACKNOWLEDGED' ELSE "Status" END,"AcknowledgedBy"=COALESCE("AcknowledgedBy",$2),"AcknowledgedAt"=COALESCE("AcknowledgedAt",NOW()),"UpdatedAt"=NOW() WHERE "Id"=$1 AND "Status" NOT IN ('COMPLETED','CANCELLED') RETURNING *`,
          [req.params.id, req.user.id],
        ),
      );
      if (!r.rows[0])
        throw new ApiError(
          404,
          "Active Procurement handoff was not found.",
          "HANDOFF_NOT_FOUND",
        );
      res.json({ handoff: r.rows[0] });
    } catch (e) {
      next(e);
    }
  },
);
router.post(
  "/handoffs/:id/start",
  requireRoles("PROCUREMENT", "ADMIN"),
  async (req, res, next) => {
    try {
      const r = await withTransaction(req.user.id, (c) =>
        c.query(
          `UPDATE "dbo"."ProcurementHandoffs" SET "Status"='IN_PROCESS',"AcknowledgedBy"=COALESCE("AcknowledgedBy",$2),"AcknowledgedAt"=COALESCE("AcknowledgedAt",NOW()),"ExternalSystemReference"=COALESCE($3,"ExternalSystemReference"),"ExternalSystemUrl"=COALESCE($4,"ExternalSystemUrl"),"UpdatedAt"=NOW() WHERE "Id"=$1 AND "Status" IN ('SUBMITTED','ACKNOWLEDGED','IN_PROCESS') RETURNING *`,
          [
            req.params.id,
            req.user.id,
            req.body?.externalSystemReference || null,
            req.body?.externalSystemUrl || null,
          ],
        ),
      );
      if (!r.rows[0])
        throw new ApiError(
          409,
          "Handoff cannot be moved to IN_PROCESS from its current state.",
          "INVALID_HANDOFF_STATE",
        );
      res.json({ handoff: r.rows[0] });
    } catch (e) {
      next(e);
    }
  },
);
router.post(
  "/handoffs/:id/clarifications",
  requireRoles("PROCUREMENT", "ADMIN"),
  async (req, res, next) => {
    try {
      const question = String(req.body?.question || "").trim();
      if (!question)
        throw new ApiError(
          400,
          "Clarification question is required.",
          "QUESTION_REQUIRED",
        );
      const c = await withTransaction(req.user.id, async (client) => {
        const h = await client.query(
          `SELECT * FROM "dbo"."ProcurementHandoffs" WHERE "Id"=$1 FOR UPDATE`,
          [req.params.id],
        );
        if (!h.rows[0] || ["COMPLETED", "CANCELLED"].includes(h.rows[0].Status))
          throw new ApiError(
            409,
            "Procurement handoff is not open for clarification.",
            "INVALID_HANDOFF_STATE",
          );
        const r = await client.query(
          `INSERT INTO "dbo"."ProcurementClarifications" ("ProcurementHandoffId","Question","AskedByUserId","AskedByName","AskedByEmail") VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [
            req.params.id,
            question,
            req.user.id,
            req.user.fullName,
            req.user.email,
          ],
        );
        await client.query(
          `UPDATE "dbo"."ProcurementHandoffs" SET "Status"='CLARIFICATION_REQUIRED',"UpdatedAt"=NOW() WHERE "Id"=$1`,
          [req.params.id],
        );
        await client.query(
          `INSERT INTO "dbo"."WorkflowActionItems" ("EntityType","EntityId","ActionType","AssignedRole","Priority","Title","Message") VALUES ('PROCUREMENT_CLARIFICATION',$1,'ANSWER_PROCUREMENT_CLARIFICATION','PPO_HEAD','HIGH','Procurement clarification requires response',$2)`,
          [r.rows[0].Id, question],
        );
        await notifyRole(client, "PPO_HEAD", {
          type: "PROCUREMENT_CLARIFICATION",
          title: "Procurement clarification",
          message: question,
          entityType: "PROCUREMENT_CLARIFICATION",
          entityId: r.rows[0].Id,
          payload: { handoffId: req.params.id },
        });
        return r.rows[0];
      });
      const draft = await bestEffort(`clarification draft ${c.Id}`, () =>
        agentClient.draftClarification(req.params.id, c.Id),
      );
      res
        .status(201)
        .json({
          clarification: c,
          aiDraftGenerated: draft.ok,
          aiDraft: draft.ok ? draft.value : null,
        });
    } catch (e) {
      next(e);
    }
  },
);
router.post(
  "/handoffs/:id/documents",
  requireRoles("PROCUREMENT", "ADMIN"),
  memoryUpload.single("file"),
  async (req, res, next) => {
    let uploaded = null;
    try {
      if (!req.file)
        throw new ApiError(
          400,
          "A document file is required.",
          "DOCUMENT_REQUIRED",
        );
      const type = String(req.body?.documentType || "OTHER").toUpperCase();
      if (
        ![
          "REQUEST_PACKAGE",
          "PROCUREMENT_REFERENCE",
          "CLARIFICATION_ATTACHMENT",
          "OUTCOME_REFERENCE",
          "OTHER",
        ].includes(type)
      )
        throw new ApiError(
          400,
          "documentType is invalid.",
          "INVALID_DOCUMENT_TYPE",
        );
      const handoff = await query(
        `SELECT "Id" FROM "dbo"."ProcurementHandoffs" WHERE "Id"=$1`,
        [req.params.id],
      );
      if (!handoff.rows[0])
        throw new ApiError(
          404,
          "Procurement handoff was not found.",
          "HANDOFF_NOT_FOUND",
        );
      uploaded = await uploadBuffer(req.file.buffer, {
        folder: config.cloudinaryDocumentFolder,
        resourceType: "auto",
      });
      const r = await withTransaction(req.user.id, (c) =>
        c.query(
          `INSERT INTO "dbo"."ProcurementDocuments" ("ProcurementHandoffId","ClarificationId","DocumentType","StorageProvider","PublicId","SecureUrl","FileName","MimeType","Bytes","UploadedBy") VALUES ($1,$2,$3,'CLOUDINARY',$4,$5,$6,$7,$8,$9) RETURNING *`,
          [
            req.params.id,
            req.body?.clarificationId || null,
            type,
            uploaded.public_id,
            uploaded.secure_url,
            req.file.originalname || null,
            req.file.mimetype || null,
            req.file.size || uploaded.bytes || null,
            req.user.id,
          ],
        ),
      );
      res.status(201).json({ document: r.rows[0] });
    } catch (e) {
      if (uploaded)
        await destroyAsset(uploaded.public_id, uploaded.resource_type || "raw");
      next(e);
    }
  },
);
router.post(
  "/handoffs/:id/outcome",
  requireRoles("PROCUREMENT", "ADMIN"),
  async (req, res, next) => {
    try {
      const executionType = String(req.body?.executionType || "").toUpperCase();
      if (
        ![
          "INTERNAL",
          "AGENCY",
          "CONTRACTOR",
          "INDIVIDUAL",
          "GROUP",
          "OTHER",
        ].includes(executionType)
      )
        throw new ApiError(
          400,
          "executionType is invalid.",
          "INVALID_EXECUTION_TYPE",
        );
      if (!String(req.body?.assignedPartyName || "").trim())
        throw new ApiError(
          400,
          "assignedPartyName is required.",
          "VALIDATION_ERROR",
        );
      if (
        !req.body?.responsibleLeadUserId &&
        !String(req.body?.responsibleLeadName || "").trim()
      )
        throw new ApiError(
          400,
          "A responsible lead user or name is required.",
          "VALIDATION_ERROR",
        );
      const outcome = await withTransaction(req.user.id, async (client) => {
        const hq = await client.query(
          `SELECT * FROM "dbo"."ProcurementHandoffs" WHERE "Id"=$1 FOR UPDATE`,
          [req.params.id],
        );
        const h = hq.rows[0];
        if (!h)
          throw new ApiError(
            404,
            "Procurement handoff was not found.",
            "HANDOFF_NOT_FOUND",
          );
        if (["COMPLETED", "CANCELLED"].includes(h.Status))
          throw new ApiError(
            409,
            "Procurement handoff is already closed.",
            "INVALID_HANDOFF_STATE",
          );
        const ins = await client.query(
          `INSERT INTO "dbo"."ProcurementOutcomes" ("ProcurementHandoffId","MaintenanceRequestId","ProcurementReferenceNo","ExecutionType","AssignedPartyName","ResponsibleLeadUserId","ResponsibleLeadName","ResponsibleLeadContact","ResponsibleLeadEmail","PlannedStartAt","AgreedDurationDays","PlannedDeadlineAt","PlannedCrewSize","ReferenceDocumentId","Notes","RecordedBy") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
          [
            h.Id,
            h.MaintenanceRequestId,
            req.body?.procurementReferenceNo ||
              h.ExternalSystemReference ||
              null,
            executionType,
            req.body.assignedPartyName,
            req.body?.responsibleLeadUserId || null,
            req.body?.responsibleLeadName || null,
            req.body?.responsibleLeadContact || null,
            req.body?.responsibleLeadEmail || null,
            req.body?.plannedStartAt || null,
            req.body?.agreedDurationDays ?? null,
            req.body?.plannedDeadlineAt || null,
            req.body?.plannedCrewSize ?? null,
            req.body?.referenceDocumentId || null,
            req.body?.notes || null,
            req.user.id,
          ],
        );
        await client.query(
          `UPDATE "dbo"."ProcurementHandoffs" SET "Status"='COMPLETED',"CompletedBy"=$2,"CompletedAt"=NOW(),"ExternalSystemReference"=COALESCE($3,"ExternalSystemReference"),"UpdatedAt"=NOW() WHERE "Id"=$1`,
          [h.Id, req.user.id, req.body?.procurementReferenceNo || null],
        );
        await client.query(
          `UPDATE "dbo"."MaintenanceRequests" SET "Status"='PROCUREMENT_COMPLETED',"UpdatedAt"=NOW() WHERE "Id"=$1`,
          [h.MaintenanceRequestId],
        );
        return ins.rows[0];
      });
      const workOrder = await ensureWorkOrderForOutcome(
        outcome.Id,
        req.user.id,
      );
      res.status(201).json({ outcome, workOrder });
    } catch (e) {
      next(e);
    }
  },
);
export default router;
