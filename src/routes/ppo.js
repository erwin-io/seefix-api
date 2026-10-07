import { Router } from "express";
import { query, withTransaction } from "../database.js";
import { ApiError } from "../errors.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";
import { maybeAutoSubmitProcurement } from "../services/procurement-service.js";
import { agentClient, bestEffort } from "../agent-client.js";
import {
  notifyRole,
  notifyReporterForReport,
  notifyReporterForWorkOrder,
  notifyResponsibleLeadForWorkOrder,
} from "../services/notifications.js";
const router = Router();
router.use(requireAuth);
const PPO_ANY = requireRoles("PPO_STAFF", "PPO_HEAD", "ADMIN");
router.get("/action-center", PPO_ANY, async (req, res, next) => {
  try {
    const r = await query(
      `SELECT * FROM "dbo"."v_PpoActionCenter" WHERE "AssignedRole"=$1 OR $2 IN ('PPO_HEAD','ADMIN') ORDER BY "PriorityScore" DESC NULLS LAST,"ActionCreatedAt"`,
      [req.user.role, req.user.role],
    );
    res.json({ items: r.rows });
  } catch (e) {
    next(e);
  }
});
router.get("/reports", PPO_ANY, async (req, res, next) => {
  try {
    const status = req.query.status ? String(req.query.status) : null;
    const r = await query(
      `SELECT r."Id" AS id,r."ReportNo" AS "reportNo",r."Status" AS status,r."AgentStatus" AS "agentStatus",r."ScopeDecision" AS "scopeDecision",p."EffectiveCategory" AS "effectiveCategory",p."EffectiveUrgency" AS "effectiveUrgency",p."LivePriorityScore" AS "priorityScore",r."RecurrenceCount" AS "recurrenceCount",r."VerificationCount" AS "verificationCount",r."AiNeedsReview" AS "aiNeedsReview",r."CreatedAt" AS "createdAt" FROM "dbo"."Reports" r LEFT JOIN "dbo"."v_ReportPriorityLive" p ON p."Id"=r."Id" WHERE ($1::text IS NULL OR r."Status"=$1) ORDER BY p."LivePriorityScore" DESC NULLS LAST,r."CreatedAt" ASC LIMIT 200`,
      [status],
    );
    res.json({ items: r.rows });
  } catch (e) {
    next(e);
  }
});

router.post(
  "/reports/:id/maintenance-request/regenerate",
  PPO_ANY,
  async (req, res, next) => {
    try {
      const state = await query(
        `SELECT r."Id",r."ReportNo",r."Status",r."AgentStatus",r."ScopeDecision",mr."Id" AS "MaintenanceRequestId",mr."Status" AS "MaintenanceRequestStatus" FROM "dbo"."Reports" r LEFT JOIN "dbo"."MaintenanceRequests" mr ON mr."ReportId"=r."Id" WHERE r."Id"=$1`,
        [req.params.id],
      );
      const row = state.rows[0];
      if (!row)
        throw new ApiError(404, "Report was not found.", "REPORT_NOT_FOUND");
      if (
        row.AgentStatus !== "COMPLETED" ||
        row.ScopeDecision !== "Facility Issue"
      )
        throw new ApiError(
          409,
          "Only a completed Facility Issue assessment can generate a Maintenance Request.",
          "REPORT_NOT_READY",
        );
      if (
        row.MaintenanceRequestStatus &&
        row.MaintenanceRequestStatus !== "DRAFT"
      )
        throw new ApiError(
          409,
          `Maintenance Request is already ${row.MaintenanceRequestStatus} and cannot be regenerated.`,
          "INVALID_MAINTENANCE_REQUEST_STATE",
        );
      const generated = await agentClient.generateMaintenanceRequest(
        req.params.id,
      );
      res.json({ ...generated, source: "seefix-agents" });
    } catch (e) {
      next(e);
    }
  },
);

