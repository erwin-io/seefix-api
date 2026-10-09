import { query, withTransaction } from "../database.js";
import { ApiError } from "../errors.js";
import { agentClient, bestEffort } from "../agent-client.js";
import {
  notifyRole,
  notifyReporterForWorkOrder,
} from "./notifications.js";

async function fallbackInternalPreview(maintenanceReviewId) {
  const result = await query(
    `SELECT
       rv."Id" AS "MaintenanceReviewId",
       rv."Status" AS "MaintenanceReviewStatus",
       rv."Decision" AS "MaintenanceReviewDecision",
       mr."Id" AS "MaintenanceRequestId",
       mr."ReportId",
       mr."ScopeOfWork",
       mr."SafetyRequirements",
       mr."TargetStartAt",
       mr."DesiredCompletionAt",
       mr."EstimatedLaborHoursMax"
     FROM "dbo"."MaintenanceReviews" rv
     JOIN "dbo"."MaintenanceRequests" mr
       ON mr."Id"=rv."MaintenanceRequestId"
     WHERE rv."Id"=$1`,
    [maintenanceReviewId],
  );

  const row = result.rows[0];

  if (!row) {
    throw new ApiError(
      404,
      "Maintenance Review was not found.",
      "MAINTENANCE_REVIEW_NOT_FOUND",
    );
  }

  if (
    row.MaintenanceReviewStatus !== "COMPLETED" ||
    row.MaintenanceReviewDecision !== "INTERNAL"
  ) {
    throw new ApiError(
      409,
      "Internal Work Order requires a completed INTERNAL Maintenance Review.",
      "INVALID_MAINTENANCE_REVIEW_STATE",
    );
  }

  return {
    reportId: String(row.ReportId),
    maintenanceRequestId:
      String(row.MaintenanceRequestId),
    maintenanceReviewId:
      String(row.MaintenanceReviewId),
    routeType: "INTERNAL",
    procurementOutcomeId: null,
    status: "PENDING_ASSIGNMENT",
    executionType: "INTERNAL",
    assignedPartyName: null,
    responsibleLeadUserId: null,
    responsibleLeadName: null,
    responsibleLeadContact: null,
    responsibleLeadEmail: null,
    plannedStartAt: row.TargetStartAt,
    deadline: row.DesiredCompletionAt,
    plannedDurationDays: null,
    plannedCrewSize: null,
    plannedLaborHours:
      row.EstimatedLaborHoursMax || null,
    instructions: row.ScopeOfWork,
    safetyRequirements: row.SafetyRequirements,
    procurementReferenceNo: null,
    readiness: {
      ready: true,
      blocking: [],
      warnings: [
        "Agent preview unavailable; deterministic INTERNAL Work Order fallback was used.",
      ],
      info: [],
    },
    variance: {
      items: [],
      has_warnings: false,
    },
  };
}

async function fallbackProcurementPreview(
  procurementOutcomeId,
) {
  const result = await query(
    `SELECT
       po.*,
       ph."MaintenanceReviewId",
       ph."Status" AS "HandoffStatus",
       mr."ReportId",
       mr."Id" AS "MaintenanceRequestId",
       mr."ScopeOfWork",
       mr."SafetyRequirements",
       mr."EstimatedLaborHoursMax"
     FROM "dbo"."ProcurementOutcomes" po
     JOIN "dbo"."ProcurementHandoffs" ph
       ON ph."Id"=po."ProcurementHandoffId"
     JOIN "dbo"."MaintenanceRequests" mr
       ON mr."Id"=po."MaintenanceRequestId"
     WHERE po."Id"=$1`,
    [procurementOutcomeId],
  );

  const row = result.rows[0];

  if (!row) {
    throw new ApiError(
      404,
      "Procurement Outcome was not found.",
      "OUTCOME_NOT_FOUND",
    );
  }

  if (row.HandoffStatus !== "COMPLETED") {
    throw new ApiError(
      409,
      "Procurement handoff must be completed before creating a Work Order.",
      "INVALID_HANDOFF_STATE",
    );
  }

  return {
    reportId: String(row.ReportId),
    maintenanceRequestId:
      String(row.MaintenanceRequestId),
    maintenanceReviewId:
      String(row.MaintenanceReviewId),
    routeType: "PROCUREMENT",
    procurementOutcomeId: String(row.Id),
    status: "PENDING_ASSIGNMENT",
    executionType: row.ExecutionType,
    assignedPartyName: row.AssignedPartyName,
    responsibleLeadUserId:
      row.ResponsibleLeadUserId
        ? String(row.ResponsibleLeadUserId)
        : null,
    responsibleLeadName:
      row.ResponsibleLeadName,
    responsibleLeadContact:
      row.ResponsibleLeadContact,
    responsibleLeadEmail:
      row.ResponsibleLeadEmail,
    plannedStartAt: row.PlannedStartAt,
    deadline: row.PlannedDeadlineAt,
    plannedDurationDays:
      row.AgreedDurationDays,
    plannedCrewSize:
      row.PlannedCrewSize,
    plannedLaborHours:
      row.EstimatedLaborHoursMax || null,
    instructions: row.ScopeOfWork,
    safetyRequirements: row.SafetyRequirements,
    procurementReferenceNo:
      row.ProcurementReferenceNo,
    readiness: {
      ready: true,
      blocking: [],
      warnings: [
        "Agent preview unavailable; deterministic PROCUREMENT Work Order fallback was used.",
      ],
      info: [],
    },
    variance: {
      items: [],
      has_warnings: false,
    },
  };
}

