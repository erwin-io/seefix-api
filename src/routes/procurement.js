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

const ACCESS = requireRoles(
  "PROCUREMENT",
  "MAINTENANCE_STAFF",
  "MAINTENANCE_SUPERVISOR",
  "ADMIN",
);

router.get("/inbox", ACCESS, async (_req, res, next) => {
  try {
    const result = await query(
      `SELECT *
       FROM "dbo"."v_ProcurementInbox"
       ORDER BY
         "LivePriorityScore" DESC NULLS LAST,
         "SubmittedAt" ASC`,
    );

    res.json({ items: result.rows });
  } catch (error) {
    next(error);
  }
});

router.get("/handoffs/:id", ACCESS, async (req, res, next) => {
  try {
    const handoffResult = await query(
      `SELECT
         ph.*,
         rv."Decision" AS "MaintenanceReviewDecision",
         rv."ReviewedAt" AS "MaintenanceReviewedAt",
         mr."RequestNo",
         mr."EffectiveCategory",
         mr."EffectiveUrgency",
         mr."RequiredService",
         mr."RequiredCapability",
         mr."ScopeOfWork",
         mr."SafetyRequirements",
         r."ReportNo",
         r."Id" AS "ReportId"
       FROM "dbo"."ProcurementHandoffs" ph
       JOIN "dbo"."MaintenanceReviews" rv
         ON rv."Id"=ph."MaintenanceReviewId"
       JOIN "dbo"."MaintenanceRequests" mr
         ON mr."Id"=ph."MaintenanceRequestId"
       JOIN "dbo"."Reports" r
         ON r."Id"=mr."ReportId"
       WHERE ph."Id"=$1`,
      [req.params.id],
    );

    if (!handoffResult.rows[0]) {
      throw new ApiError(
        404,
        "Procurement handoff was not found.",
        "HANDOFF_NOT_FOUND",
      );
    }

    const [clarifications, documents, outcome] =
      await Promise.all([
        query(
          `SELECT *
           FROM "dbo"."ProcurementClarifications"
           WHERE "ProcurementHandoffId"=$1
           ORDER BY "AskedAt"`,
          [req.params.id],
        ),
        query(
          `SELECT *
           FROM "dbo"."ProcurementDocuments"
           WHERE "ProcurementHandoffId"=$1
           ORDER BY "CreatedAt"`,
          [req.params.id],
        ),
        query(
          `SELECT *
           FROM "dbo"."ProcurementOutcomes"
           WHERE "ProcurementHandoffId"=$1`,
          [req.params.id],
        ),
      ]);

    res.json({
      handoff: handoffResult.rows[0],
      clarifications: clarifications.rows,
      documents: documents.rows,
      outcome: outcome.rows[0] || null,
    });
  } catch (error) {
    next(error);
  }
});