router.post(
  "/reports/:id/verify-request-maintenance",
  requireRoles("PPO_STAFF", "ADMIN"),
  async (req, res, next) => {
    try {
      const result = await withTransaction(req.user.id, async (client) => {
        const rr = await client.query(
          `SELECT * FROM "dbo"."Reports" WHERE "Id"=$1 FOR UPDATE`,
          [req.params.id],
        );
        const report = rr.rows[0];
        if (!report)
          throw new ApiError(404, "Report was not found.", "REPORT_NOT_FOUND");
        if (
          report.AgentStatus !== "COMPLETED" ||
          report.ScopeDecision !== "Facility Issue"
        )
          throw new ApiError(
            409,
            "Only a completed Facility Issue assessment can be verified for maintenance.",
            "REPORT_NOT_READY",
          );
        if (!["SUBMITTED", "VERIFIED"].includes(report.Status))
          throw new ApiError(
            409,
            `Report is already in ${report.Status} state.`,
            "INVALID_REPORT_STATE",
          );
        const mrq = await client.query(
          `SELECT * FROM "dbo"."MaintenanceRequests" WHERE "ReportId"=$1 FOR UPDATE`,
          [req.params.id],
        );
        const mr = mrq.rows[0];
        if (!mr)
          throw new ApiError(
            409,
            "The Agent has not prepared a Maintenance Request draft yet.",
            "MAINTENANCE_REQUEST_NOT_READY",
          );
        if (mr.Status !== "DRAFT")
          throw new ApiError(
            409,
            `Maintenance Request is already ${mr.Status}.`,
            "INVALID_MAINTENANCE_REQUEST_STATE",
          );
        const finalCategory = req.body?.finalCategory || report.AiCategory;
        const finalUrgency =
          req.body?.finalUrgency || report.AiRecommendedUrgency;
        const cat = await client.query(
          `SELECT * FROM "dbo"."DamageCategories" WHERE "Name"=$1 AND "IsActive"=TRUE`,
          [finalCategory],
        );
        if (!cat.rowCount)
          throw new ApiError(
            400,
            "finalCategory is not an active SEEFIX category.",
            "INVALID_CATEGORY",
          );
        const categoryRef = cat.rows[0];
        if (!["Low", "Medium", "High", "Critical"].includes(finalUrgency))
          throw new ApiError(
            400,
            "finalUrgency is invalid.",
            "INVALID_URGENCY",
          );
        const override =
          finalCategory !== report.AiCategory ||
          finalUrgency !== report.AiRecommendedUrgency;
        if (override && !String(req.body?.overrideReason || "").trim())
          throw new ApiError(
            400,
            "overrideReason is required when category or urgency is changed.",
            "OVERRIDE_REASON_REQUIRED",
          );
        await client.query(
          `UPDATE "dbo"."Reports" SET "FinalCategory"=$2,"FinalUrgency"=$3,"OverrideReason"=$4,"ReviewedBy"=$5,"ReviewedAt"=NOW(),"Status"='VERIFIED',"UpdatedAt"=NOW() WHERE "Id"=$1`,
          [
            req.params.id,
            finalCategory,
            finalUrgency,
            override ? req.body.overrideReason : null,
            req.user.id,
          ],
        );
        const editable = [
          "RequiredService",
          "RequiredCapability",
          "ScopeOfWork",
          "SafetyRequirements",
          "PreliminaryMaterialsNotes",
          "EstimatedLaborHoursMin",
          "EstimatedLaborHoursMax",
          "EstimatedManpowerMin",
          "EstimatedManpowerMax",
          "EstimatedDurationDaysMin",
          "EstimatedDurationDaysMax",
          "TargetStartAt",
          "DesiredCompletionAt",
        ];
        const bodyMap = {
          requiredService: "RequiredService",
          requiredCapability: "RequiredCapability",
          scopeOfWork: "ScopeOfWork",
          safetyRequirements: "SafetyRequirements",
          preliminaryMaterialsNotes: "PreliminaryMaterialsNotes",
          estimatedLaborHoursMin: "EstimatedLaborHoursMin",
          estimatedLaborHoursMax: "EstimatedLaborHoursMax",
          estimatedManpowerMin: "EstimatedManpowerMin",
          estimatedManpowerMax: "EstimatedManpowerMax",
          estimatedDurationDaysMin: "EstimatedDurationDaysMin",
          estimatedDurationDaysMax: "EstimatedDurationDaysMax",
          targetStartAt: "TargetStartAt",
          desiredCompletionAt: "DesiredCompletionAt",
        };
        const sets = [`"EffectiveCategory"=$2`, `"EffectiveUrgency"=$3`];
        const values = [mr.Id, finalCategory, finalUrgency];
        let i = 4;
        for (const [key, col] of Object.entries(bodyMap)) {
          if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) {
            sets.push(`"${col}"=$${i++}`);
            values.push(req.body[key] ?? null);
          }
        }
        if (finalCategory !== report.AiCategory) {
          if (
            !Object.prototype.hasOwnProperty.call(
              req.body || {},
              "requiredService",
            ) &&
            categoryRef.DefaultRequiredService
          ) {
            sets.push(`"RequiredService"=$${i++}`);
            values.push(categoryRef.DefaultRequiredService);
          }
          if (
            !Object.prototype.hasOwnProperty.call(
              req.body || {},
              "requiredCapability",
            ) &&
            categoryRef.DefaultRequiredCapability
          ) {
            sets.push(`"RequiredCapability"=$${i++}`);
            values.push(categoryRef.DefaultRequiredCapability);
          }
        }
        sets.push(`"UpdatedAt"=NOW()`);
        await client.query(
          `UPDATE "dbo"."MaintenanceRequests" SET ${sets.join(",")} WHERE "Id"=$1`,
          values,
        );
        if (finalCategory !== report.AiCategory) {
          await client.query(
            `DELETE FROM "dbo"."MaintenanceRequestSkills" WHERE "MaintenanceRequestId"=$1`,
            [mr.Id],
          );
          await client.query(
            `INSERT INTO "dbo"."MaintenanceRequestSkills" ("MaintenanceRequestId","SkillId","SkillName","MinimumProficiencyLevel","IsRequired","IsLeadSkill","Source","Notes") SELECT $1,s."Id",s."Name",csr."MinimumProficiencyLevel",csr."IsRequired",csr."IsLeadSkill",'CATEGORY_REFERENCE',csr."Notes" FROM "dbo"."CategorySkillRequirements" csr JOIN "dbo"."Skills" s ON s."Id"=csr."SkillId" WHERE csr."CategoryId"=$2 AND s."IsActive"=TRUE`,
            [mr.Id, categoryRef.Id],
          );
          await client.query(
            `DELETE FROM "dbo"."MaintenanceRequestMaterials" WHERE "MaintenanceRequestId"=$1`,
            [mr.Id],
          );
          await client.query(
            `INSERT INTO "dbo"."MaintenanceRequestMaterials" ("MaintenanceRequestId","MaterialId","MaterialName","Unit","QuantityMin","QuantityMax","IsPreliminary","Source","Notes") SELECT $1,m."Id",m."Name",m."Unit",cmr."DefaultQtyMin",cmr."DefaultQtyMax",TRUE,'CATEGORY_REFERENCE',cmr."Notes" FROM "dbo"."CategoryMaterialReferences" cmr JOIN "dbo"."Materials" m ON m."Id"=cmr."MaterialId" WHERE cmr."CategoryId"=$2 AND m."IsActive"=TRUE`,
            [mr.Id, categoryRef.Id],
          );
        }
        const snapshot = await client.query(
          `SELECT * FROM "dbo"."MaintenanceRequests" WHERE "Id"=$1`,
          [mr.Id],
        );
        const skills = await client.query(
          `SELECT * FROM "dbo"."MaintenanceRequestSkills" WHERE "MaintenanceRequestId"=$1`,
          [mr.Id],
        );
        const materials = await client.query(
          `SELECT * FROM "dbo"."MaintenanceRequestMaterials" WHERE "MaintenanceRequestId"=$1`,
          [mr.Id],
        );
        const rev = await client.query(
          `INSERT INTO "dbo"."MaintenanceRequestRevisions" ("MaintenanceRequestId","RevisionNo","Reason","SnapshotJson","CreatedBy") VALUES ($1,0,$2,$3::jsonb,$4) RETURNING "Id" AS id,"RevisionNo" AS "revisionNo"`,
          [
            mr.Id,
            "PPO Verify & Request Maintenance",
            JSON.stringify({
              maintenanceRequest: snapshot.rows[0],
              skills: skills.rows,
              materials: materials.rows,
            }),
            req.user.id,
          ],
        );
        const authorized = await client.query(
          `UPDATE "dbo"."MaintenanceRequests" SET "Status"='AUTHORIZED',"AuthorizedBy"=$2,"AuthorizedAt"=NOW(),"UpdatedAt"=NOW() WHERE "Id"=$1 RETURNING "AuthorizedAt"`,
          [mr.Id, req.user.id],
        );
        await notifyReporterForReport(client, report.Id, {
          type: "MAINTENANCE_REQUESTED",
          title: "Maintenance requested",
          message: `PPO reviewed ${report.ReportNo} and requested maintenance.`,
          deduplicationKey: `report:${report.Id}:maintenance-requested`,
          createdAt: authorized.rows[0]?.AuthorizedAt || new Date(),
          payload: {
            requestNo: mr.RequestNo,
            finalCategory,
            finalUrgency,
          },
        });
        return {
          reportId: report.Id,
          reportNo: report.ReportNo,
          maintenanceRequestId: mr.Id,
          revision: rev.rows[0],
          finalCategory,
          finalUrgency,
        };
      });
      const procurement = await maybeAutoSubmitProcurement(
        result.maintenanceRequestId,
        req.user.id,
      );
      res.json({ ...result, procurement });
    } catch (e) {
      next(e);
    }
  },
);

