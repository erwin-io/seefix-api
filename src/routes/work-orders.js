import { Router } from "express";
import { config } from "../config.js";
import { query, withTransaction } from "../database.js";
import { ApiError } from "../errors.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";
import { memoryUpload, requireImageFiles } from "../uploads.js";
import {
  uploadBuffer,
  destroyAsset,
  reportImageRecord,
} from "../cloudinary.js";
import { agentClient, bestEffort } from "../agent-client.js";
import {
  notifyRole,
  notifyReporterForWorkOrder,
  notifyResponsibleLeadForWorkOrder,
} from "../services/notifications.js";
import { normalizeMaterialItem, parseActualMaterials } from "../utils/materials.js";
const router = Router();
router.use(requireAuth);
const WORK_ROLES = requireRoles(
  "MAINTENANCE_STAFF",
  "MAINTENANCE_SUPERVISOR",
  "WORKER",
  "ADMIN",
);
const ASSIGN_ROLES = requireRoles(
  "MAINTENANCE_STAFF",
  "MAINTENANCE_SUPERVISOR",
  "ADMIN",
);
async function assertWorkAccess(id, user) {
  const q = await query(`SELECT * FROM "dbo"."WorkOrders" WHERE "Id"=$1`, [id]);
  const wo = q.rows[0];
  if (!wo)
    throw new ApiError(
      404,
      "Work Order was not found.",
      "WORK_ORDER_NOT_FOUND",
    );
  if (
    user.role === "WORKER" &&
    String(wo.ResponsibleLeadUserId || "") !== String(user.id)
  )
    throw new ApiError(
      403,
      "This Work Order is not assigned to you as the responsible lead.",
      "FORBIDDEN",
    );
  return wo;
}
router.get("/", WORK_ROLES, async (req, res, next) => {
  try {
    const r = await query(
      `SELECT wo."Id" AS id,wo."WorkOrderNo" AS "workOrderNo",wo."Status" AS status,wo."AssignedPartyName" AS "assignedPartyName",wo."ResponsibleLeadName" AS "responsibleLeadName",wo."PlannedStartAt" AS "plannedStartAt",wo."Deadline" AS deadline,wo."CompletionAgentStatus" AS "completionAgentStatus",r."ReportNo" AS "reportNo",mr."RequestNo" AS "requestNo" FROM "dbo"."WorkOrders" wo JOIN "dbo"."Reports" r ON r."Id"=wo."ReportId" JOIN "dbo"."MaintenanceRequests" mr ON mr."Id"=wo."MaintenanceRequestId" WHERE ($1::text IS NULL OR wo."Status"=$1) AND ($2::uuid IS NULL OR wo."ResponsibleLeadUserId"=$2) ORDER BY wo."CreatedAt" DESC LIMIT 200`,
      [
        req.query.status || null,
        req.user.role === "WORKER" ? req.user.id : null,
      ],
    );
    res.json({ items: r.rows });
  } catch (e) {
    next(e);
  }
});
router.get("/:id", WORK_ROLES, async (req, res, next) => {
  try {
    const wo = await assertWorkAccess(req.params.id, req.user);
    const [assignments, people, materials, images, updates] = await Promise.all([
      query(
        `SELECT * FROM "dbo"."WorkOrderAssignments" WHERE "WorkOrderId"=$1 ORDER BY "AssignedAt" DESC`,
        [wo.Id],
      ),
      query(
        `SELECT * FROM "dbo"."WorkOrderPeople" WHERE "WorkOrderId"=$1 ORDER BY "IsLead" DESC,"CreatedAt"`,
        [wo.Id],
      ),
      query(
        `SELECT * FROM "dbo"."WorkOrderMaterials" WHERE "WorkOrderId"=$1 ORDER BY "Stage","CreatedAt"`,
        [wo.Id],
      ),
      query(
        `SELECT * FROM "dbo"."WorkOrderImages" WHERE "WorkOrderId"=$1 ORDER BY "CreatedAt"`,
        [wo.Id],
      ),
      query(
        `SELECT * FROM "dbo"."WorkOrderUpdates" WHERE "WorkOrderId"=$1 ORDER BY "CreatedAt" DESC`,
        [wo.Id],
      ),
    ]);
    res.json({
      workOrder: wo,
      assignments: assignments.rows,
      people: people.rows,
      materials: materials.rows,
      images: images.rows,
      updates: updates.rows,
    });
  } catch (e) {
    next(e);
  }
});

