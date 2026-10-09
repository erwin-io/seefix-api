import { config } from "../config.js";
import { query, withTransaction } from "../database.js";
import { ApiError } from "../errors.js";
import { agentClient, bestEffort } from "../agent-client.js";
import { getSetting, settingInt } from "./settings.js";
import {
  notifyRole,
  notifyReporterForReport,
  insertOutbox,
} from "./notifications.js";

async function fallbackPackage(maintenanceRequestId) {
  const result = await query(
    `SELECT
       mr.*,
       r."ReportNo",
       r."Building",
       r."Floor",
       r."RoomOrArea",
       rv."Id" AS "MaintenanceReviewId",
       rv."Decision" AS "MaintenanceReviewDecision",
       rv."Status" AS "MaintenanceReviewStatus"
     FROM "dbo"."MaintenanceRequests" mr
     JOIN "dbo"."Reports" r ON r."Id"=mr."ReportId"
     JOIN "dbo"."MaintenanceReviews" rv
       ON rv."MaintenanceRequestId"=mr."Id"
     WHERE mr."Id"=$1`,
    [maintenanceRequestId],
  );

  const row = result.rows[0];

  if (!row) {
    throw new ApiError(
      404,
      "Maintenance Request was not found.",
      "MAINTENANCE_REQUEST_NOT_FOUND",
    );
  }

  if (
    row.MaintenanceReviewStatus !== "COMPLETED" ||
    row.MaintenanceReviewDecision !== "PROCUREMENT"
  ) {
    throw new ApiError(
      409,
      "Procurement handoff requires a completed PROCUREMENT Maintenance Review.",
      "INVALID_MAINTENANCE_REVIEW_STATE",
    );
  }

  const now = new Date();
  const followup = new Date(
    now.getTime() + config.procurementFollowupHours * 3600000,
  );

  return {
    requestSnapshot: {
      maintenanceRequestId: String(row.Id),
      maintenanceReviewId: String(row.MaintenanceReviewId),
      requestNo: row.RequestNo,
      reportId: String(row.ReportId),
      reportNo: row.ReportNo,
      effectiveCategory: row.EffectiveCategory,
      effectiveUrgency: row.EffectiveUrgency,
      requiredService: row.RequiredService,
      requiredCapability: row.RequiredCapability,
      scopeOfWork: row.ScopeOfWork,
      safetyRequirements: row.SafetyRequirements,
      preliminaryMaterialsNotes: row.PreliminaryMaterialsNotes,
      revisionNo: row.CurrentRevisionNo,
      location: {
        building: row.Building,
        floor: row.Floor,
        roomOrArea: row.RoomOrArea,
      },
    },
    emailSubject:
      `SEEFIX Maintenance Request ${row.RequestNo} - ${row.EffectiveCategory}`,
    emailMessage:
      `Maintenance Request ${row.RequestNo} was routed to Procurement by the Maintenance Department.`,
    nextFollowUpAt: followup.toISOString(),
  };
}