router.post(
  "/procurement/clarifications/:id/respond",
  requireRoles("PPO_HEAD", "ADMIN"),
  async (req, res, next) => {
    try {
      const response = String(req.body?.response || "").trim();
      if (!response)
        throw new ApiError(
          400,
          "A human clarification response is required.",
          "RESPONSE_REQUIRED",
        );
      const out = await withTransaction(req.user.id, async (client) => {
        const q = await client.query(
          `SELECT pc.*,ph."Id" AS "HandoffId" FROM "dbo"."ProcurementClarifications" pc JOIN "dbo"."ProcurementHandoffs" ph ON ph."Id"=pc."ProcurementHandoffId" WHERE pc."Id"=$1 FOR UPDATE`,
          [req.params.id],
        );
        const c = q.rows[0];
        if (!c)
          throw new ApiError(
            404,
            "Clarification was not found.",
            "CLARIFICATION_NOT_FOUND",
          );
        if (c.Status !== "OPEN")
          throw new ApiError(
            409,
            "Only OPEN clarifications can be answered.",
            "INVALID_CLARIFICATION_STATE",
          );
        await client.query(
          `UPDATE "dbo"."ProcurementClarifications" SET "Response"=$2,"AnsweredBy"=$3,"AnsweredAt"=NOW(),"Status"='ANSWERED',"UpdatedAt"=NOW() WHERE "Id"=$1`,
          [c.Id, response, req.user.id],
        );
        await client.query(
          `UPDATE "dbo"."ProcurementHandoffs" SET "Status"='IN_PROCESS',"UpdatedAt"=NOW() WHERE "Id"=$1 AND "Status"='CLARIFICATION_REQUIRED'`,
          [c.HandoffId],
        );
        await client.query(
          `UPDATE "dbo"."WorkflowActionItems" SET "Status"='COMPLETED',"CompletedBy"=$2,"CompletedAt"=NOW(),"UpdatedAt"=NOW() WHERE "EntityType"='PROCUREMENT_CLARIFICATION' AND "EntityId"=$1 AND "Status"='OPEN'`,
          [c.Id, req.user.id],
        );
        await notifyRole(client, "PROCUREMENT", {
          type: "PROCUREMENT_CLARIFICATION_ANSWERED",
          title: "Clarification answered",
          message: "PPO Head submitted a clarification response.",
          entityType: "PROCUREMENT_CLARIFICATION",
          entityId: c.Id,
          payload: { handoffId: String(c.HandoffId) },
        });
        return {
          clarificationId: c.Id,
          handoffId: c.HandoffId,
          status: "ANSWERED",
        };
      });
      res.json(out);
    } catch (e) {
      next(e);
    }
  },
);