router.post("/:id/assign", ASSIGN_ROLES, async (req, res, next) => {
  try {
    const workOrder = await withTransaction(
      req.user.id,
      async (client) => {
        const current = await client.query(
          `SELECT *
           FROM "dbo"."WorkOrders"
           WHERE "Id"=$1
           FOR UPDATE`,
          [req.params.id],
        );

        const row = current.rows[0];

        if (!row) {
          throw new ApiError(
            404,
            "Work Order was not found.",
            "WORK_ORDER_NOT_FOUND",
          );
        }

        if (!["PENDING_ASSIGNMENT", "ASSIGNED"].includes(row.Status)) {
          throw new ApiError(
            409,
            `Work Order cannot be assigned from ${row.Status}.`,
            "INVALID_WORK_ORDER_STATE",
          );
        }

        const assignedPartyName = String(
          Object.prototype.hasOwnProperty.call(
            req.body || {},
            "assignedPartyName",
          )
            ? req.body.assignedPartyName || ""
            : row.AssignedPartyName || "",
        ).trim();

        const responsibleLeadUserId =
          Object.prototype.hasOwnProperty.call(
            req.body || {},
            "responsibleLeadUserId",
          )
            ? req.body.responsibleLeadUserId || null
            : row.ResponsibleLeadUserId || null;

        let responsibleLeadName = String(
          Object.prototype.hasOwnProperty.call(
            req.body || {},
            "responsibleLeadName",
          )
            ? req.body.responsibleLeadName || ""
            : row.ResponsibleLeadName || "",
        ).trim() || null;

        const responsibleLeadContact =
          Object.prototype.hasOwnProperty.call(
            req.body || {},
            "responsibleLeadContact",
          )
            ? req.body.responsibleLeadContact || null
            : row.ResponsibleLeadContact || null;

        const responsibleLeadEmail =
          Object.prototype.hasOwnProperty.call(
            req.body || {},
            "responsibleLeadEmail",
          )
            ? req.body.responsibleLeadEmail || null
            : row.ResponsibleLeadEmail || null;

        if (!assignedPartyName) {
          throw new ApiError(
            400,
            "assignedPartyName is required before dispatch.",
            "VALIDATION_ERROR",
          );
        }

        if (!responsibleLeadUserId && !responsibleLeadName) {
          throw new ApiError(
            400,
            "A responsible lead user or responsibleLeadName is required before dispatch.",
            "VALIDATION_ERROR",
          );
        }

        if (responsibleLeadUserId) {
          const lead = await client.query(
            `SELECT "Id","FullName","Role","IsActive"
             FROM "dbo"."Users"
             WHERE "Id"=$1`,
            [responsibleLeadUserId],
          );

          if (!lead.rows[0]?.IsActive) {
            throw new ApiError(
              400,
              "responsibleLeadUserId must reference an active user.",
              "INVALID_RESPONSIBLE_LEAD",
            );
          }

          if (
            ![
              "WORKER",
              "MAINTENANCE_STAFF",
              "MAINTENANCE_SUPERVISOR",
              "ADMIN",
            ].includes(lead.rows[0].Role)
          ) {
            throw new ApiError(
              400,
              "responsibleLeadUserId must reference a maintenance-capable user.",
              "INVALID_RESPONSIBLE_LEAD",
            );
          }

          if (!responsibleLeadName) {
            responsibleLeadName = lead.rows[0].FullName;
          }
        }

        const updated = await client.query(
          `UPDATE "dbo"."WorkOrders"
           SET
             "AssignedPartyName"=$2,
             "ResponsibleLeadUserId"=$3,
             "ResponsibleLeadName"=$4,
             "ResponsibleLeadContact"=$5,
             "ResponsibleLeadEmail"=$6,
             "AssignedBy"=$7,
             "AssignedAt"=NOW(),
             "Status"='ASSIGNED',
             "UpdatedAt"=NOW()
           WHERE "Id"=$1
           RETURNING *`,
          [
            row.Id,
            assignedPartyName,
            responsibleLeadUserId,
            responsibleLeadName,
            responsibleLeadContact,
            responsibleLeadEmail,
            req.user.id,
          ],
        );

        const assigned = updated.rows[0];

        await client.query(
          `INSERT INTO "dbo"."WorkOrderAssignments"
             ("WorkOrderId","AssignedPartyName",
              "ResponsibleLeadUserId","ResponsibleLeadName",
              "ResponsibleLeadContact","ResponsibleLeadEmail",
              "AssignedBy","AssignedAt","Reason")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            assigned.Id,
            assigned.AssignedPartyName,
            assigned.ResponsibleLeadUserId,
            assigned.ResponsibleLeadName,
            assigned.ResponsibleLeadContact,
            assigned.ResponsibleLeadEmail,
            req.user.id,
            assigned.AssignedAt,
            String(
              req.body?.reason ||
                (row.Status === "ASSIGNED"
                  ? "Work Order reassigned."
                  : "Initial Work Order assignment."),
            ).trim(),
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
             AND "ActionType"='ASSIGN_WORK_ORDER'
             AND "Status"='OPEN'`,
          [row.Id, req.user.id],
        );

        await notifyReporterForWorkOrder(client, row.Id, {
          type: "WORK_ORDER_ASSIGNED",
          title: "Maintenance work assigned",
          message:
            `${assigned.WorkOrderNo} was assigned to ${assigned.AssignedPartyName}.`,
          deduplicationKey:
            `report:${assigned.ReportId}:work-order-assigned:${assigned.Id}:${assigned.AssignedAt?.toISOString?.() || assigned.AssignedAt}`,
          createdAt: assigned.AssignedAt,
          payload: { status: "ASSIGNED" },
        });

        if (assigned.ResponsibleLeadUserId) {
          await notifyResponsibleLeadForWorkOrder(
            client,
            assigned.Id,
            {
              type: "WORK_ORDER_ASSIGNED",
              title: "Work Order assigned",
              message:
                `${assigned.WorkOrderNo} was assigned to you and is ready to start.`,
              deduplicationKey:
                `work-order:${assigned.Id}:assigned:${assigned.AssignedAt?.toISOString?.() || assigned.AssignedAt}`,
              createdAt: assigned.AssignedAt,
              payload: { status: "ASSIGNED" },
            },
          );
        }

        return assigned;
      },
    );

    res.json({ workOrder });
  } catch (error) {
    next(error);
  }
});