async function copyPlannedMaterials(
  client,
  workOrderId,
  maintenanceRequestId,
  recordedBy,
) {
  await client.query(
    `INSERT INTO "dbo"."WorkOrderMaterials"
       ("WorkOrderId","Stage","MaterialId","MaterialName",
        "Unit","Quantity","Notes","RecordedBy")
     SELECT
       $1,
       'PLANNED',
       mrm."MaterialId",
       mrm."MaterialName",
       mrm."Unit",
       NULL,
       CASE
         WHEN mrm."QuantityMin" IS NOT NULL
           OR mrm."QuantityMax" IS NOT NULL
         THEN CONCAT_WS(
           ' ',
           mrm."Notes",
           'Preliminary request quantity range:',
           COALESCE(mrm."QuantityMin"::text,'?'),
           'to',
           COALESCE(mrm."QuantityMax"::text,'?')
         )
         ELSE mrm."Notes"
       END,
       $3
     FROM "dbo"."MaintenanceRequestMaterials" mrm
     WHERE mrm."MaintenanceRequestId"=$2
       AND NOT EXISTS
       (
         SELECT 1
         FROM "dbo"."WorkOrderMaterials" wom
         WHERE wom."WorkOrderId"=$1
           AND wom."Stage"='PLANNED'
           AND wom."MaterialName"=mrm."MaterialName"
       )`,
    [
      workOrderId,
      maintenanceRequestId,
      recordedBy,
    ],
  );
}