router.post(
  "/work-orders/:id/confirm",
  requireRoles("PPO_HEAD", "ADMIN"),
  async (req, res, next) => {
    try {
      const review = await agentClient.reviewWorkOrder(req.params.id);
      if (!review?.readiness?.ready)
        throw new ApiError(
          409,
          "Work Order is not ready for confirmation.",
          "WORK_ORDER_NOT_READY",
          review?.readiness,
        );
      const wo = await withTransaction(req.user.id, async (client) => {
        const r = await client.query(
          `SELECT * FROM "dbo"."WorkOrders" WHERE "Id"=$1 FOR UPDATE`,
          [req.params.id],
        );
        const row = r.rows[0];
        if (!row)
          throw new ApiError(
            404,
            "Work Order was not found.",
            "WORK_ORDER_NOT_FOUND",
          );
        if (row.Status !== "PENDING_CONFIRMATION")
          throw new ApiError(
            409,
            "Only PENDING_CONFIRMATION Work Orders can be confirmed.",
            "INVALID_WORK_ORDER_STATE",
          );
        const u = await client.query(
          `UPDATE "dbo"."WorkOrders" SET "Status"='CONFIRMED',"ConfirmedBy"=$2,"ConfirmedAt"=NOW(),"UpdatedAt"=NOW() WHERE "Id"=$1 RETURNING *`,
          [row.Id, req.user.id],
        );
        const confirmed = u.rows[0];
        await notifyReporterForWorkOrder(client, row.Id, {
          type: "WORK_ORDER_ASSIGNED",
          title: "Maintenance work assigned",
          message: `${confirmed.WorkOrderNo} was confirmed${confirmed.AssignedPartyName ? ` and assigned to ${confirmed.AssignedPartyName}` : ""}.`,
          deduplicationKey: `report:${confirmed.ReportId}:work-order-confirmed:${confirmed.Id}`,
          createdAt: confirmed.ConfirmedAt,
          payload: { status: "ASSIGNED" },
        });
        await notifyResponsibleLeadForWorkOrder(client, row.Id, {
          type: "WORK_ORDER_CONFIRMED",
          title: "Work Order confirmed",
          message: `${confirmed.WorkOrderNo} is confirmed and ready for execution.`,
          deduplicationKey: `work-order:${confirmed.Id}:confirmed`,
          createdAt: confirmed.ConfirmedAt,
          payload: { status: "CONFIRMED" },
        });
        return confirmed;
      });
      res.json({ workOrder: wo, review });
    } catch (e) {
      next(e);
    }
  },
);

