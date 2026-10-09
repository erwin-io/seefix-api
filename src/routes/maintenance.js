import { Router } from "express";
import { query, withTransaction } from "../database.js";
import { ApiError } from "../errors.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";
import { agentClient } from "../agent-client.js";
import { presentReport, reportScreening, displayPriority } from "../services/report-presentation.js";
import {
  notifyRole,
  notifyReporterForReport,
  notifyReporterForWorkOrder,
  notifyResponsibleLeadForWorkOrder,
} from "../services/notifications.js";
import {
  ensureInternalWorkOrder,
} from "../services/work-order-service.js";
import {
  ensureProcurementHandoff,
} from "../services/procurement-service.js";
import {
  getSetting,
  settingBool,
} from "../services/settings.js";

const router = Router();
router.use(requireAuth);

const MAINTENANCE_ANY = requireRoles(
  "MAINTENANCE_STAFF",
  "MAINTENANCE_SUPERVISOR",
  "ADMIN",
);

const REVIEW_ROLES = requireRoles(
  "MAINTENANCE_STAFF",
  "MAINTENANCE_SUPERVISOR",
  "ADMIN",
);

const SUPERVISOR_ONLY = requireRoles(
  "MAINTENANCE_SUPERVISOR",
  "ADMIN",
);

const VALID_DECISIONS = new Set([
  "INTERNAL",
  "PROCUREMENT",
  "NO_ACTION",
  "DUPLICATE",
]);

const VALID_URGENCIES = new Set([
  "Low",
  "Medium",
  "High",
  "Critical",
]);

function cleanText(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const text = String(value).trim();
  return text || null;
}

async function getAutoRoutingSettings(client) {
  return {
    autoInternalWorkOrder: settingBool(
      await getSetting(
        client,
        "AutoCreateInternalWorkOrderAfterReview",
        true,
      ),
      true,
    ),
    autoProcurementHandoff: settingBool(
      await getSetting(
        client,
        "AutoCreateProcurementHandoffAfterReview",
        true,
      ),
      true,
    ),
  };
}