async function createWorkOrderFromPreview(
  preview,
  createdBy,
  previewSource,
) {
  if (!preview?.maintenanceReviewId) {
    throw new ApiError(
      409,
      "Work Order preview is missing maintenanceReviewId.",
      "INVALID_WORK_ORDER_PREVIEW",
    );
  }

  if (
    preview.readiness &&
    preview.readiness.ready === false
  ) {
    throw new ApiError(
      409,
      "Work Order source data is not ready.",
      "WORK_ORDER_NOT_READY",
      preview.readiness,
    );
  }

  return withTransaction(
    createdBy,
    async (client) => {
      const existing = await client.query(
        `SELECT *
         FROM "dbo"."WorkOrders"
         WHERE "MaintenanceReviewId"=$1
         FOR UPDATE`,
        [preview.maintenanceReviewId],
      );

      if (existing.rows[0]) {
        return {
          workOrder: existing.rows[0],
          created: false,
          previewSource: "existing",
        };
      }

      const inserted = await client.query(
        `INSERT INTO "dbo"."WorkOrders"
           ("ReportId","MaintenanceRequestId",
            "MaintenanceReviewId","RouteType",
            "ProcurementOutcomeId","Status","ExecutionType",
            "AssignedPartyName","ResponsibleLeadUserId",
            "ResponsibleLeadName","ResponsibleLeadContact",
            "ResponsibleLeadEmail","PlannedStartAt","Deadline",
            "PlannedDurationDays","PlannedCrewSize",
            "PlannedLaborHours","Instructions",
            "SafetyRequirements","ProcurementReferenceNo",
            "PlanningVarianceJson","CreatedBy")
         VALUES
           ($1,$2,$3,$4,$5,'PENDING_ASSIGNMENT',$6,$7,$8,$9,$10,$11,
            $12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21)
         RETURNING *`,
        [
          preview.reportId,
          preview.maintenanceRequestId,
          preview.maintenanceReviewId,
          preview.routeType,
          preview.procurementOutcomeId || null,
          preview.executionType,
          preview.assignedPartyName || null,
          preview.responsibleLeadUserId || null,
          preview.responsibleLeadName || null,
          preview.responsibleLeadContact || null,
          preview.responsibleLeadEmail || null,
          preview.plannedStartAt || null,
          preview.deadline || null,
          preview.plannedDurationDays ?? null,
          preview.plannedCrewSize ?? null,
          preview.plannedLaborHours ?? null,
          preview.instructions || null,
          preview.safetyRequirements || null,
          preview.procurementReferenceNo || null,
          JSON.stringify(preview.variance || {}),
          createdBy,
        ],
      );

      const workOrder = inserted.rows[0];

      await copyPlannedMaterials(
        client,
        workOrder.Id,
        preview.maintenanceRequestId,
        createdBy,
      );

      await notifyRole(
        client,
        "MAINTENANCE_STAFF",
        {
          type: "WORK_ORDER_PENDING_ASSIGNMENT",
          title: "Work Order ready for assignment",
          message:
            `${workOrder.WorkOrderNo} is ready for maintenance dispatch.`,
          entityType: "WORK_ORDER",
          entityId: workOrder.Id,
          payload: {
            workOrderNo: workOrder.WorkOrderNo,
            routeType: workOrder.RouteType,
          },
          deduplicationKey:
            `work-order:${workOrder.Id}:pending-assignment`,
        },
      );

      await notifyReporterForWorkOrder(
        client,
        workOrder.Id,
        {
          type: "WORK_ORDER_PREPARED",
          title: "Work Order prepared",
          message:
            `${workOrder.WorkOrderNo} was prepared and is waiting for maintenance assignment.`,
          deduplicationKey:
            `report:${workOrder.ReportId}:work-order-prepared:${workOrder.Id}`,
          createdAt: workOrder.CreatedAt,
          payload: {
            status: "PENDING_ASSIGNMENT",
            routeType: workOrder.RouteType,
          },
        },
      );

      return {
        workOrder,
        created: true,
        previewSource,
      };
    },
  );
}

export async function ensureInternalWorkOrder(
  maintenanceReviewId,
  createdBy,
) {
  const existing = await query(
    `SELECT *
     FROM "dbo"."WorkOrders"
     WHERE "MaintenanceReviewId"=$1`,
    [maintenanceReviewId],
  );

  if (existing.rows[0]) {
    return {
      workOrder: existing.rows[0],
      created: false,
      previewSource: "existing",
    };
  }

  const previewAttempt = await bestEffort(
    `internal work-order preview ${maintenanceReviewId}`,
    () =>
      agentClient.previewInternalWorkOrder(
        maintenanceReviewId,
      ),
  );

  const preview = previewAttempt.ok
    ? previewAttempt.value
    : await fallbackInternalPreview(
        maintenanceReviewId,
      );

  const result = await createWorkOrderFromPreview(
    preview,
    createdBy,
    previewAttempt.ok
      ? "agent"
      : "deterministic_fallback",
  );

  if (result.created) {
    await bestEffort(
      `review work order ${result.workOrder.Id}`,
      () =>
        agentClient.reviewWorkOrder(
          result.workOrder.Id,
        ),
    );
  }

  return result;
}

export async function ensureWorkOrderForOutcome(
  procurementOutcomeId,
  createdBy,
) {
  const existing = await query(
    `SELECT *
     FROM "dbo"."WorkOrders"
     WHERE "ProcurementOutcomeId"=$1`,
    [procurementOutcomeId],
  );

  if (existing.rows[0]) {
    return {
      workOrder: existing.rows[0],
      created: false,
      previewSource: "existing",
    };
  }

  const previewAttempt = await bestEffort(
    `procurement work-order preview ${procurementOutcomeId}`,
    () =>
      agentClient.previewProcurementWorkOrder(
        procurementOutcomeId,
      ),
  );

  const preview = previewAttempt.ok
    ? previewAttempt.value
    : await fallbackProcurementPreview(
        procurementOutcomeId,
      );

  const result = await createWorkOrderFromPreview(
    preview,
    createdBy,
    previewAttempt.ok
      ? "agent"
      : "deterministic_fallback",
  );

  if (result.created) {
    await bestEffort(
      `review work order ${result.workOrder.Id}`,
      () =>
        agentClient.reviewWorkOrder(
          result.workOrder.Id,
        ),
    );
  }

  return result;
}