export async function ensureProcurementHandoff(
  maintenanceRequestId,
  submittedBy,
) {
  const existing = await query(
    `SELECT *
     FROM "dbo"."ProcurementHandoffs"
     WHERE "MaintenanceRequestId"=$1`,
    [maintenanceRequestId],
  );

  if (existing.rows[0]) {
    return {
      handoff: existing.rows[0],
      created: false,
      packageSource: "existing",
    };
  }

  const previewAttempt = await bestEffort(
    `procurement package ${maintenanceRequestId}`,
    () =>
      agentClient.previewProcurementPackage(
        maintenanceRequestId,
      ),
  );

  const pack = previewAttempt.ok
    ? previewAttempt.value
    : await fallbackPackage(maintenanceRequestId);

  const handoff = await withTransaction(
    submittedBy,
    async (client) => {
      const locked = await client.query(
        `SELECT
           mr.*,
           rv."Id" AS "MaintenanceReviewId",
           rv."Status" AS "MaintenanceReviewStatus",
           rv."Decision" AS "MaintenanceReviewDecision"
         FROM "dbo"."MaintenanceRequests" mr
         JOIN "dbo"."MaintenanceReviews" rv
           ON rv."MaintenanceRequestId"=mr."Id"
         WHERE mr."Id"=$1
         FOR UPDATE OF mr,rv`,
        [maintenanceRequestId],
      );

      const row = locked.rows[0];

      if (!row) {
        throw new ApiError(
          404,
          "Maintenance Request was not found.",
          "MAINTENANCE_REQUEST_NOT_FOUND",
        );
      }

      if (
        row.MaintenanceReviewStatus !== "COMPLETED" ||
        row.MaintenanceReviewDecision !== "PROCUREMENT"
      ) {
        throw new ApiError(
          409,
          "Procurement handoff requires a completed PROCUREMENT Maintenance Review.",
          "INVALID_MAINTENANCE_REVIEW_STATE",
        );
      }

      if (
        ![
          "REVIEWED",
          "SUBMITTED_TO_PROCUREMENT",
        ].includes(row.Status)
      ) {
        throw new ApiError(
          409,
          `Maintenance Request is ${row.Status} and cannot be submitted to Procurement.`,
          "INVALID_MAINTENANCE_REQUEST_STATE",
        );
      }

      const expectedDays = settingInt(
        await getSetting(
          client,
          "ProcurementExpectedDays",
          3,
        ),
        3,
      );

      const expectedResponseAt =
        pack.expectedResponseAt ||
        new Date(
          Date.now() + expectedDays * 86400000,
        ).toISOString();

      const nextFollowUpAt =
        pack.nextFollowUpAt ||
        new Date(
          Date.now() +
            config.procurementFollowupHours * 3600000,
        ).toISOString();

      const revision = await client.query(
        `SELECT "Id"
         FROM "dbo"."MaintenanceRequestRevisions"
         WHERE "MaintenanceRequestId"=$1
         ORDER BY "RevisionNo" DESC
         LIMIT 1`,
        [maintenanceRequestId],
      );

      const inserted = await client.query(
        `INSERT INTO "dbo"."ProcurementHandoffs"
           ("MaintenanceRequestId","MaintenanceReviewId",
            "SubmittedRevisionId","ToEmails","CcEmails",
            "EmailSubject","EmailMessage","PackageGeneratedAt",
            "RequestSnapshotJson","SubmittedBy",
            "ExpectedResponseAt","NextFollowUpAt")
         VALUES
           ($1,$2,$3,$4,$5,$6,$7,NOW(),$8::jsonb,$9,$10,$11)
         ON CONFLICT ("MaintenanceRequestId")
         DO UPDATE SET "UpdatedAt"=NOW()
         RETURNING *`,
        [
          maintenanceRequestId,
          row.MaintenanceReviewId,
          revision.rows[0]?.Id || null,
          config.procurementToEmails,
          config.procurementCcEmails,
          pack.emailSubject || null,
          pack.emailMessage || null,
          JSON.stringify(pack.requestSnapshot || {}),
          submittedBy,
          expectedResponseAt,
          nextFollowUpAt,
        ],
      );

      const created = inserted.rows[0];

      await notifyRole(client, "PROCUREMENT", {
        type: "PROCUREMENT_REQUEST",
        title: "New maintenance request",
        message:
          `${created.HandoffNo} is ready for Procurement processing.`,
        entityType: "PROCUREMENT_HANDOFF",
        entityId: created.Id,
        payload: {
          handoffNo: created.HandoffNo,
          maintenanceRequestId,
        },
        deduplicationKey:
          `procurement:${created.Id}:submitted:procurement`,
      });

      await notifyRole(
        client,
        "MAINTENANCE_SUPERVISOR",
        {
          type: "PROCUREMENT_SUBMITTED",
          title: "Maintenance request sent to Procurement",
          message:
            `${created.HandoffNo} was routed to Procurement.`,
          entityType: "PROCUREMENT_HANDOFF",
          entityId: created.Id,
          payload: {
            handoffNo: created.HandoffNo,
            maintenanceRequestId,
          },
          deduplicationKey:
            `procurement:${created.Id}:submitted:maintenance-supervisor`,
        },
      );

      await notifyReporterForReport(
        client,
        row.ReportId,
        {
          type: "PROCUREMENT_STARTED",
          title: "Sent to Procurement",
          message:
            `${row.RequestNo} was sent to Procurement for processing.`,
          deduplicationKey:
            `report:${row.ReportId}:procurement-submitted`,
          createdAt: created.SubmittedAt,
          payload: {
            requestNo: row.RequestNo,
            handoffNo: created.HandoffNo,
          },
        },
      );

      if (config.procurementToEmails.length) {
        await insertOutbox(client, {
          aggregateType: "PROCUREMENT_HANDOFF",
          aggregateId: created.Id,
          transport: "EMAIL",
          destination:
            config.procurementToEmails.join(","),
          eventName: "procurement.handoff.submitted",
          payload: {
            subject: created.EmailSubject,
            message: created.EmailMessage,
            to: config.procurementToEmails,
            cc: config.procurementCcEmails,
          },
          deduplicationKey:
            `procurement:${created.Id}:submitted:email`,
        });
      }

      return created;
    },
  );

  return {
    handoff,
    created: true,
    packageSource: previewAttempt.ok
      ? "agent"
      : "deterministic_fallback",
  };
}