router.post(
  "/work-orders/:id/complete",
  requireRoles("PPO_HEAD", "ADMIN"),
  async (req, res, next) => {
    try {
      const wo = await withTransaction(req.user.id, async (client) => {
        const r = await client.query(
          `SELECT * FROM "dbo"."WorkOrders" WHERE "Id"=$1 FOR UPDATE`,
          [req.params.id],
        );
        const row = r.rows[0];
        if (!row)
          throw new ApiError(
            404,
            "Work Order was not found.",
            "WORK_ORDER_NOT_FOUND",
          );
        if (row.Status !== "COMPLETION_SUBMITTED")
          throw new ApiError(
            409,
            "Completion must be submitted before PPO Head can close the Work Order.",
            "INVALID_WORK_ORDER_STATE",
          );
        const u = await client.query(
          `UPDATE "dbo"."WorkOrders" SET "Status"='COMPLETED',"CompletedBy"=$2,"ResolvedAt"=NOW(),"UpdatedAt"=NOW() WHERE "Id"=$1 RETURNING *`,
          [row.Id, req.user.id],
        );
        const completed = u.rows[0];
        await notifyReporterForWorkOrder(client, row.Id, {
          type: "REPORT_RESOLVED",
          title: "Report resolved",
          message: `The maintenance work for ${completed.WorkOrderNo} was accepted by PPO Head and the report is resolved.`,
          deduplicationKey: `report:${completed.ReportId}:resolved`,
          createdAt: completed.ResolvedAt,
          payload: { status: "RESOLVED" },
        });
        await notifyResponsibleLeadForWorkOrder(client, row.Id, {
          type: "WORK_ORDER_COMPLETED",
          title: "Work Order completed",
          message: `${completed.WorkOrderNo} was accepted and closed by PPO Head.`,
          deduplicationKey: `work-order:${completed.Id}:completed`,
          createdAt: completed.ResolvedAt,
          payload: { status: "COMPLETED" },
        });
        return completed;
      });
      res.json({ workOrder: wo });
    } catch (e) {
      next(e);
    }
  },
);
router.post(
  "/work-orders/:id/rework",
  requireRoles("PPO_HEAD", "ADMIN"),
  async (req, res, next) => {
    try {
      const reason = String(req.body?.reason || "").trim();
      if (!reason)
        throw new ApiError(
          400,
          "A rework reason is required.",
          "REWORK_REASON_REQUIRED",
        );
      const wo = await withTransaction(req.user.id, async (client) => {
        const r = await client.query(
          `SELECT * FROM "dbo"."WorkOrders" WHERE "Id"=$1 FOR UPDATE`,
          [req.params.id],
        );
        const row = r.rows[0];
        if (!row)
          throw new ApiError(
            404,
            "Work Order was not found.",
            "WORK_ORDER_NOT_FOUND",
          );
        if (row.Status !== "COMPLETION_SUBMITTED")
          throw new ApiError(
            409,
            "Only submitted completion can be returned for rework.",
            "INVALID_WORK_ORDER_STATE",
          );
        await client.query(
          `UPDATE "dbo"."WorkOrders" SET "Status"='REWORK_REQUIRED',"UpdatedAt"=NOW() WHERE "Id"=$1`,
          [row.Id],
        );
        const update = await client.query(
          `INSERT INTO "dbo"."WorkOrderUpdates" ("WorkOrderId","UpdateType","StatusSnapshot","Message","CreatedBy") VALUES ($1,'STATUS','REWORK_REQUIRED',$2,$3) RETURNING "Id","CreatedAt"`,
          [row.Id, reason, req.user.id],
        );
        const reworkAt = update.rows[0]?.CreatedAt || new Date();
        await notifyReporterForWorkOrder(client, row.Id, {
          type: "WORK_ORDER_REWORK_REQUIRED",
          title: "Additional work required",
          message: `PPO Head requested additional work for ${row.WorkOrderNo}.`,
          deduplicationKey: `report:${row.ReportId}:rework:${row.Id}`,
          createdAt: reworkAt,
          payload: { status: "REWORK_REQUIRED" },
        });
        await notifyResponsibleLeadForWorkOrder(client, row.Id, {
          type: "WORK_ORDER_REWORK_REQUIRED",
          title: "Rework required",
          message: `${row.WorkOrderNo} requires additional work: ${reason}`,
          deduplicationKey: `work-order:${row.Id}:rework`,
          createdAt: reworkAt,
          payload: { status: "REWORK_REQUIRED", reason },
        });
        return { ...row, Status: "REWORK_REQUIRED" };
      });
      res.json({ workOrder: wo });
    } catch (e) {
      next(e);
    }
  },
);
export default router;