router.post(
  "/handoffs/:id/acknowledge",
  requireRoles("PROCUREMENT", "ADMIN"),
  async (req, res, next) => {
    try {
      const result = await withTransaction(
        req.user.id,
        (client) =>
          client.query(
            `UPDATE "dbo"."ProcurementHandoffs"
             SET
               "Status"=
                 CASE
                   WHEN "Status"='SUBMITTED'
                   THEN 'ACKNOWLEDGED'
                   ELSE "Status"
                 END,
               "AcknowledgedBy"=
                 COALESCE("AcknowledgedBy",$2),
               "AcknowledgedAt"=
                 COALESCE("AcknowledgedAt",NOW()),
               "UpdatedAt"=NOW()
             WHERE "Id"=$1
               AND "Status" NOT IN ('COMPLETED','CANCELLED')
             RETURNING *`,
            [req.params.id, req.user.id],
          ),
      );

      if (!result.rows[0]) {
        throw new ApiError(
          404,
          "Active Procurement handoff was not found.",
          "HANDOFF_NOT_FOUND",
        );
      }

      res.json({
        handoff: result.rows[0],
      });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/handoffs/:id/start",
  requireRoles("PROCUREMENT", "ADMIN"),
  async (req, res, next) => {
    try {
      const result = await withTransaction(
        req.user.id,
        (client) =>
          client.query(
            `UPDATE "dbo"."ProcurementHandoffs"
             SET
               "Status"='IN_PROCESS',
               "AcknowledgedBy"=
                 COALESCE("AcknowledgedBy",$2),
               "AcknowledgedAt"=
                 COALESCE("AcknowledgedAt",NOW()),
               "ExternalSystemReference"=
                 COALESCE($3,"ExternalSystemReference"),
               "ExternalSystemUrl"=
                 COALESCE($4,"ExternalSystemUrl"),
               "UpdatedAt"=NOW()
             WHERE "Id"=$1
               AND "Status" IN
                   ('SUBMITTED','ACKNOWLEDGED','IN_PROCESS')
             RETURNING *`,
            [
              req.params.id,
              req.user.id,
              req.body?.externalSystemReference || null,
              req.body?.externalSystemUrl || null,
            ],
          ),
      );

      if (!result.rows[0]) {
        throw new ApiError(
          409,
          "Handoff cannot be moved to IN_PROCESS from its current state.",
          "INVALID_HANDOFF_STATE",
        );
      }

      res.json({
        handoff: result.rows[0],
      });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/handoffs/:id/clarifications",
  requireRoles("PROCUREMENT", "ADMIN"),
  async (req, res, next) => {
    try {
      const question = String(
        req.body?.question || "",
      ).trim();

      if (!question) {
        throw new ApiError(
          400,
          "Clarification question is required.",
          "QUESTION_REQUIRED",
        );
      }

      const clarification =
        await withTransaction(
          req.user.id,
          async (client) => {
            const handoffResult =
              await client.query(
                `SELECT *
                 FROM "dbo"."ProcurementHandoffs"
                 WHERE "Id"=$1
                 FOR UPDATE`,
                [req.params.id],
              );

            const handoff =
              handoffResult.rows[0];

            if (
              !handoff ||
              ["COMPLETED", "CANCELLED"].includes(
                handoff.Status,
              )
            ) {
              throw new ApiError(
                409,
                "Procurement handoff is not open for clarification.",
                "INVALID_HANDOFF_STATE",
              );
            }

            const inserted =
              await client.query(
                `INSERT INTO "dbo"."ProcurementClarifications"
                   ("ProcurementHandoffId","Question",
                    "AskedByUserId","AskedByName",
                    "AskedByEmail")
                 VALUES ($1,$2,$3,$4,$5)
                 RETURNING *`,
                [
                  req.params.id,
                  question,
                  req.user.id,
                  req.user.fullName,
                  req.user.email,
                ],
              );

            const row = inserted.rows[0];

            await client.query(
              `UPDATE "dbo"."ProcurementHandoffs"
               SET
                 "Status"='CLARIFICATION_REQUIRED',
                 "UpdatedAt"=NOW()
               WHERE "Id"=$1`,
              [req.params.id],
            );

            await client.query(
              `INSERT INTO "dbo"."WorkflowActionItems"
                 ("EntityType","EntityId","ActionType",
                  "AssignedRole","Priority","Title","Message")
               VALUES
                 ('PROCUREMENT_CLARIFICATION',$1,
                  'ANSWER_PROCUREMENT_CLARIFICATION',
                  'MAINTENANCE_SUPERVISOR','HIGH',
                  'Procurement clarification requires response',
                  $2)`,
              [row.Id, question],
            );

            await notifyRole(
              client,
              "MAINTENANCE_SUPERVISOR",
              {
                type:
                  "PROCUREMENT_CLARIFICATION",
                title:
                  "Procurement clarification",
                message: question,
                entityType:
                  "PROCUREMENT_CLARIFICATION",
                entityId: row.Id,
                payload: {
                  handoffId:
                    req.params.id,
                },
                deduplicationKey:
                  `procurement-clarification:${row.Id}:open`,
              },
            );

            return row;
          },
        );

      const draft = await bestEffort(
        `clarification draft ${clarification.Id}`,
        () =>
          agentClient.draftClarification(
            req.params.id,
            clarification.Id,
          ),
      );

      res.status(201).json({
        clarification,
        aiDraftGenerated: draft.ok,
        aiDraft: draft.ok
          ? draft.value
          : null,
      });
    } catch (error) {
      next(error);
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
      if (!req.file) {
        throw new ApiError(
          400,
          "A document file is required.",
          "DOCUMENT_REQUIRED",
        );
      }

      const type = String(
        req.body?.documentType || "OTHER",
      ).toUpperCase();

      if (
        ![
          "REQUEST_PACKAGE",
          "PROCUREMENT_REFERENCE",
          "CLARIFICATION_ATTACHMENT",
          "OUTCOME_REFERENCE",
          "OTHER",
        ].includes(type)
      ) {
        throw new ApiError(
          400,
          "documentType is invalid.",
          "INVALID_DOCUMENT_TYPE",
        );
      }

      const handoff = await query(
        `SELECT "Id"
         FROM "dbo"."ProcurementHandoffs"
         WHERE "Id"=$1`,
        [req.params.id],
      );

      if (!handoff.rows[0]) {
        throw new ApiError(
          404,
          "Procurement handoff was not found.",
          "HANDOFF_NOT_FOUND",
        );
      }

      const clarificationId =
        req.body?.clarificationId || null;

      if (clarificationId) {
        const clarification = await query(
          `SELECT "Id"
           FROM "dbo"."ProcurementClarifications"
           WHERE "Id"=$1
             AND "ProcurementHandoffId"=$2`,
          [clarificationId, req.params.id],
        );

        if (!clarification.rows[0]) {
          throw new ApiError(
            400,
            "clarificationId must belong to the same Procurement handoff.",
            "INVALID_CLARIFICATION_REFERENCE",
          );
        }
      }

      uploaded = await uploadBuffer(
        req.file.buffer,
        {
          folder:
            config.cloudinaryDocumentFolder,
          resourceType: "auto",
        },
      );

      const result = await withTransaction(
        req.user.id,
        (client) =>
          client.query(
            `INSERT INTO "dbo"."ProcurementDocuments"
               ("ProcurementHandoffId","ClarificationId",
                "DocumentType","StorageProvider",
                "PublicId","SecureUrl","FileName",
                "MimeType","Bytes","UploadedBy")
             VALUES
               ($1,$2,$3,'CLOUDINARY',$4,$5,$6,$7,$8,$9)
             RETURNING *`,
            [
              req.params.id,
              clarificationId,
              type,
              uploaded.public_id,
              uploaded.secure_url,
              req.file.originalname || null,
              req.file.mimetype || null,
              req.file.size ||
                uploaded.bytes ||
                null,
              req.user.id,
            ],
          ),
      );

      res.status(201).json({
        document: result.rows[0],
      });
    } catch (error) {
      if (uploaded) {
        await destroyAsset(
          uploaded.public_id,
          uploaded.resource_type || "raw",
        );
      }

      next(error);
    }
  },
);

router.post(
  "/handoffs/:id/outcome",
  requireRoles("PROCUREMENT", "ADMIN"),
  async (req, res, next) => {
    try {
      const executionType = String(
        req.body?.executionType || "",
      ).toUpperCase();

      if (
        ![
          "INTERNAL",
          "AGENCY",
          "CONTRACTOR",
          "INDIVIDUAL",
          "GROUP",
          "OTHER",
        ].includes(executionType)
      ) {
        throw new ApiError(
          400,
          "executionType is invalid.",
          "INVALID_EXECUTION_TYPE",
        );
      }

      if (
        !String(
          req.body?.assignedPartyName || "",
        ).trim()
      ) {
        throw new ApiError(
          400,
          "assignedPartyName is required.",
          "VALIDATION_ERROR",
        );
      }

      if (
        !req.body?.responsibleLeadUserId &&
        !String(
          req.body?.responsibleLeadName || "",
        ).trim()
      ) {
        throw new ApiError(
          400,
          "A responsible lead user or name is required.",
          "VALIDATION_ERROR",
        );
      }

      const outcome = await withTransaction(
        req.user.id,
        async (client) => {
          const handoffResult =
            await client.query(
              `SELECT
                 ph.*,
                 rv."Status" AS "MaintenanceReviewStatus",
                 rv."Decision" AS "MaintenanceReviewDecision"
               FROM "dbo"."ProcurementHandoffs" ph
               JOIN "dbo"."MaintenanceReviews" rv
                 ON rv."Id"=ph."MaintenanceReviewId"
               WHERE ph."Id"=$1
               FOR UPDATE OF ph`,
              [req.params.id],
            );

          const handoff =
            handoffResult.rows[0];

          if (!handoff) {
            throw new ApiError(
              404,
              "Procurement handoff was not found.",
              "HANDOFF_NOT_FOUND",
            );
          }

          if (
            handoff.MaintenanceReviewStatus !==
              "COMPLETED" ||
            handoff.MaintenanceReviewDecision !==
              "PROCUREMENT"
          ) {
            throw new ApiError(
              409,
              "Procurement outcome requires a completed PROCUREMENT Maintenance Review.",
              "INVALID_MAINTENANCE_REVIEW_STATE",
            );
          }

          if (handoff.Status === "COMPLETED") {
            const existingOutcome =
              await client.query(
                `SELECT *
                 FROM "dbo"."ProcurementOutcomes"
                 WHERE "ProcurementHandoffId"=$1`,
                [handoff.Id],
              );

            if (existingOutcome.rows[0]) {
              return existingOutcome.rows[0];
            }

            throw new ApiError(
              409,
              "Procurement handoff is completed but no Procurement Outcome exists.",
              "INCOMPLETE_PROCUREMENT_STATE",
            );
          }

          if (handoff.Status === "CANCELLED") {
            throw new ApiError(
              409,
              "Procurement handoff is cancelled.",
              "INVALID_HANDOFF_STATE",
            );
          }

          const openClarification =
            await client.query(
              `SELECT 1
               FROM "dbo"."ProcurementClarifications"
               WHERE "ProcurementHandoffId"=$1
                 AND "Status"='OPEN'
               LIMIT 1`,
              [handoff.Id],
            );

          if (openClarification.rowCount) {
            throw new ApiError(
              409,
              "All open Procurement clarifications must be answered before recording the final outcome.",
              "OPEN_CLARIFICATION_EXISTS",
            );
          }

          const inserted =
            await client.query(
              `INSERT INTO "dbo"."ProcurementOutcomes"
                 ("ProcurementHandoffId",
                  "MaintenanceRequestId",
                  "ProcurementReferenceNo",
                  "ExecutionType",
                  "AssignedPartyName",
                  "ResponsibleLeadUserId",
                  "ResponsibleLeadName",
                  "ResponsibleLeadContact",
                  "ResponsibleLeadEmail",
                  "PlannedStartAt",
                  "AgreedDurationDays",
                  "PlannedDeadlineAt",
                  "PlannedCrewSize",
                  "ReferenceDocumentId",
                  "Notes",
                  "RecordedBy")
               VALUES
                 ($1,$2,$3,$4,$5,$6,$7,$8,$9,
                  $10,$11,$12,$13,$14,$15,$16)
               RETURNING *`,
              [
                handoff.Id,
                handoff.MaintenanceRequestId,
                req.body
                  ?.procurementReferenceNo ||
                  handoff.ExternalSystemReference ||
                  null,
                executionType,
                req.body.assignedPartyName,
                req.body
                  ?.responsibleLeadUserId ||
                  null,
                req.body
                  ?.responsibleLeadName ||
                  null,
                req.body
                  ?.responsibleLeadContact ||
                  null,
                req.body
                  ?.responsibleLeadEmail ||
                  null,
                req.body?.plannedStartAt ||
                  null,
                req.body?.agreedDurationDays ??
                  null,
                req.body
                  ?.plannedDeadlineAt ||
                  null,
                req.body?.plannedCrewSize ??
                  null,
                req.body
                  ?.referenceDocumentId ||
                  null,
                req.body?.notes || null,
                req.user.id,
              ],
            );

          await client.query(
            `UPDATE "dbo"."ProcurementHandoffs"
             SET
               "Status"='COMPLETED',
               "CompletedBy"=$2,
               "CompletedAt"=NOW(),
               "ExternalSystemReference"=
                 COALESCE($3,"ExternalSystemReference"),
               "UpdatedAt"=NOW()
             WHERE "Id"=$1`,
            [
              handoff.Id,
              req.user.id,
              req.body
                ?.procurementReferenceNo ||
                null,
            ],
          );

          return inserted.rows[0];
        },
      );

      const workOrder =
        await ensureWorkOrderForOutcome(
          outcome.Id,
          req.user.id,
        );

      res.status(201).json({
        outcome,
        workOrder,
      });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
