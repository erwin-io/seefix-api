/**
 * Persistent SEEFIX notification helpers.
 *
 * Lifecycle notifications are deliberately idempotent. The canonical schema
 * does not have a dedicated notification-deduplication column, so the key is
 * stored in Payload and protected with a transaction-scoped advisory lock.
 */

function payloadWithDedupe(payload, deduplicationKey) {
  return deduplicationKey ? { ...(payload || {}), deduplicationKey } : payload || {};
}

export async function createNotification(
  client,
  {
    userId,
    type,
    title,
    message,
    entityType = null,
    entityId = null,
    payload = {},
    deduplicationKey = null,
    createdAt = null,
  },
) {
  const normalizedPayload = payloadWithDedupe(payload, deduplicationKey);

  if (deduplicationKey) {
    // Prevent duplicate lifecycle notifications when an endpoint is retried or
    // the notification backfill runs after the real-time event was delivered.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`,
      [`notification:${userId}:${deduplicationKey}`],
    );
  }

  const result = await client.query(
    `INSERT INTO "dbo"."Notifications"
       ("UserId","Type","Title","Message","EntityType","EntityId","Payload","CreatedAt","UpdatedAt")
     SELECT $1,$2,$3,$4,$5,$6,$7::jsonb,COALESCE($8::timestamptz,NOW()),COALESCE($8::timestamptz,NOW())
     WHERE $9::text IS NULL
        OR NOT EXISTS (
             SELECT 1
             FROM "dbo"."Notifications" n
             WHERE n."UserId"=$1
               AND n."Payload"->>'deduplicationKey'=$9
           )
     RETURNING
       "Id" AS id,"Type" AS type,"Title" AS title,"Message" AS message,
       "EntityType" AS "entityType","EntityId" AS "entityId","Payload" AS payload,
       "IsRead" AS "isRead","ReadAt" AS "readAt","CreatedAt" AS "createdAt"`,
    [
      userId,
      type,
      title,
      message,
      entityType,
      entityId,
      JSON.stringify(normalizedPayload),
      createdAt,
      deduplicationKey,
    ],
  );

  return result.rows[0] || null;
}

export async function notifyRole(client, role, notification) {
  const users = await client.query(
    `SELECT "Id" FROM "dbo"."Users" WHERE "Role"=$1 AND "IsActive"=TRUE`,
    [role],
  );
  const created = [];
  for (const row of users.rows) {
    const item = await createNotification(client, {
      userId: row.Id,
      ...notification,
    });
    if (item) created.push(item);
  }
  return created;
}

export async function notifyReporterForReport(client, reportId, notification) {
  const result = await client.query(
    `SELECT "ReporterId","ReportNo" FROM "dbo"."Reports" WHERE "Id"=$1`,
    [reportId],
  );
  const report = result.rows[0];
  if (!report) return null;
  return createNotification(client, {
    ...notification,
    userId: report.ReporterId,
    entityType: "REPORT",
    entityId: reportId,
    payload: { reportNo: report.ReportNo, ...(notification.payload || {}) },
  });
}

