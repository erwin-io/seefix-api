import { createHash } from "node:crypto";
import { config } from "../config.js";
import { withTransaction, query } from "../database.js";
import {
  uploadBuffer,
  destroyAsset,
  reportImageRecord,
} from "../cloudinary.js";
import { claimUploads, lockUnusedUploads } from "../direct-uploads.js";
import { ApiError } from "../errors.js";
import { createNotification } from "./notifications.js";
import { presentReport } from "./report-presentation.js";
import { assertNoActiveReport } from "./report-active-policy.js";

async function resolveLocation(client, fields) {
  if (!fields.locationId) {
    return {
      locationId: null,
      building: fields.building || null,
      floor: fields.floor || null,
      roomOrArea: fields.roomOrArea || null,
    };
  }

  const result = await client.query(
    `SELECT
       fl."Id",
       fl."Floor",
       fl."RoomOrArea",
       b."Name" AS "BuildingName"
     FROM "dbo"."FacilityLocations" fl
     JOIN "dbo"."Buildings" b ON b."Id"=fl."BuildingId"
     WHERE fl."Id"=$1
       AND fl."IsActive"=TRUE
       AND b."IsActive"=TRUE`,
    [fields.locationId],
  );

  const location = result.rows[0];
  if (!location) {
    throw new ApiError(
      400,
      "locationId does not reference an active facility location.",
      "INVALID_LOCATION",
    );
  }

  return {
    locationId: location.Id,
    building: location.BuildingName,
    floor: location.Floor,
    roomOrArea: location.RoomOrArea,
  };
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
// Errors a concurrent request with the same clientReportId causes once it has committed first.
const RACE_CODES = new Set(["ACTIVE_REPORT_EXISTS", "UPLOAD_ALREADY_USED"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Fingerprint of an offline submission, so a reused clientReportId with different content is refused.
 * Uses per-photo content digests, not Cloudinary public IDs: a legitimate retry may re-upload a photo.
 */
export function clientRequestHash(fields, imageDigests) {
  const text = (value) => (value == null ? null : String(value).trim() || null);
  return sha256(
    JSON.stringify([
      text(fields.description),
      text(fields.notes),
      text(fields.locationId),
      text(fields.building),
      text(fields.floor),
      text(fields.roomOrArea),
      fields.gpsLat ?? null,
      fields.gpsLng ?? null,
      imageDigests,
    ]),
  );
}

function validImageDigests(value, imageCount) {
  const digests = Array.isArray(value) ? value.map((d) => String(d).toLowerCase()) : null;
  if (!digests || digests.length !== imageCount || !digests.every((d) => SHA256_HEX.test(d))) {
    throw new ApiError(
      400,
      "imageDigests must list one SHA-256 hex digest per image, in the same order.",
      "VALIDATION_ERROR",
    );
  }
  return digests;
}

/** The report an earlier attempt with this clientReportId created, or null. 409 if the content differs. */
export async function findClientReport(q, userId, clientReportId, requestHash) {
  const result = await q(
    `SELECT r."Id" AS id, r."ReportNo" AS "reportNo", r."Status" AS status,
            r."AgentStatus" AS "agentStatus", r."CreatedAt" AS "createdAt",
            r."ClientRequestHash" AS "clientRequestHash",
            (SELECT COUNT(*)::int FROM "dbo"."ReportImages" i WHERE i."ReportId"=r."Id") AS "imageCount"
       FROM "dbo"."Reports" r
      WHERE r."ReporterId"=$1 AND r."ClientReportId"=$2`,
    [userId, clientReportId],
  );
  const existing = result.rows[0];
  if (!existing) return null;
  if (existing.clientRequestHash !== requestHash) {
    throw new ApiError(
      409,
      "This clientReportId was already used for a different report.",
      "CLIENT_REPORT_ID_CONFLICT",
      { report: { id: existing.id, reportNo: existing.reportNo } },
    );
  }
  const { clientRequestHash: _hash, ...report } = existing;
  return { ...report, replayed: true };
}

/**
 * Creates a Reporter's report. With `clientReportId` (offline app) the call is idempotent: a retry returns the
 * report the first attempt created (`replayed: true`) without claiming uploads or notifying again.
 */
export async function createReport(user, fields, { files = [], imagePublicIds, clientReportId = null, imageDigests } = {}) {
  if (!clientReportId) return createNewReport(user, fields, { files, imagePublicIds });

  const imageCount = imagePublicIds != null ? (Array.isArray(imagePublicIds) ? imagePublicIds.length : 0) : files.length;
  // Multipart sends the bytes, so the server digests them itself.
  const digests = imagePublicIds != null ? validImageDigests(imageDigests, imageCount) : files.map((f) => sha256(f.buffer));
  const requestHash = clientRequestHash(fields, digests);

  // Before the active-report check and the upload claim: a retry must never be refused by its own report.
  const existing = await findClientReport(query, user.id, clientReportId, requestHash);
  if (existing) return existing;
  try {
    return await createNewReport(user, fields, { files, imagePublicIds, clientReportId, requestHash });
  } catch (error) {
    // A concurrent attempt with the same ID may have committed after the lookup above. Ours then fails on its
    // report, its uploads or the unique index; return that report instead. Anything else is a real conflict.
    const raced = RACE_CODES.has(error?.code) || error?.code === "23505";
    if (raced) {
      const winner = await findClientReport(query, user.id, clientReportId, requestHash);
      if (winner) return winner;
    }
    throw error;
  }
}

async function createNewReport(user, fields, { files = [], imagePublicIds, clientReportId = null, requestHash = null }) {
  // Quick check before Cloudinary uploads. The transactional recheck and
  // database unique index remain authoritative for concurrent requests.
  await assertNoActiveReport(query, user.id);
  // Only files this request uploaded are deleted on failure. Direct uploads stay so the client can retry;
  // unused ones are removed by seefix-worker's cleanup.
  const ownUploads = [];

  try {
    let uploaded;
    if (imagePublicIds != null) {
      uploaded = await claimUploads(user, "report-image", imagePublicIds);
    } else {
      for (const file of files) {
        ownUploads.push(
          await uploadBuffer(file.buffer, {
            folder: config.cloudinaryReportFolder,
            resourceType: "image",
          }),
        );
      }
      uploaded = ownUploads;
    }

    const report = await withTransaction(user.id, async (client) => {
      // Serialize report creation by Reporter across concurrent HTTP workers.
      // This lock is only a performance improvement; the partial unique index
      // protects direct DB writes and any other API deployment too.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1)::bigint)",
        [`seefix:active-report:${user.id}`],
      );
      await assertNoActiveReport(client.query.bind(client), user.id);
      if (imagePublicIds != null) await lockUnusedUploads(client, uploaded.map((u) => u.public_id));
      const location = await resolveLocation(client, fields);

      // The client-ID columns are written only when sent, so legacy clients never depend on the migration.
      const clientColumns = clientReportId ? ',"ClientReportId","ClientRequestHash"' : "";
      const clientValues = clientReportId ? ",$10,$11" : "";
      const inserted = await client.query(
        `INSERT INTO "dbo"."Reports"
           ("ReporterId","Description","Notes","LocationId",
            "Building","Floor","RoomOrArea","GpsLat","GpsLng"${clientColumns})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9${clientValues})
         RETURNING
           "Id" AS id,
           "ReportNo" AS "reportNo",
           "Status" AS status,
           "AgentStatus" AS "agentStatus",
           "CreatedAt" AS "createdAt"`,
        [
          user.id,
          fields.description || null,
          fields.notes || null,
          location.locationId,
          location.building,
          location.floor,
          location.roomOrArea,
          fields.gpsLat ?? null,
          fields.gpsLng ?? null,
          ...(clientReportId ? [clientReportId, requestHash] : []),
        ],
      );

      const row = inserted.rows[0];

      for (let i = 0; i < uploaded.length; i += 1) {
        const image = reportImageRecord(uploaded[i], i === 0);

        await client.query(
          `INSERT INTO "dbo"."ReportImages"
             ("ReportId","CloudinaryAssetId","PublicId","SecureUrl",
              "Version","Format","Width","Height","Bytes","ResourceType","IsPrimary")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            row.id,
            image.cloudinaryAssetId,
            image.publicId,
            image.secureUrl,
            image.version,
            image.format,
            image.width,
            image.height,
            image.bytes,
            image.resourceType,
            image.isPrimary,
          ],
        );
      }

      await createNotification(client, {
        userId: user.id,
        type: "REPORT_SUBMITTED",
        title: "Report submitted",
        message: `Report ${row.reportNo} was submitted and queued for assessment.`,
        entityType: "REPORT",
        entityId: row.id,
        payload: { reportNo: row.reportNo },
        deduplicationKey: `report:${row.id}:submitted`,
        createdAt: row.createdAt,
      });

      return row;
    });

    // Saved as AgentStatus PENDING: the Agent claims it from the database queue (no direct call), and
    // seefix-worker's agent-retry job re-queues failed attempts. The API never depends on the Agent being up.
    return {
      ...report,
      imageCount: uploaded.length,
      replayed: false,
    };
  } catch (error) {
    for (const item of ownUploads) {
      await destroyAsset(item.public_id, item.resource_type || "image");
    }

    throw error;
  }
}

export async function getReportDetail(reportId, user) {
  const result = await query(
    `SELECT
       r.*,
       u."FullName" AS "ReporterName",
       p."LivePriorityScore",
       p."EffectiveCategory",
       p."EffectiveUrgency"
     FROM "dbo"."Reports" r
     JOIN "dbo"."Users" u ON u."Id"=r."ReporterId"
     LEFT JOIN "dbo"."v_ReportPriorityLive" p ON p."Id"=r."Id"
     WHERE r."Id"=$1`,
    [reportId],
  );

  const report = result.rows[0];

  if (!report) {
    throw new ApiError(
      404,
      "Report was not found.",
      "REPORT_NOT_FOUND",
    );
  }

  let allowed = false;

  if (user.role === "REPORTER") {
    allowed =
      String(report.ReporterId) === String(user.id);
  } else if (
    [
      "MAINTENANCE_STAFF",
      "MAINTENANCE_SUPERVISOR",
      "ADMIN",
    ].includes(user.role)
  ) {
    allowed = true;
  } else if (user.role === "PROCUREMENT") {
    const access = await query(
      `SELECT 1
       FROM "dbo"."ProcurementHandoffs" ph
       JOIN "dbo"."MaintenanceRequests" mr
         ON mr."Id"=ph."MaintenanceRequestId"
       WHERE mr."ReportId"=$1
       LIMIT 1`,
      [reportId],
    );
    allowed = access.rowCount > 0;
  } else if (user.role === "WORKER") {
    const access = await query(
      `SELECT 1
       FROM "dbo"."WorkOrders" wo
       WHERE wo."ReportId"=$1
         AND wo."ResponsibleLeadUserId"=$2
       LIMIT 1`,
      [reportId, user.id],
    );
    allowed = access.rowCount > 0;
  }

  if (!allowed) {
    throw new ApiError(
      403,
      "You cannot access this report.",
      "FORBIDDEN",
    );
  }

  const [
    images,
    request,
    review,
    handoff,
    workOrder,
    duplicates,
    timeline,
  ] = await Promise.all([
    query(
      `SELECT
         "Id" AS id,
         "SecureUrl" AS "secureUrl",
         "IsPrimary" AS "isPrimary",
         "Width" AS width,
         "Height" AS height,
         "CreatedAt" AS "createdAt"
       FROM "dbo"."ReportImages"
       WHERE "ReportId"=$1
       ORDER BY "IsPrimary" DESC,"CreatedAt"`,
      [reportId],
    ),

    query(
      `SELECT *
       FROM "dbo"."MaintenanceRequests"
       WHERE "ReportId"=$1`,
      [reportId],
    ),

    query(
      `SELECT *
       FROM "dbo"."MaintenanceReviews"
       WHERE "ReportId"=$1`,
      [reportId],
    ),

    query(
      `SELECT ph.*
       FROM "dbo"."ProcurementHandoffs" ph
       JOIN "dbo"."MaintenanceRequests" mr
         ON mr."Id"=ph."MaintenanceRequestId"
       WHERE mr."ReportId"=$1`,
      [reportId],
    ),

    query(
      `SELECT *
       FROM "dbo"."WorkOrders"
       WHERE "ReportId"=$1`,
      [reportId],
    ),

    query(
      `SELECT *
       FROM "dbo"."ReportDuplicateCandidates"
       WHERE "SourceReportId"=$1
       ORDER BY "MatchScore" DESC NULLS LAST,"CreatedAt" DESC`,
      [reportId],
    ),

    query(
      `SELECT *
       FROM "dbo"."v_ReportTimeline"
       WHERE "ReportId"=$1
       ORDER BY "CreatedAt" DESC
       LIMIT 100`,
      [reportId],
    ),
  ]);

  // The server is authoritative; the mobile app uses this only to show/hide
  // its cancel button and still handles 409 if a reviewer wins a race.
  const canCancel = user.role === "REPORTER" &&
    ["SUBMITTED", "PENDING_REVIEW"].includes(report.Status) &&
    !review.rows.length && !workOrder.rows.length && !handoff.rows.length &&
    !request.rows.some((item) => item.Status !== "DRAFT");

  // Preserve stored priority/review values; only normalize the API presentation.
  const presentedReport = presentReport(report, { reporter: user.role === "REPORTER" });
  presentedReport.canCancel = canCancel;
  const presentedReview = review.rows[0]
    ? presentReport({ ...review.rows[0], AgentStatus: report.AgentStatus,
        ScopeDecision: report.ScopeDecision, ScopeShouldAnalyze: report.ScopeShouldAnalyze })
    : null;
  if (presentedReview) {
    delete presentedReview.AgentStatus;
    delete presentedReview.ScopeDecision;
    delete presentedReview.ScopeShouldAnalyze;
    delete presentedReview.screening;
  }

  return {
    report: presentedReport,
    images: images.rows,
    maintenanceRequest: request.rows[0] || null,
    maintenanceReview: presentedReview,
    procurementHandoff: handoff.rows[0] || null,
    workOrder: workOrder.rows[0] || null,
    duplicateCandidates: duplicates.rows,
    statusHistory: timeline.rows,
  };
}