router.post("/:id/start", WORK_ROLES, async (req, res, next) => {
  try {
    await assertWorkAccess(req.params.id, req.user);
    const r = await withTransaction(req.user.id, async (c) => {
      const result = await c.query(
        `UPDATE "dbo"."WorkOrders" SET "Status"='IN_PROGRESS',"StartedBy"=COALESCE("StartedBy",$2),"StartedAt"=COALESCE("StartedAt",NOW()),"UpdatedAt"=NOW() WHERE "Id"=$1 AND "Status"='ASSIGNED' RETURNING *`,
        [req.params.id, req.user.id],
      );
      const started = result.rows[0];
      if (started) {
        await notifyReporterForWorkOrder(c, started.Id, {
          type: "WORK_STARTED",
          title: "Maintenance work started",
          message: `Maintenance work for ${started.WorkOrderNo} has started.`,
          deduplicationKey: `report:${started.ReportId}:work-started:${started.Id}`,
          createdAt: started.StartedAt,
          payload: { status: "IN_PROGRESS" },
        });
      }
      return result;
    });
    if (!r.rows[0])
      throw new ApiError(
        409,
        "Only ASSIGNED Work Orders can be started.",
        "INVALID_WORK_ORDER_STATE",
      );
    res.json({ workOrder: r.rows[0] });
  } catch (e) {
    next(e);
  }
});
router.post("/:id/status", WORK_ROLES, async (req, res, next) => {
  try {
    await assertWorkAccess(req.params.id, req.user);
    const target = String(req.body?.status || "").toUpperCase();
    const allowed = new Set(["IN_PROGRESS", "PENDING_PARTS", "ON_HOLD"]);
    if (!allowed.has(target))
      throw new ApiError(
        400,
        "status must be IN_PROGRESS, PENDING_PARTS, or ON_HOLD.",
        "INVALID_STATUS",
      );
    const message =
      String(req.body?.message || "").trim() || `Status changed to ${target}.`;
    const row = await withTransaction(req.user.id, async (c) => {
      const current = await c.query(
        `SELECT * FROM "dbo"."WorkOrders" WHERE "Id"=$1 FOR UPDATE`,
        [req.params.id],
      );
      const wo = current.rows[0];
      if (!wo)
        throw new ApiError(
          404,
          "Work Order was not found.",
          "WORK_ORDER_NOT_FOUND",
        );
      const transitions = {
        IN_PROGRESS: new Set(["PENDING_PARTS", "ON_HOLD", "REWORK_REQUIRED"]),
        PENDING_PARTS: new Set(["IN_PROGRESS"]),
        ON_HOLD: new Set(["IN_PROGRESS"]),
        REWORK_REQUIRED: new Set(["IN_PROGRESS"]),
      };
      if (!transitions[wo.Status]?.has(target))
        throw new ApiError(
          409,
          `Cannot change Work Order from ${wo.Status} to ${target}.`,
          "INVALID_WORK_ORDER_STATE",
        );
      await c.query(
        `UPDATE "dbo"."WorkOrders" SET "Status"=$2,"UpdatedAt"=NOW() WHERE "Id"=$1`,
        [wo.Id, target],
      );
      await c.query(
        `INSERT INTO "dbo"."WorkOrderUpdates" ("WorkOrderId","UpdateType","StatusSnapshot","Message","ProgressPercent","CreatedBy") VALUES ($1,'STATUS',$2,$3,$4,$5)`,
        [
          wo.Id,
          target,
          message,
          req.body?.progressPercent ?? null,
          req.user.id,
        ],
      );
      return { ...wo, Status: target };
    });
    res.json({ workOrder: row });
  } catch (e) {
    next(e);
  }
});
router.post("/:id/updates", WORK_ROLES, async (req, res, next) => {
  try {
    await assertWorkAccess(req.params.id, req.user);
    const message = String(req.body?.message || "").trim();
    if (!message)
      throw new ApiError(400, "message is required.", "VALIDATION_ERROR");
    const type = String(req.body?.updateType || "PROGRESS").toUpperCase();
    if (
      ![
        "NOTE",
        "PROGRESS",
        "STATUS",
        "PARTS",
        "HOLD",
        "COMPLETION",
        "OTHER",
      ].includes(type)
    )
      throw new ApiError(400, "updateType is invalid.", "VALIDATION_ERROR");
    const r = await withTransaction(req.user.id, (c) =>
      c.query(
        `INSERT INTO "dbo"."WorkOrderUpdates" ("WorkOrderId","UpdateType","StatusSnapshot","Message","ProgressPercent","CreatedBy") SELECT "Id",$2,"Status",$3,$4,$5 FROM "dbo"."WorkOrders" WHERE "Id"=$1 RETURNING *`,
        [
          req.params.id,
          type,
          message,
          req.body?.progressPercent ?? null,
          req.user.id,
        ],
      ),
    );
    res.status(201).json({ update: r.rows[0] });
  } catch (e) {
    next(e);
  }
});
router.post("/:id/people", WORK_ROLES, async (req, res, next) => {
  try {
    await assertWorkAccess(req.params.id, req.user);
    const name = String(req.body?.fullName || "").trim();
    if (!name)
      throw new ApiError(400, "fullName is required.", "VALIDATION_ERROR");
    const r = await withTransaction(req.user.id, (c) =>
      c.query(
        `INSERT INTO "dbo"."WorkOrderPeople" ("WorkOrderId","UserId","FullName","RoleOrTrade","Contact","IsLead","Notes") VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          req.params.id,
          req.body?.userId || null,
          name,
          req.body?.roleOrTrade || null,
          req.body?.contact || null,
          Boolean(req.body?.isLead),
          req.body?.notes || null,
        ],
      ),
    );
    res.status(201).json({ person: r.rows[0] });
  } catch (e) {
    next(e);
  }
});
router.post("/:id/materials", WORK_ROLES, async (req, res, next) => {
  try {
    const wo = await assertWorkAccess(req.params.id, req.user);
    const material = normalizeMaterialItem(req.body || {}, "material");
    const stage = String(req.body?.stage || "ACTUAL").toUpperCase();
    if (!["PLANNED", "ACTUAL"].includes(stage))
      throw new ApiError(
        400,
        "stage must be PLANNED or ACTUAL.",
        "VALIDATION_ERROR",
      );
    if (["COMPLETED", "CANCELLED"].includes(wo.Status))
      throw new ApiError(
        409,
        "Materials cannot be changed after the Work Order is closed.",
        "INVALID_WORK_ORDER_STATE",
      );
    if (
      stage === "ACTUAL" &&
      ![
        "IN_PROGRESS",
        "PENDING_PARTS",
        "ON_HOLD",
        "REWORK_REQUIRED",
        "COMPLETION_SUBMITTED",
      ].includes(wo.Status)
    )
      throw new ApiError(
        409,
        "ACTUAL materials can only be recorded during or after execution begins.",
        "INVALID_WORK_ORDER_STATE",
      );
    const r = await withTransaction(req.user.id, (c) =>
      c.query(
        `INSERT INTO "dbo"."WorkOrderMaterials" ("WorkOrderId","Stage","MaterialId","MaterialName","Unit","Quantity","Notes","RecordedBy") VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          req.params.id,
          stage,
          material.materialId,
          material.materialName,
          material.unit,
          material.quantity,
          material.notes,
          req.user.id,
        ],
      ),
    );
    res.status(201).json({ material: r.rows[0] });
  } catch (e) {
    next(e);
  }
});
router.post(
  "/:id/completion",
  WORK_ROLES,
  memoryUpload.array("images"),
  async (req, res, next) => {
    const uploaded = [];
    try {
      const wo = await assertWorkAccess(req.params.id, req.user);
      if (wo.Status !== "IN_PROGRESS")
        throw new ApiError(
          409,
          "Completion can only be submitted from IN_PROGRESS.",
          "INVALID_WORK_ORDER_STATE",
        );
      const files = requireImageFiles(req.files, { min: 1 });
      const repairNotes = String(req.body?.repairNotes || "").trim();
      if (!repairNotes)
        throw new ApiError(400, "repairNotes is required.", "VALIDATION_ERROR");
      const actualMaterials = parseActualMaterials(req.body?.actualMaterials);
      for (const file of files)
        uploaded.push(
          await uploadBuffer(file.buffer, {
            folder: config.cloudinaryWorkOrderFolder,
            resourceType: "image",
          }),
        );
      const row = await withTransaction(req.user.id, async (c) => {
        for (const result of uploaded) {
          const img = reportImageRecord(result, false);
          await c.query(
            `INSERT INTO "dbo"."WorkOrderImages" ("WorkOrderId","ImageType","CloudinaryAssetId","PublicId","SecureUrl","Version","Format","Width","Height","Bytes","ResourceType","CreatedBy") VALUES ($1,'COMPLETION',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
              wo.Id,
              img.cloudinaryAssetId,
              img.publicId,
              img.secureUrl,
              img.version,
              img.format,
              img.width,
              img.height,
              img.bytes,
              img.resourceType,
              req.user.id,
            ],
          );
        }
        const insertedMaterials = [];
        for (const material of actualMaterials) {
          const inserted = await c.query(
            `INSERT INTO "dbo"."WorkOrderMaterials"
             ("WorkOrderId","Stage","MaterialId","MaterialName","Unit","Quantity","Notes","RecordedBy")
             VALUES ($1,'ACTUAL',$2,$3,$4,$5,$6,$7)
             RETURNING *`,
            [
              wo.Id,
              material.materialId,
              material.materialName,
              material.unit,
              material.quantity,
              material.notes,
              req.user.id,
            ],
          );
          insertedMaterials.push(inserted.rows[0]);
        }

        const u = await c.query(
          `UPDATE "dbo"."WorkOrders" SET "Status"='COMPLETION_SUBMITTED',"CompletionSubmittedBy"=$2,"CompletionSubmittedAt"=NOW(),"RepairNotes"=$3,"ActualLaborHours"=$4,"ActualCrewSize"=$5,"ActualDurationDays"=$6,"ActualMaterialsNotes"=$7,"CompletionAgentStatus"='PENDING',"CompletionAgentLastError"=NULL,"UpdatedAt"=NOW() WHERE "Id"=$1 RETURNING *`,
          [
            wo.Id,
            req.user.id,
            repairNotes,
            req.body?.actualLaborHours ?? null,
            req.body?.actualCrewSize ?? null,
            req.body?.actualDurationDays ?? null,
            req.body?.actualMaterialsNotes || null,
          ],
        );
        const submitted = u.rows[0];
        await notifyRole(c, "MAINTENANCE_SUPERVISOR", {
          type: "WORK_ORDER_COMPLETION_SUBMITTED",
          title: "Completion submitted",
          message: `${submitted.WorkOrderNo} requires completion review.`,
          entityType: "WORK_ORDER",
          entityId: wo.Id,
          payload: { workOrderNo: submitted.WorkOrderNo },
          deduplicationKey: `work-order:${wo.Id}:completion-submitted:${submitted.CompletionSubmittedAt?.toISOString?.() || submitted.CompletionSubmittedAt}`,
        });
        await notifyReporterForWorkOrder(c, wo.Id, {
          type: "COMPLETION_SUBMITTED",
          title: "Completion submitted",
          message: `Completion evidence for ${submitted.WorkOrderNo} was submitted for Maintenance Supervisor review.`,
          deduplicationKey: `report:${submitted.ReportId}:completion-submitted:${submitted.Id}`,
          createdAt: submitted.CompletionSubmittedAt,
          payload: { status: "COMPLETION_SUBMITTED" },
        });
        return { workOrder: submitted, actualMaterials: insertedMaterials };
      });
      const trigger = await bestEffort(`completion process ${wo.Id}`, () =>
        agentClient.processCompletion(wo.Id),
      );
      res.json({
        workOrder: row.workOrder,
        actualMaterials: row.actualMaterials,
        completionAgentTriggered: trigger.ok,
      });
    } catch (e) {
      for (const item of uploaded)
        await destroyAsset(item.public_id, item.resource_type || "image");
      next(e);
    }
  },
);
router.get("/:id/completion-status", WORK_ROLES, async (req, res, next) => {
  try {
    await assertWorkAccess(req.params.id, req.user);
    const attempt = await bestEffort("completion status", () =>
      agentClient.completionStatus(req.params.id),
    );
    if (attempt.ok) return res.json(attempt.value);
    const r = await query(
      `SELECT "Id" AS "workOrderId","WorkOrderNo" AS "workOrderNo","Status" AS "workOrderStatus","CompletionAgentStatus" AS "completionAgentStatus","CompletionAgentAttemptCount" AS "attemptCount","CompletionAgentStartedAt" AS "startedAt","CompletionAgentCompletedAt" AS "completedAt","CompletionVisualResult" AS "visualResult","CompletionAssessmentJson" AS "assessment","CompletionAgentLastError" AS "lastError" FROM "dbo"."WorkOrders" WHERE "Id"=$1`,
      [req.params.id],
    );
    res.json({ ...r.rows[0], source: "database", agentReachable: false });
  } catch (e) {
    next(e);
  }
});
export default router;
