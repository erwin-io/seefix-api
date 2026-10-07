import { config } from "../config.js";
import { query, withTransaction } from "../database.js";
import { ApiError } from "../errors.js";
import { agentClient, bestEffort } from "../agent-client.js";
import { getSetting, settingBool, settingInt } from "./settings.js";
import { notifyRole, notifyReporterForReport, insertOutbox } from "./notifications.js";

async function fallbackPackage(maintenanceRequestId) {
  const r = await query(
    `SELECT mr.*,r."ReportNo",r."Building",r."Floor",r."RoomOrArea"
     FROM "dbo"."MaintenanceRequests" mr JOIN "dbo"."Reports" r ON r."Id"=mr."ReportId" WHERE mr."Id"=$1`, [maintenanceRequestId]
  );
  const mr = r.rows[0];
  if (!mr) throw new ApiError(404, "Maintenance Request was not found.", "MAINTENANCE_REQUEST_NOT_FOUND");
  const now = new Date(); const followup = new Date(now.getTime()+config.procurementFollowupHours*3600000);
  return {
    requestSnapshot: { maintenanceRequestId: String(mr.Id), requestNo: mr.RequestNo, reportId: String(mr.ReportId), reportNo: mr.ReportNo, effectiveCategory: mr.EffectiveCategory, effectiveUrgency: mr.EffectiveUrgency, requiredService: mr.RequiredService, requiredCapability: mr.RequiredCapability, scopeOfWork: mr.ScopeOfWork, safetyRequirements: mr.SafetyRequirements, preliminaryMaterialsNotes: mr.PreliminaryMaterialsNotes, revisionNo: mr.CurrentRevisionNo, location: { building: mr.Building, floor: mr.Floor, roomOrArea: mr.RoomOrArea } },
    emailSubject: `SEEFIX Maintenance Request ${mr.RequestNo} - ${mr.EffectiveCategory}`,
    emailMessage: `Maintenance Request ${mr.RequestNo} is authorized and ready for the University's existing Procurement process.`,
    nextFollowUpAt: followup.toISOString(),
  };
}

export async function ensureProcurementHandoff(maintenanceRequestId, submittedBy) {
  const existing = await query(`SELECT * FROM "dbo"."ProcurementHandoffs" WHERE "MaintenanceRequestId"=$1`, [maintenanceRequestId]);
  if (existing.rows[0]) return { handoff: existing.rows[0], created: false, packageSource: "existing" };
  const previewAttempt = await bestEffort(`procurement package ${maintenanceRequestId}`, () => agentClient.previewProcurementPackage(maintenanceRequestId));
  const pack = previewAttempt.ok ? previewAttempt.value : await fallbackPackage(maintenanceRequestId);
  const handoff = await withTransaction(submittedBy, async (client) => {
    const locked = await client.query(`SELECT * FROM "dbo"."MaintenanceRequests" WHERE "Id"=$1 FOR UPDATE`, [maintenanceRequestId]);
    const mr = locked.rows[0];
    if (!mr) throw new ApiError(404, "Maintenance Request was not found.", "MAINTENANCE_REQUEST_NOT_FOUND");
    if (!["AUTHORIZED","SUBMITTED_TO_PROCUREMENT"].includes(mr.Status)) throw new ApiError(409, "Maintenance Request is not authorized for Procurement.", "INVALID_MAINTENANCE_REQUEST_STATE");
    const expectedDays = settingInt(await getSetting(client, "ProcurementExpectedDays", 3), 3);
    const expected = pack.expectedResponseAt || new Date(Date.now()+expectedDays*86400000).toISOString();
    const next = pack.nextFollowUpAt || new Date(Date.now()+config.procurementFollowupHours*3600000).toISOString();
    const revision = await client.query(`SELECT "Id" FROM "dbo"."MaintenanceRequestRevisions" WHERE "MaintenanceRequestId"=$1 ORDER BY "RevisionNo" DESC LIMIT 1`, [maintenanceRequestId]);
    const inserted = await client.query(
      `INSERT INTO "dbo"."ProcurementHandoffs"
       ("MaintenanceRequestId","SubmittedRevisionId","ToEmails","CcEmails","EmailSubject","EmailMessage","PackageGeneratedAt","RequestSnapshotJson","SubmittedBy","ExpectedResponseAt","NextFollowUpAt")
       VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7::jsonb,$8,$9,$10)
       ON CONFLICT ("MaintenanceRequestId") DO UPDATE SET "UpdatedAt"=NOW()
       RETURNING *`,
      [maintenanceRequestId, revision.rows[0]?.Id || null, config.procurementToEmails, config.procurementCcEmails, pack.emailSubject || null, pack.emailMessage || null, JSON.stringify(pack.requestSnapshot || {}), submittedBy, expected, next],
    );
    await client.query(`UPDATE "dbo"."MaintenanceRequests" SET "Status"='SUBMITTED_TO_PROCUREMENT',"UpdatedAt"=NOW() WHERE "Id"=$1`, [maintenanceRequestId]);
    const row = inserted.rows[0];
    await notifyRole(client, "PROCUREMENT", { type: "PROCUREMENT_REQUEST", title: "New maintenance request", message: `${row.HandoffNo} is ready for Procurement processing.`, entityType: "PROCUREMENT_HANDOFF", entityId: row.Id, payload: { handoffNo: row.HandoffNo }, deduplicationKey: `procurement:${row.Id}:submitted:procurement` });
    await notifyRole(client, "PPO_HEAD", { type: "PROCUREMENT_SUBMITTED", title: "Maintenance request sent to Procurement", message: `${row.HandoffNo} was submitted for Procurement visibility.`, entityType: "PROCUREMENT_HANDOFF", entityId: row.Id, payload: { handoffNo: row.HandoffNo }, deduplicationKey: `procurement:${row.Id}:submitted:ppo-head` });
    await notifyReporterForReport(client, mr.ReportId, {
      type: "PROCUREMENT_STARTED",
      title: "Sent to Procurement",
      message: `${mr.RequestNo} was sent to Procurement for processing.`,
      deduplicationKey: `report:${mr.ReportId}:procurement-submitted`,
      createdAt: row.SubmittedAt,
      payload: { requestNo: mr.RequestNo, handoffNo: row.HandoffNo },
    });
    if (config.procurementToEmails.length) await insertOutbox(client, { aggregateType: "PROCUREMENT_HANDOFF", aggregateId: row.Id, transport: "EMAIL", destination: config.procurementToEmails.join(","), eventName: "procurement.handoff.submitted", payload: { subject: row.EmailSubject, message: row.EmailMessage, to: config.procurementToEmails, cc: config.procurementCcEmails }, deduplicationKey: `procurement:${row.Id}:submitted:email` });
    return row;
  });
  return { handoff, created: true, packageSource: previewAttempt.ok ? "agent" : "deterministic_fallback" };
}

export async function maybeAutoSubmitProcurement(maintenanceRequestId, submittedBy) {
  const flags = await withTransaction(submittedBy, async (client) => ({
    auto: settingBool(await getSetting(client, "ProcurementAutoSubmitAfterPpoStaffVerification", true), true),
    headRequired: settingBool(await getSetting(client, "RequirePpoHeadBeforeProcurement", false), false),
  }));
  if (!flags.auto || flags.headRequired) return { submitted: false, reason: flags.headRequired ? "PPO_HEAD_PRE_PROCUREMENT_REQUIRED" : "AUTO_SUBMIT_DISABLED" };
  return { submitted: true, ...(await ensureProcurementHandoff(maintenanceRequestId, submittedBy)) };
}