export async function notifyReporterForWorkOrder(client, workOrderId, notification) {
  const result = await client.query(
    `SELECT wo."Id" AS "WorkOrderId",wo."WorkOrderNo",r."Id" AS "ReportId",r."ReportNo",r."ReporterId"
     FROM "dbo"."WorkOrders" wo
     JOIN "dbo"."Reports" r ON r."Id"=wo."ReportId"
     WHERE wo."Id"=$1`,
    [workOrderId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return createNotification(client, {
    ...notification,
    userId: row.ReporterId,
    entityType: "REPORT",
    entityId: row.ReportId,
    payload: {
      reportNo: row.ReportNo,
      workOrderId: String(row.WorkOrderId),
      workOrderNo: row.WorkOrderNo,
      ...(notification.payload || {}),
    },
  });
}

export async function notifyResponsibleLeadForWorkOrder(
  client,
  workOrderId,
  notification,
) {
  const result = await client.query(
    `SELECT "ResponsibleLeadUserId","WorkOrderNo"
     FROM "dbo"."WorkOrders"
     WHERE "Id"=$1`,
    [workOrderId],
  );
  const row = result.rows[0];
  if (!row?.ResponsibleLeadUserId) return null;
  return createNotification(client, {
    ...notification,
    userId: row.ResponsibleLeadUserId,
    entityType: "WORK_ORDER",
    entityId: workOrderId,
    payload: { workOrderNo: row.WorkOrderNo, ...(notification.payload || {}) },
  });
}

/**
 * Backfill reporter lifecycle notifications from durable business timestamps.
 *
 * This makes notifications resilient to API restarts, older records created
 * before lifecycle notifications existed, and Agent work that completes in a
 * background process. It does not alter any business status.
 */
export async function syncReporterLifecycleNotifications(client, reporterId) {
  const result = await client.query(
    `SELECT
       r."Id" AS "ReportId",r."ReportNo",r."AgentStatus",r."AgentCompletedAt",
       r."ReviewedAt",r."Status" AS "ReportStatus",r."ResolvedAt",
       mr."Id" AS "MaintenanceRequestId",mr."RequestNo",mr."AuthorizedAt",
       ph."Id" AS "HandoffId",ph."HandoffNo",ph."SubmittedAt" AS "ProcurementSubmittedAt",ph."CompletedAt" AS "ProcurementCompletedAt",
       wo."Id" AS "WorkOrderId",wo."WorkOrderNo",wo."AssignedPartyName",
       wo."ConfirmedAt",wo."StartedAt",wo."CompletionSubmittedAt",
       wo."ResolvedAt" AS "WorkOrderResolvedAt",
       rework."Id" AS "ReworkHistoryId",rework."CreatedAt" AS "ReworkAt"
     FROM "dbo"."Reports" r
     LEFT JOIN "dbo"."MaintenanceRequests" mr ON mr."ReportId"=r."Id"
     LEFT JOIN "dbo"."ProcurementHandoffs" ph ON ph."MaintenanceRequestId"=mr."Id"
     LEFT JOIN "dbo"."ProcurementOutcomes" po ON po."ProcurementHandoffId"=ph."Id"
     LEFT JOIN "dbo"."WorkOrders" wo ON wo."ProcurementOutcomeId"=po."Id"
     LEFT JOIN LATERAL (
       SELECT h."Id",h."CreatedAt"
       FROM "dbo"."WorkOrderStatusHistory" h
       WHERE h."WorkOrderId"=wo."Id" AND h."NewStatus"='REWORK_REQUIRED'
       ORDER BY h."CreatedAt" DESC
       LIMIT 1
     ) rework ON TRUE
     WHERE r."ReporterId"=$1
     ORDER BY r."CreatedAt" DESC`,
    [reporterId],
  );

  let createdCount = 0;
  const create = async (row, spec) => {
    const created = await createNotification(client, {
      ...spec,
      userId: reporterId,
      entityType: "REPORT",
      entityId: row.ReportId,
      payload: {
        reportNo: row.ReportNo,
        ...(row.WorkOrderId
          ? {
              workOrderId: String(row.WorkOrderId),
              workOrderNo: row.WorkOrderNo,
            }
          : {}),
        ...(spec.payload || {}),
      },
    });
    if (created) createdCount += 1;
  };

  for (const row of result.rows) {
    if (row.AgentStatus === "COMPLETED" && row.AgentCompletedAt) {
      await create(row, {
        type: "REPORT_ASSESSED",
        title: "Report assessment ready",
        message: `Automated assessment for ${row.ReportNo} is ready.`,
        deduplicationKey: `report:${row.ReportId}:assessment-completed`,
        createdAt: row.AgentCompletedAt,
        payload: { status: "ASSESSED" },
      });
    }

    const maintenanceRequestedAt = row.AuthorizedAt || row.ReviewedAt;
    if (maintenanceRequestedAt) {
      await create(row, {
        type: "MAINTENANCE_REQUESTED",
        title: "Maintenance requested",
        message: `PPO reviewed ${row.ReportNo} and requested maintenance.`,
        deduplicationKey: `report:${row.ReportId}:maintenance-requested`,
        createdAt: maintenanceRequestedAt,
        payload: { requestNo: row.RequestNo || null },
      });
    }

    if (row.ProcurementSubmittedAt) {
      await create(row, {
        type: "PROCUREMENT_STARTED",
        title: "Sent to Procurement",
        message: `${row.RequestNo || row.ReportNo} was sent to Procurement for processing.`,
        deduplicationKey: `report:${row.ReportId}:procurement-submitted`,
        createdAt: row.ProcurementSubmittedAt,
        payload: { handoffNo: row.HandoffNo || null },
      });
    }

    if (row.ProcurementCompletedAt) {
      await create(row, {
        type: "PROCUREMENT_COMPLETED",
        title: "Procurement processing completed",
        message: `Procurement returned the execution outcome for ${row.RequestNo || row.ReportNo}.`,
        deduplicationKey: `report:${row.ReportId}:procurement-completed`,
        createdAt: row.ProcurementCompletedAt,
        payload: { handoffNo: row.HandoffNo || null },
      });
    }

    if (row.ConfirmedAt && row.WorkOrderId) {
      await create(row, {
        type: "WORK_ORDER_ASSIGNED",
        title: "Maintenance work assigned",
        message: `${row.WorkOrderNo} was confirmed${row.AssignedPartyName ? ` and assigned to ${row.AssignedPartyName}` : ""}.`,
        deduplicationKey: `report:${row.ReportId}:work-order-confirmed:${row.WorkOrderId}`,
        createdAt: row.ConfirmedAt,
        payload: { status: "ASSIGNED" },
      });
    }

    if (row.StartedAt && row.WorkOrderId) {
      await create(row, {
        type: "WORK_STARTED",
        title: "Maintenance work started",
        message: `Maintenance work for ${row.ReportNo} has started.`,
        deduplicationKey: `report:${row.ReportId}:work-started:${row.WorkOrderId}`,
        createdAt: row.StartedAt,
        payload: { status: "IN_PROGRESS" },
      });
    }

    if (row.CompletionSubmittedAt && row.WorkOrderId) {
      await create(row, {
        type: "COMPLETION_SUBMITTED",
        title: "Completion submitted",
        message: `Completion evidence for ${row.WorkOrderNo} was submitted for PPO Head review.`,
        deduplicationKey: `report:${row.ReportId}:completion-submitted:${row.WorkOrderId}`,
        createdAt: row.CompletionSubmittedAt,
        payload: { status: "COMPLETION_SUBMITTED" },
      });
    }

    if (row.ReworkAt && row.ReworkHistoryId) {
      await create(row, {
        type: "WORK_ORDER_REWORK_REQUIRED",
        title: "Additional work required",
        message: `PPO Head requested additional work for ${row.WorkOrderNo}.`,
        deduplicationKey: `report:${row.ReportId}:rework:${row.WorkOrderId}`,
        createdAt: row.ReworkAt,
        payload: { status: "REWORK_REQUIRED" },
      });
    }

    const resolvedAt = row.ResolvedAt || row.WorkOrderResolvedAt;
    if (row.ReportStatus === "RESOLVED" && resolvedAt) {
      await create(row, {
        type: "REPORT_RESOLVED",
        title: "Report resolved",
        message: `${row.ReportNo} has been resolved after PPO Head accepted the completed work.`,
        deduplicationKey: `report:${row.ReportId}:resolved`,
        createdAt: resolvedAt,
        payload: { status: "RESOLVED" },
      });
    }
  }

  return createdCount;
}

export async function insertOutbox(
  client,
  {
    aggregateType,
    aggregateId,
    transport = "IN_APP",
    recipientUserId = null,
    channelName = null,
    destination = null,
    eventName,
    payload = {},
    deduplicationKey = null,
  },
) {
  await client.query(
    `INSERT INTO "dbo"."OutboxEvents"
     ("AggregateType","AggregateId","Transport","RecipientUserId","ChannelName","Destination","EventName","Payload","DeduplicationKey")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
     ON CONFLICT ("DeduplicationKey") WHERE "DeduplicationKey" IS NOT NULL DO NOTHING`,
    [
      aggregateType,
      aggregateId,
      transport,
      recipientUserId,
      channelName,
      destination,
      eventName,
      JSON.stringify(payload),
      deduplicationKey,
    ],
  );
}
