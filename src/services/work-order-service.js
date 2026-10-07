import { query, withTransaction } from "../database.js";
import { ApiError } from "../errors.js";
import { agentClient, bestEffort } from "../agent-client.js";
import { notifyRole, notifyReporterForWorkOrder } from "./notifications.js";

async function fallbackPreview(outcomeId) {
  const result = await query(
    `SELECT po.*,mr."ReportId",mr."Id" AS "MaintenanceRequestId",mr."ScopeOfWork",mr."SafetyRequirements",mr."EstimatedLaborHoursMin",mr."EstimatedLaborHoursMax"
     FROM "dbo"."ProcurementOutcomes" po JOIN "dbo"."MaintenanceRequests" mr ON mr."Id"=po."MaintenanceRequestId" WHERE po."Id"=$1`, [outcomeId]
  );
  const row = result.rows[0]; if (!row) throw new ApiError(404, "Procurement Outcome was not found.", "OUTCOME_NOT_FOUND");
  return { reportId: String(row.ReportId), maintenanceRequestId: String(row.MaintenanceRequestId), procurementOutcomeId: String(row.Id), status: "PENDING_CONFIRMATION", executionType: row.ExecutionType, assignedPartyName: row.AssignedPartyName, responsibleLeadUserId: row.ResponsibleLeadUserId ? String(row.ResponsibleLeadUserId) : null, responsibleLeadName: row.ResponsibleLeadName, responsibleLeadContact: row.ResponsibleLeadContact, responsibleLeadEmail: row.ResponsibleLeadEmail, plannedStartAt: row.PlannedStartAt, deadline: row.PlannedDeadlineAt, plannedDurationDays: row.AgreedDurationDays, plannedCrewSize: row.PlannedCrewSize, plannedLaborHours: row.EstimatedLaborHoursMax || null, instructions: row.ScopeOfWork, safetyRequirements: row.SafetyRequirements, procurementReferenceNo: row.ProcurementReferenceNo, variance: { warnings: ["Agent preview unavailable; deterministic Work Order fallback was used."] } };
}

export async function ensureWorkOrderForOutcome(outcomeId, createdBy) {
  const existing = await query(`SELECT * FROM "dbo"."WorkOrders" WHERE "ProcurementOutcomeId"=$1`, [outcomeId]);
  if (existing.rows[0]) return { workOrder: existing.rows[0], created: false, previewSource: "existing" };
  const previewAttempt = await bestEffort(`work-order preview ${outcomeId}`, () => agentClient.previewWorkOrder(outcomeId));
  const p = previewAttempt.ok ? previewAttempt.value : await fallbackPreview(outcomeId);
  const workOrder = await withTransaction(createdBy, async (client) => {
    const inserted = await client.query(
      `INSERT INTO "dbo"."WorkOrders"
       ("ReportId","MaintenanceRequestId","ProcurementOutcomeId","Status","ExecutionType","AssignedPartyName","ResponsibleLeadUserId","ResponsibleLeadName","ResponsibleLeadContact","ResponsibleLeadEmail","PlannedStartAt","Deadline","PlannedDurationDays","PlannedCrewSize","PlannedLaborHours","Instructions","SafetyRequirements","ProcurementReferenceNo","PlanningVarianceJson","CreatedBy")
       VALUES ($1,$2,$3,'PENDING_CONFIRMATION',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19)
       ON CONFLICT ("ProcurementOutcomeId") DO UPDATE SET "UpdatedAt"=NOW()
       RETURNING *`,
      [p.reportId,p.maintenanceRequestId,outcomeId,p.executionType,p.assignedPartyName,p.responsibleLeadUserId||null,p.responsibleLeadName||null,p.responsibleLeadContact||null,p.responsibleLeadEmail||null,p.plannedStartAt||null,p.deadline||null,p.plannedDurationDays??null,p.plannedCrewSize??null,p.plannedLaborHours??null,p.instructions||null,p.safetyRequirements||null,p.procurementReferenceNo||null,JSON.stringify(p.variance||{}),createdBy]
    );
    await client.query(`UPDATE "dbo"."MaintenanceRequests" SET "Status"='WORK_ORDER_CREATED',"UpdatedAt"=NOW() WHERE "Id"=$1`, [p.maintenanceRequestId]);
    const wo=inserted.rows[0];
    await client.query(
      `INSERT INTO "dbo"."WorkOrderMaterials"
       ("WorkOrderId","Stage","MaterialId","MaterialName","Unit","Quantity","Notes","RecordedBy")
       SELECT $1,'PLANNED',mrm."MaterialId",mrm."MaterialName",mrm."Unit",NULL,
              CASE
                WHEN mrm."QuantityMin" IS NOT NULL OR mrm."QuantityMax" IS NOT NULL THEN
                  CONCAT_WS(' ',mrm."Notes",
                    'Preliminary request quantity range:',
                    COALESCE(mrm."QuantityMin"::text,'?'),'to',COALESCE(mrm."QuantityMax"::text,'?'))
                ELSE mrm."Notes"
              END,
              $3
       FROM "dbo"."MaintenanceRequestMaterials" mrm
       WHERE mrm."MaintenanceRequestId"=$2
         AND NOT EXISTS (
           SELECT 1 FROM "dbo"."WorkOrderMaterials" wom
           WHERE wom."WorkOrderId"=$1
             AND wom."Stage"='PLANNED'
             AND wom."MaterialName"=mrm."MaterialName"
         )`,
      [wo.Id, p.maintenanceRequestId, createdBy],
    );
    await notifyReporterForWorkOrder(client, wo.Id, {
      type: "PROCUREMENT_COMPLETED",
      title: "Procurement processing completed",
      message: `Procurement returned the execution outcome for ${wo.WorkOrderNo}; PPO Head confirmation is pending.`,
      deduplicationKey: `report:${wo.ReportId}:procurement-completed`,
      createdAt: wo.CreatedAt,
      payload: { status: "PROCUREMENT_COMPLETED" },
    });
    await notifyRole(client,"PPO_HEAD",{type:"WORK_ORDER_READY",title:"Work Order ready for confirmation",message:`${wo.WorkOrderNo} is ready for PPO Head review.`,entityType:"WORK_ORDER",entityId:wo.Id,payload:{workOrderNo:wo.WorkOrderNo},deduplicationKey:`work-order:${wo.Id}:ready-for-confirmation`});
    return wo;
  });
  await bestEffort(`review work order ${workOrder.Id}`,()=>agentClient.reviewWorkOrder(workOrder.Id));
  return { workOrder, created: true, previewSource: previewAttempt.ok ? "agent" : "deterministic_fallback" };
}