router.get(
  "/action-center",
  MAINTENANCE_ANY,
  async (req, res, next) => {
    try {
      const result = await query(
        `SELECT *
         FROM "dbo"."v_MaintenanceActionCenter"
         WHERE "AssignedRole"=$1
            OR $2 IN ('MAINTENANCE_SUPERVISOR','ADMIN')
         ORDER BY
           "PriorityScore" DESC NULLS LAST,
           "ActionCreatedAt" ASC`,
        [req.user.role, req.user.role],
      );

      res.json({ items: result.rows });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  "/review-queue",
  MAINTENANCE_ANY,
  async (req, res, next) => {
    try {
      // Optional filter: all (default), actionable, or screening.
      // Leave the canonical priority view and workflow untouched.
      const triage = String(req.query.triage || "all").trim().toLowerCase();
      if (!["all", "actionable", "screening"].includes(triage)) {
        throw new ApiError(400, "triage must be all, actionable, or screening.", "INVALID_TRIAGE");
      }
      const result = await query(
        `SELECT *
         FROM "dbo"."v_MaintenanceReviewQueue"
         ORDER BY
           "LivePriorityScore" DESC NULLS LAST,
           "CreatedAt" ASC`,
      );

      // Resolve screening information by report ID OR number, avoiding any
      // assumption about column names exposed by the canonical queue view.
      const reports = await query(
        `SELECT "Id", "ReportNo", "Status", "AgentStatus", "ScopeDecision",
                "ScopeShouldAnalyze", "PriorityScore"
           FROM "dbo"."Reports"
          WHERE "Status"='PENDING_REVIEW'`,
      );
      const byId = new Map(reports.rows.map((r) => [String(r.Id), r]));
      const byNo = new Map(reports.rows.map((r) => [String(r.ReportNo), r]));
      const items = result.rows.map((row) => {
        const report = byId.get(String(row.ReportId ?? row.Id ?? row.reportId ?? row.id))
          || byNo.get(String(row.ReportNo ?? row.reportNo));
        if (!report) return { ...row, screening: reportScreening({}) };
        return {
          ...row,
          LivePriorityScore: displayPriority(report, row.LivePriorityScore),
          screening: reportScreening(report),
        };
      });
      const filtered = triage === "all" ? items : items.filter((item) =>
        triage === "actionable" ? item.screening.isActionable : !item.screening.isActionable);
      res.json({ items: filtered });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  "/reports",
  MAINTENANCE_ANY,
  async (req, res, next) => {
    try {
      const status = req.query.status
        ? String(req.query.status)
        : null;
      const triage = String(req.query.triage || "all").trim().toLowerCase();
      if (!["all", "actionable", "screening"].includes(triage)) {
        throw new ApiError(400, "triage must be all, actionable, or screening.", "INVALID_TRIAGE");
      }

      const result = await query(
        `SELECT
           r."Id" AS id,
           r."ReportNo" AS "reportNo",
           r."Status" AS status,
           r."AgentStatus" AS "agentStatus",
           r."ScopeDecision" AS "scopeDecision",
           p."EffectiveCategory" AS "effectiveCategory",
           p."EffectiveUrgency" AS "effectiveUrgency",
           CASE WHEN r."AgentStatus"='COMPLETED'
                      AND r."ScopeDecision"='Facility Issue'
                      AND r."ScopeShouldAnalyze" IS NOT FALSE
                      AND r."PriorityScore" IS NOT NULL
                THEN p."LivePriorityScore" ELSE NULL END AS "priorityScore",
           r."ScopeShouldAnalyze" AS "scopeShouldAnalyze",
           r."RecurrenceCount" AS "recurrenceCount",
           r."VerificationCount" AS "verificationCount",
           r."AiNeedsReview" AS "aiNeedsReview",
           r."Building" AS building,
           r."Floor" AS floor,
           r."RoomOrArea" AS "roomOrArea",
           r."CreatedAt" AS "createdAt"
         FROM "dbo"."Reports" r
         LEFT JOIN "dbo"."v_ReportPriorityLive" p
           ON p."Id"=r."Id"
         WHERE ($1::text IS NULL OR r."Status"=$1)
           AND ($2::text='all' OR
                ($2::text='actionable' AND r."AgentStatus"='COMPLETED'
                 AND r."ScopeDecision"='Facility Issue'
                 AND r."ScopeShouldAnalyze" IS NOT FALSE) OR
                ($2::text='screening' AND NOT (CASE WHEN r."AgentStatus"='COMPLETED'
                 AND r."ScopeDecision"='Facility Issue'
                 AND r."ScopeShouldAnalyze" IS NOT FALSE THEN TRUE ELSE FALSE END)))
         ORDER BY
           CASE WHEN r."ScopeDecision"='Facility Issue'
                     AND r."AgentStatus"='COMPLETED'
                THEN p."LivePriorityScore" ELSE NULL END DESC NULLS LAST,
           r."CreatedAt" ASC
         LIMIT 200`,
        [status, triage],
      );

      res.json({ items: result.rows.map((row) => presentReport(row)) });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  "/reviews/:id",
  MAINTENANCE_ANY,
  async (req, res, next) => {
    try {
      const result = await query(
        `SELECT
           rv.*,
           r."ReportNo",
           r."Status" AS "ReportStatus",
           r."AiCategory",
           r."AiRecommendedUrgency",
           r."AiSummary",
           r."AgentStatus" AS "ReportAgentStatus",
           r."ScopeDecision" AS "ReportScopeDecision",
           r."ScopeShouldAnalyze" AS "ReportScopeShouldAnalyze",
           r."Building",
           r."Floor",
           r."RoomOrArea",
           p."LivePriorityScore",
           mr."RequestNo",
           mr."Status" AS "MaintenanceRequestStatus",
           mr."RequiredService",
           mr."RequiredCapability",
           mr."ScopeOfWork",
           mr."SafetyRequirements"
         FROM "dbo"."MaintenanceReviews" rv
         JOIN "dbo"."Reports" r
           ON r."Id"=rv."ReportId"
         LEFT JOIN "dbo"."v_ReportPriorityLive" p
           ON p."Id"=r."Id"
         LEFT JOIN "dbo"."MaintenanceRequests" mr
           ON mr."Id"=rv."MaintenanceRequestId"
         WHERE rv."Id"=$1`,
        [req.params.id],
      );

      if (!result.rows[0]) {
        throw new ApiError(
          404,
          "Maintenance Review was not found.",
          "MAINTENANCE_REVIEW_NOT_FOUND",
        );
      }

      const row = result.rows[0];
      const context = {
        Status: row.ReportStatus,
        AgentStatus: row.ReportAgentStatus,
        ScopeDecision: row.ReportScopeDecision,
        ScopeShouldAnalyze: row.ReportScopeShouldAnalyze,
      };
      const review = {
        ...row,
        PriorityScoreAtReview: displayPriority(context, row.PriorityScoreAtReview),
        LivePriorityScore: displayPriority(context, row.LivePriorityScore),
        screening: reportScreening(context),
      };
      delete review.ReportAgentStatus;
      delete review.ReportScopeDecision;
      delete review.ReportScopeShouldAnalyze;
      res.json({ review });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/reports/:id/maintenance-request/regenerate",
  MAINTENANCE_ANY,
  async (req, res, next) => {
    try {
      const state = await query(
        `SELECT
           r."Id",
           r."ReportNo",
           r."Status",
           r."AgentStatus",
           r."ScopeDecision",
           mr."Id" AS "MaintenanceRequestId",
           mr."Status" AS "MaintenanceRequestStatus"
         FROM "dbo"."Reports" r
         LEFT JOIN "dbo"."MaintenanceRequests" mr
           ON mr."ReportId"=r."Id"
         WHERE r."Id"=$1`,
        [req.params.id],
      );

      const row = state.rows[0];

      if (!row) {
        throw new ApiError(
          404,
          "Report was not found.",
          "REPORT_NOT_FOUND",
        );
      }

      if (
        row.AgentStatus !== "COMPLETED" ||
        row.ScopeDecision !== "Facility Issue"
      ) {
        throw new ApiError(
          409,
          "Only a completed Facility Issue assessment can generate a Maintenance Request.",
          "REPORT_NOT_READY",
        );
      }

      if (
        row.MaintenanceRequestStatus &&
        row.MaintenanceRequestStatus !== "DRAFT"
      ) {
        throw new ApiError(
          409,
          `Maintenance Request is already ${row.MaintenanceRequestStatus} and cannot be regenerated.`,
          "INVALID_MAINTENANCE_REQUEST_STATE",
        );
      }

      const generated =
        await agentClient.generateMaintenanceRequest(
          req.params.id,
        );

      res.json({
        ...generated,
        source: "seefix-agents",
      });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/reports/:id/review",
  REVIEW_ROLES,
  async (req, res, next) => {
    try {
      const decision = String(
        req.body?.decision || "",
      )
        .trim()
        .toUpperCase();

      if (!VALID_DECISIONS.has(decision)) {
        throw new ApiError(
          400,
          "decision must be INTERNAL, PROCUREMENT, NO_ACTION, or DUPLICATE.",
          "INVALID_REVIEW_DECISION",
        );
      }

      const decisionReason = cleanText(
        req.body?.decisionReason,
      );

      if (
        ["NO_ACTION", "DUPLICATE"].includes(decision) &&
        !decisionReason
      ) {
        throw new ApiError(
          400,
          "decisionReason is required for NO_ACTION or DUPLICATE.",
          "DECISION_REASON_REQUIRED",
        );
      }

      const transactionResult = await withTransaction(
        req.user.id,
        async (client) => {
          const reportResult = await client.query(
            `SELECT *
             FROM "dbo"."Reports"
             WHERE "Id"=$1
             FOR UPDATE`,
            [req.params.id],
          );

          const report = reportResult.rows[0];

          if (!report) {
            throw new ApiError(
              404,
              "Report was not found.",
              "REPORT_NOT_FOUND",
            );
          }

          if (report.AgentStatus !== "COMPLETED") {
            throw new ApiError(
              409,
              "The Agent assessment must be completed before Maintenance Review.",
              "REPORT_NOT_READY",
            );
          }

          const actionableDecision =
            decision === "INTERNAL" ||
            decision === "PROCUREMENT";

          if (
            actionableDecision &&
            report.ScopeDecision !== "Facility Issue"
          ) {
            throw new ApiError(
              409,
              "Only a Facility Issue can be routed to INTERNAL maintenance or PROCUREMENT.",
              "REPORT_NOT_ACTIONABLE",
            );
          }

          if (report.Status !== "PENDING_REVIEW") {
            const existingReviewResult =
              await client.query(
                `SELECT *
                 FROM "dbo"."MaintenanceReviews"
                 WHERE "ReportId"=$1`,
                [report.Id],
              );

            const existingReview =
              existingReviewResult.rows[0] || null;

            if (
              existingReview?.Status === "COMPLETED" &&
              existingReview.Decision === decision
            ) {
              const settings =
                await getAutoRoutingSettings(client);

              return {
                reportId: report.Id,
                reportNo: report.ReportNo,
                hadPriority: report.AgentStatus === "COMPLETED" &&
                  report.ScopeDecision === "Facility Issue" && report.PriorityScore != null,
                maintenanceRequestId:
                  existingReview.MaintenanceRequestId || null,
                maintenanceReview: existingReview,
                decision,
                autoRoutingSettings: settings,
                replay: true,
              };
            }

            throw new ApiError(
              409,
              `Report is already in ${report.Status} state.`,
              "INVALID_REPORT_STATE",
            );
          }

          const requestResult = await client.query(
            `SELECT *
             FROM "dbo"."MaintenanceRequests"
             WHERE "ReportId"=$1
             FOR UPDATE`,
            [report.Id],
          );

          const maintenanceRequest =
            requestResult.rows[0] || null;

          if (
            ["INTERNAL", "PROCUREMENT"].includes(
              decision,
            )
          ) {
            if (!maintenanceRequest) {
              throw new ApiError(
                409,
                "The Agent has not prepared a Maintenance Request draft yet.",
                "MAINTENANCE_REQUEST_NOT_READY",
              );
            }

            if (
              maintenanceRequest.Status !== "DRAFT"
            ) {
              throw new ApiError(
                409,
                `Maintenance Request is already ${maintenanceRequest.Status}.`,
                "INVALID_MAINTENANCE_REQUEST_STATE",
              );
            }
          }

          const finalCategory =
            cleanText(req.body?.finalCategory) ||
            report.AiCategory;

          const finalUrgency =
            cleanText(req.body?.finalUrgency) ||
            report.AiRecommendedUrgency;

          let categoryRef = null;
          let overrideReason =
            cleanText(req.body?.overrideReason);

          if (
            ["INTERNAL", "PROCUREMENT"].includes(
              decision,
            )
          ) {
            const categoryResult =
              await client.query(
                `SELECT *
                 FROM "dbo"."DamageCategories"
                 WHERE "Name"=$1
                   AND "IsActive"=TRUE`,
                [finalCategory],
              );

            categoryRef =
              categoryResult.rows[0];

            if (!categoryRef) {
              throw new ApiError(
                400,
                "finalCategory is not an active SEEFIX category.",
                "INVALID_CATEGORY",
              );
            }

            if (
              !VALID_URGENCIES.has(finalUrgency)
            ) {
              throw new ApiError(
                400,
                "finalUrgency is invalid.",
                "INVALID_URGENCY",
              );
            }

            const override =
              finalCategory !== report.AiCategory ||
              finalUrgency !==
                report.AiRecommendedUrgency;

            if (override && !overrideReason) {
              throw new ApiError(
                400,
                "overrideReason is required when category or urgency is changed.",
                "OVERRIDE_REASON_REQUIRED",
              );
            }

            if (!override) {
              overrideReason = null;
            }

            const bodyMap = {
              requiredService: "RequiredService",
              requiredCapability:
                "RequiredCapability",
              scopeOfWork: "ScopeOfWork",
              safetyRequirements:
                "SafetyRequirements",
              preliminaryMaterialsNotes:
                "PreliminaryMaterialsNotes",
              estimatedLaborHoursMin:
                "EstimatedLaborHoursMin",
              estimatedLaborHoursMax:
                "EstimatedLaborHoursMax",
              estimatedManpowerMin:
                "EstimatedManpowerMin",
              estimatedManpowerMax:
                "EstimatedManpowerMax",
              estimatedDurationDaysMin:
                "EstimatedDurationDaysMin",
              estimatedDurationDaysMax:
                "EstimatedDurationDaysMax",
              targetStartAt: "TargetStartAt",
              desiredCompletionAt:
                "DesiredCompletionAt",
            };

            const sets = [
              `"EffectiveCategory"=$2`,
              `"EffectiveUrgency"=$3`,
            ];

            const values = [
              maintenanceRequest.Id,
              finalCategory,
              finalUrgency,
            ];

            let parameterIndex = 4;

            for (
              const [bodyKey, column]
              of Object.entries(bodyMap)
            ) {
              if (
                Object.prototype.hasOwnProperty.call(
                  req.body || {},
                  bodyKey,
                )
              ) {
                sets.push(
                  `"${column}"=$${parameterIndex++}`,
                );
                values.push(
                  req.body[bodyKey] ?? null,
                );
              }
            }

            if (
              finalCategory !== report.AiCategory
            ) {
              if (
                !Object.prototype.hasOwnProperty.call(
                  req.body || {},
                  "requiredService",
                ) &&
                categoryRef.DefaultRequiredService
              ) {
                sets.push(
                  `"RequiredService"=$${parameterIndex++}`,
                );
                values.push(
                  categoryRef.DefaultRequiredService,
                );
              }

              if (
                !Object.prototype.hasOwnProperty.call(
                  req.body || {},
                  "requiredCapability",
                ) &&
                categoryRef.DefaultRequiredCapability
              ) {
                sets.push(
                  `"RequiredCapability"=$${parameterIndex++}`,
                );
                values.push(
                  categoryRef.DefaultRequiredCapability,
                );
              }
            }

            await client.query(
              `UPDATE "dbo"."MaintenanceRequests"
               SET ${sets.join(",")},
                   "UpdatedAt"=NOW()
               WHERE "Id"=$1`,
              values,
            );

            if (
              finalCategory !== report.AiCategory
            ) {
              await client.query(
                `DELETE FROM "dbo"."MaintenanceRequestSkills"
                 WHERE "MaintenanceRequestId"=$1`,
                [maintenanceRequest.Id],
              );

              await client.query(
                `INSERT INTO "dbo"."MaintenanceRequestSkills"
                   ("MaintenanceRequestId","SkillId",
                    "SkillName","MinimumProficiencyLevel",
                    "IsRequired","IsLeadSkill","Source","Notes")
                 SELECT
                   $1,
                   s."Id",
                   s."Name",
                   csr."MinimumProficiencyLevel",
                   csr."IsRequired",
                   csr."IsLeadSkill",
                   'CATEGORY_REFERENCE',
                   csr."Notes"
                 FROM "dbo"."CategorySkillRequirements" csr
                 JOIN "dbo"."Skills" s
                   ON s."Id"=csr."SkillId"
                 WHERE csr."CategoryId"=$2
                   AND s."IsActive"=TRUE`,
                [
                  maintenanceRequest.Id,
                  categoryRef.Id,
                ],
              );

              await client.query(
                `DELETE FROM "dbo"."MaintenanceRequestMaterials"
                 WHERE "MaintenanceRequestId"=$1`,
                [maintenanceRequest.Id],
              );

              await client.query(
                `INSERT INTO "dbo"."MaintenanceRequestMaterials"
                   ("MaintenanceRequestId","MaterialId",
                    "MaterialName","Unit","QuantityMin",
                    "QuantityMax","IsPreliminary",
                    "Source","Notes")
                 SELECT
                   $1,
                   m."Id",
                   m."Name",
                   m."Unit",
                   cmr."DefaultQtyMin",
                   cmr."DefaultQtyMax",
                   TRUE,
                   'CATEGORY_REFERENCE',
                   cmr."Notes"
                 FROM "dbo"."CategoryMaterialReferences" cmr
                 JOIN "dbo"."Materials" m
                   ON m."Id"=cmr."MaterialId"
                 WHERE cmr."CategoryId"=$2
                   AND m."IsActive"=TRUE`,
                [
                  maintenanceRequest.Id,
                  categoryRef.Id,
                ],
              );
            }

            const snapshot =
              await client.query(
                `SELECT *
                 FROM "dbo"."MaintenanceRequests"
                 WHERE "Id"=$1`,
                [maintenanceRequest.Id],
              );

            const skills =
              await client.query(
                `SELECT *
                 FROM "dbo"."MaintenanceRequestSkills"
                 WHERE "MaintenanceRequestId"=$1`,
                [maintenanceRequest.Id],
              );

            const materials =
              await client.query(
                `SELECT *
                 FROM "dbo"."MaintenanceRequestMaterials"
                 WHERE "MaintenanceRequestId"=$1`,
                [maintenanceRequest.Id],
              );

            const revisionNumberResult =
              await client.query(
                `SELECT
                   COALESCE(MAX("RevisionNo"),0)+1
                     AS "NextRevisionNo"
                 FROM "dbo"."MaintenanceRequestRevisions"
                 WHERE "MaintenanceRequestId"=$1`,
                [maintenanceRequest.Id],
              );

            const revisionNo = Number(
              revisionNumberResult.rows[0]
                ?.NextRevisionNo || 1,
            );

            await client.query(
              `INSERT INTO "dbo"."MaintenanceRequestRevisions"
                 ("MaintenanceRequestId","RevisionNo",
                  "Reason","SnapshotJson","CreatedBy")
               VALUES ($1,$2,$3,$4::jsonb,$5)`,
              [
                maintenanceRequest.Id,
                revisionNo,
                `Maintenance Review: ${decision}`,
                JSON.stringify({
                  maintenanceRequest:
                    snapshot.rows[0],
                  skills: skills.rows,
                  materials: materials.rows,
                }),
                req.user.id,
              ],
            );

            await client.query(
              `UPDATE "dbo"."MaintenanceRequests"
               SET
                 "CurrentRevisionNo"=$2,
                 "LastRevisedAt"=NOW(),
                 "UpdatedAt"=NOW()
               WHERE "Id"=$1`,
              [
                maintenanceRequest.Id,
                revisionNo,
              ],
            );
          }

          if (decision === "DUPLICATE") {
            const duplicateReportId =
              cleanText(req.body?.duplicateReportId);

            if (!duplicateReportId) {
              throw new ApiError(
                400,
                "duplicateReportId is required when decision is DUPLICATE.",
                "DUPLICATE_REPORT_REQUIRED",
              );
            }

            if (
              String(duplicateReportId) ===
              String(report.Id)
            ) {
              throw new ApiError(
                400,
                "A report cannot be a duplicate of itself.",
                "INVALID_DUPLICATE_REPORT",
              );
            }

            const duplicateTarget =
              await client.query(
                `SELECT "Id"
                 FROM "dbo"."Reports"
                 WHERE "Id"=$1`,
                [duplicateReportId],
              );

            if (!duplicateTarget.rows[0]) {
              throw new ApiError(
                404,
                "duplicateReportId was not found.",
                "DUPLICATE_REPORT_NOT_FOUND",
              );
            }

            await client.query(
              `UPDATE "dbo"."Reports"
               SET "ParentReportId"=$2
               WHERE "Id"=$1`,
              [
                report.Id,
                duplicateReportId,
              ],
            );
          }

          const priorityResult =
            await client.query(
              `SELECT "LivePriorityScore"
               FROM "dbo"."v_ReportPriorityLive"
               WHERE "Id"=$1`,
              [report.Id],
            );

          const maintenanceRequestId =
            maintenanceRequest?.Id || null;

          const reviewResult =
            await client.query(
              `INSERT INTO "dbo"."MaintenanceReviews"
                 ("ReportId","MaintenanceRequestId",
                  "Status","Decision","FinalCategory",
                  "FinalUrgency","PriorityScoreAtReview",
                  "OverrideReason","DecisionReason","Notes",
                  "ReviewedBy","ReviewedAt")
               VALUES
                 ($1,$2,'COMPLETED',$3,$4,$5,$6,$7,$8,$9,$10,NOW())
               ON CONFLICT ("ReportId")
               DO UPDATE SET
                 "MaintenanceRequestId"=EXCLUDED."MaintenanceRequestId",
                 "Status"='COMPLETED',
                 "Decision"=EXCLUDED."Decision",
                 "FinalCategory"=EXCLUDED."FinalCategory",
                 "FinalUrgency"=EXCLUDED."FinalUrgency",
                 "PriorityScoreAtReview"=EXCLUDED."PriorityScoreAtReview",
                 "OverrideReason"=EXCLUDED."OverrideReason",
                 "DecisionReason"=EXCLUDED."DecisionReason",
                 "Notes"=EXCLUDED."Notes",
                 "ReviewedBy"=EXCLUDED."ReviewedBy",
                 "ReviewedAt"=EXCLUDED."ReviewedAt"
               RETURNING *`,
              [
                report.Id,
                maintenanceRequestId,
                decision,
                ["INTERNAL", "PROCUREMENT"].includes(
                  decision,
                )
                  ? finalCategory
                  : null,
                ["INTERNAL", "PROCUREMENT"].includes(
                  decision,
                )
                  ? finalUrgency
                  : null,
                priorityResult.rows[0]
                  ?.LivePriorityScore ?? null,
                overrideReason,
                decisionReason,
                cleanText(req.body?.notes),
                req.user.id,
              ],
            );

          const review = reviewResult.rows[0];

          await client.query(
            `UPDATE "dbo"."WorkflowActionItems"
             SET
               "Status"='COMPLETED',
               "CompletedBy"=$2,
               "CompletedAt"=NOW(),
               "UpdatedAt"=NOW()
             WHERE "EntityType"='REPORT'
               AND "EntityId"=$1
               AND "ActionType"='REVIEW_REPORT'
               AND "Status"='OPEN'`,
            [report.Id, req.user.id],
          );

          await notifyReporterForReport(
            client,
            report.Id,
            {
              type: "MAINTENANCE_REVIEW_COMPLETED",
              title: "Maintenance review completed",
              message:
                decision === "INTERNAL"
                  ? `${report.ReportNo} was approved for internal maintenance.`
                  : decision === "PROCUREMENT"
                    ? `${report.ReportNo} was routed to Procurement.`
                    : decision === "DUPLICATE"
                      ? `${report.ReportNo} was marked as a duplicate report.`
                      : `${report.ReportNo} was reviewed and no maintenance action was required.`,
              deduplicationKey:
                `report:${report.Id}:maintenance-review:${review.Id}`,
              createdAt: review.ReviewedAt,
              payload: {
                decision,
                finalCategory:
                  review.FinalCategory,
                finalUrgency:
                  review.FinalUrgency,
              },
            },
          );

          const settings =
            await getAutoRoutingSettings(client);

          return {
            reportId: report.Id,
            reportNo: report.ReportNo,
            hadPriority: report.AgentStatus === "COMPLETED" &&
              report.ScopeDecision === "Facility Issue" && report.PriorityScore != null,
            maintenanceRequestId,
            maintenanceReview: review,
            decision,
            autoRoutingSettings: settings,
          };
        },
      );

      let nextStep = {
        type: "NONE",
        automatic: false,
      };

      if (
        transactionResult.decision ===
          "INTERNAL" &&
        transactionResult.autoRoutingSettings
          .autoInternalWorkOrder
      ) {
        const workOrder =
          await ensureInternalWorkOrder(
            transactionResult.maintenanceReview.Id,
            req.user.id,
          );

        nextStep = {
          type: "WORK_ORDER",
          automatic: true,
          ...workOrder,
        };
      }

      if (
        transactionResult.decision ===
          "PROCUREMENT" &&
        transactionResult.autoRoutingSettings
          .autoProcurementHandoff
      ) {
        const procurement =
          await ensureProcurementHandoff(
            transactionResult.maintenanceRequestId,
            req.user.id,
          );

        nextStep = {
          type: "PROCUREMENT_HANDOFF",
          automatic: true,
          ...procurement,
        };
      }

      res.json({
        reportId: transactionResult.reportId,
        reportNo: transactionResult.reportNo,
        maintenanceRequestId:
          transactionResult.maintenanceRequestId,
        maintenanceReview: transactionResult.hadPriority
          ? transactionResult.maintenanceReview
          : { ...transactionResult.maintenanceReview, PriorityScoreAtReview: null },
        nextStep,
      });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/procurement/clarifications/:id/respond",
  SUPERVISOR_ONLY,
  async (req, res, next) => {
    try {
      const response = String(
        req.body?.response || "",
      ).trim();

      if (!response) {
        throw new ApiError(
          400,
          "A human clarification response is required.",
          "RESPONSE_REQUIRED",
        );
      }

      const output = await withTransaction(
        req.user.id,
        async (client) => {
          const result = await client.query(
            `SELECT
               pc.*,
               ph."Id" AS "HandoffId"
             FROM "dbo"."ProcurementClarifications" pc
             JOIN "dbo"."ProcurementHandoffs" ph
               ON ph."Id"=pc."ProcurementHandoffId"
             WHERE pc."Id"=$1
             FOR UPDATE OF pc,ph`,
            [req.params.id],
          );

          const clarification =
            result.rows[0];

          if (!clarification) {
            throw new ApiError(
              404,
              "Clarification was not found.",
              "CLARIFICATION_NOT_FOUND",
            );
          }

          if (
            clarification.Status !== "OPEN"
          ) {
            throw new ApiError(
              409,
              "Only OPEN clarifications can be answered.",
              "INVALID_CLARIFICATION_STATE",
            );
          }

          await client.query(
            `UPDATE "dbo"."ProcurementClarifications"
             SET
               "Response"=$2,
               "AnsweredBy"=$3,
               "AnsweredAt"=NOW(),
               "Status"='ANSWERED',
               "UpdatedAt"=NOW()
             WHERE "Id"=$1`,
            [
              clarification.Id,
              response,
              req.user.id,
            ],
          );

          await client.query(
            `UPDATE "dbo"."ProcurementHandoffs"
             SET
               "Status"='IN_PROCESS',
               "UpdatedAt"=NOW()
             WHERE "Id"=$1
               AND "Status"='CLARIFICATION_REQUIRED'`,
            [clarification.HandoffId],
          );

          await client.query(
            `UPDATE "dbo"."WorkflowActionItems"
             SET
               "Status"='COMPLETED',
               "CompletedBy"=$2,
               "CompletedAt"=NOW(),
               "UpdatedAt"=NOW()
             WHERE "EntityType"='PROCUREMENT_CLARIFICATION'
               AND "EntityId"=$1
               AND "ActionType" IN
                   ('ANSWER_PROCUREMENT_CLARIFICATION',
                    'RESPOND_PROCUREMENT_CLARIFICATION')
               AND "Status"='OPEN'`,
            [
              clarification.Id,
              req.user.id,
            ],
          );

          await notifyRole(
            client,
            "PROCUREMENT",
            {
              type:
                "PROCUREMENT_CLARIFICATION_ANSWERED",
              title: "Clarification answered",
              message:
                "Maintenance Supervisor submitted a clarification response.",
              entityType:
                "PROCUREMENT_CLARIFICATION",
              entityId: clarification.Id,
              payload: {
                handoffId:
                  String(
                    clarification.HandoffId,
                  ),
              },
            },
          );

          return {
            clarificationId:
              clarification.Id,
            handoffId:
              clarification.HandoffId,
            status: "ANSWERED",
          };
        },
      );

      res.json(output);
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/work-orders/:id/complete",
  SUPERVISOR_ONLY,
  async (req, res, next) => {
    try {
      const workOrder =
        await withTransaction(
          req.user.id,
          async (client) => {
            const result =
              await client.query(
                `SELECT *
                 FROM "dbo"."WorkOrders"
                 WHERE "Id"=$1
                 FOR UPDATE`,
                [req.params.id],
              );

            const row = result.rows[0];

            if (!row) {
              throw new ApiError(
                404,
                "Work Order was not found.",
                "WORK_ORDER_NOT_FOUND",
              );
            }

            if (
              row.Status !==
              "COMPLETION_SUBMITTED"
            ) {
              throw new ApiError(
                409,
                "Completion must be submitted before the Maintenance Supervisor can close the Work Order.",
                "INVALID_WORK_ORDER_STATE",
              );
            }

            const updated =
              await client.query(
                `UPDATE "dbo"."WorkOrders"
                 SET
                   "Status"='COMPLETED',
                   "CompletedBy"=$2,
                   "ResolvedAt"=NOW(),
                   "UpdatedAt"=NOW()
                 WHERE "Id"=$1
                 RETURNING *`,
                [row.Id, req.user.id],
              );

            const completed =
              updated.rows[0];

            await client.query(
              `UPDATE "dbo"."WorkflowActionItems"
               SET
                 "Status"='COMPLETED',
                 "CompletedBy"=$2,
                 "CompletedAt"=NOW(),
                 "UpdatedAt"=NOW()
               WHERE "EntityType"='WORK_ORDER'
                 AND "EntityId"=$1
                 AND "ActionType"='REVIEW_COMPLETION'
                 AND "Status"='OPEN'`,
              [row.Id, req.user.id],
            );

            await notifyReporterForWorkOrder(
              client,
              row.Id,
              {
                type: "REPORT_RESOLVED",
                title: "Report resolved",
                message:
                  `The maintenance work for ${completed.WorkOrderNo} was accepted by the Maintenance Supervisor and the report is resolved.`,
                deduplicationKey:
                  `report:${completed.ReportId}:resolved`,
                createdAt:
                  completed.ResolvedAt,
                payload: {
                  status: "RESOLVED",
                },
              },
            );

            await notifyResponsibleLeadForWorkOrder(
              client,
              row.Id,
              {
                type:
                  "WORK_ORDER_COMPLETED",
                title:
                  "Work Order completed",
                message:
                  `${completed.WorkOrderNo} was accepted and closed by the Maintenance Supervisor.`,
                deduplicationKey:
                  `work-order:${completed.Id}:completed`,
                createdAt:
                  completed.ResolvedAt,
                payload: {
                  status: "COMPLETED",
                },
              },
            );

            return completed;
          },
        );

      res.json({ workOrder });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/work-orders/:id/rework",
  SUPERVISOR_ONLY,
  async (req, res, next) => {
    try {
      const reason = String(
        req.body?.reason || "",
      ).trim();

      if (!reason) {
        throw new ApiError(
          400,
          "A rework reason is required.",
          "REWORK_REASON_REQUIRED",
        );
      }

      const workOrder =
        await withTransaction(
          req.user.id,
          async (client) => {
            const result =
              await client.query(
                `SELECT *
                 FROM "dbo"."WorkOrders"
                 WHERE "Id"=$1
                 FOR UPDATE`,
                [req.params.id],
              );

            const row = result.rows[0];

            if (!row) {
              throw new ApiError(
                404,
                "Work Order was not found.",
                "WORK_ORDER_NOT_FOUND",
              );
            }

            if (
              row.Status !==
              "COMPLETION_SUBMITTED"
            ) {
              throw new ApiError(
                409,
                "Only submitted completion can be returned for rework.",
                "INVALID_WORK_ORDER_STATE",
              );
            }

            await client.query(
              `UPDATE "dbo"."WorkOrders"
               SET
                 "Status"='REWORK_REQUIRED',
                 "UpdatedAt"=NOW()
               WHERE "Id"=$1`,
              [row.Id],
            );

            const update =
              await client.query(
                `INSERT INTO "dbo"."WorkOrderUpdates"
                   ("WorkOrderId","UpdateType",
                    "StatusSnapshot","Message",
                    "CreatedBy")
                 VALUES
                   ($1,'STATUS','REWORK_REQUIRED',$2,$3)
                 RETURNING
                   "Id",
                   "CreatedAt"`,
                [
                  row.Id,
                  reason,
                  req.user.id,
                ],
              );

            await client.query(
              `UPDATE "dbo"."WorkflowActionItems"
               SET
                 "Status"='COMPLETED',
                 "CompletedBy"=$2,
                 "CompletedAt"=NOW(),
                 "UpdatedAt"=NOW()
               WHERE "EntityType"='WORK_ORDER'
                 AND "EntityId"=$1
                 AND "ActionType"='REVIEW_COMPLETION'
                 AND "Status"='OPEN'`,
              [row.Id, req.user.id],
            );

            const reworkAt =
              update.rows[0]?.CreatedAt ||
              new Date();

            await notifyReporterForWorkOrder(
              client,
              row.Id,
              {
                type:
                  "WORK_ORDER_REWORK_REQUIRED",
                title:
                  "Additional work required",
                message:
                  `The Maintenance Supervisor requested additional work for ${row.WorkOrderNo}.`,
                deduplicationKey:
                  `report:${row.ReportId}:rework:${row.Id}:${reworkAt.toISOString?.() || reworkAt}`,
                createdAt: reworkAt,
                payload: {
                  status:
                    "REWORK_REQUIRED",
                },
              },
            );

            await notifyResponsibleLeadForWorkOrder(
              client,
              row.Id,
              {
                type:
                  "WORK_ORDER_REWORK_REQUIRED",
                title: "Rework required",
                message:
                  `${row.WorkOrderNo} requires additional work: ${reason}`,
                deduplicationKey:
                  `work-order:${row.Id}:rework:${reworkAt.toISOString?.() || reworkAt}`,
                createdAt: reworkAt,
                payload: {
                  status:
                    "REWORK_REQUIRED",
                  reason,
                },
              },
            );

            return {
              ...row,
              Status:
                "REWORK_REQUIRED",
            };
          },
        );

      res.json({ workOrder });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
