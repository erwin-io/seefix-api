import { config } from "../config.js";
import { withTransaction, query } from "../database.js";
import { uploadBuffer, destroyAsset, reportImageRecord } from "../cloudinary.js";
import { ApiError } from "../errors.js";
import { agentClient, bestEffort } from "../agent-client.js";
import { createNotification } from "./notifications.js";

export async function createReport(user, fields, files) {
  const uploaded = [];
  try {
    for (const file of files) {
      uploaded.push(await uploadBuffer(file.buffer, { folder: config.cloudinaryReportFolder, resourceType: "image" }));
    }
    const report = await withTransaction(user.id, async (client) => {
      const inserted = await client.query(
        `INSERT INTO "dbo"."Reports" ("ReporterId","Description","Notes","Building","Floor","RoomOrArea","GpsLat","GpsLng")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING "Id" AS id,"ReportNo" AS "reportNo","Status" AS status,"AgentStatus" AS "agentStatus","CreatedAt" AS "createdAt"`,
        [user.id, fields.description || null, fields.notes || null, fields.building || null, fields.floor || null, fields.roomOrArea || null, fields.gpsLat ?? null, fields.gpsLng ?? null],
      );
      const row = inserted.rows[0];
      for (let i = 0; i < uploaded.length; i += 1) {
        const image = reportImageRecord(uploaded[i], i === 0);
        await client.query(
          `INSERT INTO "dbo"."ReportImages"
           ("ReportId","CloudinaryAssetId","PublicId","SecureUrl","Version","Format","Width","Height","Bytes","ResourceType","IsPrimary")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [row.id, image.cloudinaryAssetId, image.publicId, image.secureUrl, image.version, image.format, image.width, image.height, image.bytes, image.resourceType, image.isPrimary],
        );
      }
      await createNotification(client, { userId: user.id, type: "REPORT_SUBMITTED", title: "Report submitted", message: `Report ${row.reportNo} was submitted and queued for assessment.`, entityType: "REPORT", entityId: row.id, payload: { reportNo: row.reportNo }, deduplicationKey: `report:${row.id}:submitted`, createdAt: row.createdAt });
      return row;
    });
    const trigger = await bestEffort(`process report ${report.id}`, () => agentClient.processReport(report.id));
    return { ...report, imageCount: uploaded.length, agentTriggerAccepted: trigger.ok };
  } catch (error) {
    for (const item of uploaded) await destroyAsset(item.public_id, item.resource_type || "image");
    throw error;
  }
}

export async function getReportDetail(reportId, user) {
  const result = await query(
    `SELECT r.*, u."FullName" AS "ReporterName", p."LivePriorityScore", p."EffectiveCategory", p."EffectiveUrgency"
     FROM "dbo"."Reports" r
     JOIN "dbo"."Users" u ON u."Id"=r."ReporterId"
     LEFT JOIN "dbo"."v_ReportPriorityLive" p ON p."Id"=r."Id"
     WHERE r."Id"=$1`, [reportId]
  );
  const report = result.rows[0];
  if (!report) throw new ApiError(404, "Report was not found.", "REPORT_NOT_FOUND");
  if (user.role === "REPORTER" && String(report.ReporterId) !== String(user.id)) throw new ApiError(403, "You cannot access this report.", "FORBIDDEN");
  const [images, request, duplicates, history] = await Promise.all([
    query(`SELECT "Id" AS id,"SecureUrl" AS "secureUrl","IsPrimary" AS "isPrimary","Width" AS width,"Height" AS height,"CreatedAt" AS "createdAt" FROM "dbo"."ReportImages" WHERE "ReportId"=$1 ORDER BY "IsPrimary" DESC,"CreatedAt"`, [reportId]),
    query(`SELECT * FROM "dbo"."MaintenanceRequests" WHERE "ReportId"=$1`, [reportId]),
    query(`SELECT * FROM "dbo"."ReportDuplicateCandidates" WHERE "SourceReportId"=$1 ORDER BY "MatchScore" DESC NULLS LAST,"CreatedAt" DESC`, [reportId]),
    query(`SELECT * FROM "dbo"."ReportStatusHistory" WHERE "ReportId"=$1 ORDER BY "CreatedAt" DESC LIMIT 100`, [reportId]),
  ]);
  return { report, images: images.rows, maintenanceRequest: request.rows[0] || null, duplicateCandidates: duplicates.rows, statusHistory: history.rows };
}
