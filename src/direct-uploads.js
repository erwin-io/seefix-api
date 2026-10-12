/**
 * Direct-to-Cloudinary uploads (issue #12): clients upload files straight to Cloudinary with a short-lived
 * signature from the API, then submit only the public IDs. Request bodies stay tiny, so the platform body limit
 * (Vercel: 4.5 MB per request) no longer applies, and file bytes never pass through the API.
 *
 * - signUpload(): checks the user may upload for the purpose, then signs the upload parameters. The signature
 *   fixes the folder, allowed formats and tags (pending + owner + purpose), so the client can't change them.
 * - claimUploads(): before an upload is used, looks it up in Cloudinary and checks owner, purpose, type, size
 *   (images 10 MB, documents 15 MB) and that it isn't already attached to a record. Returns Cloudinary results in the same
 *   shape as uploader responses, so the existing persistence code is unchanged.
 * - lockUnusedUploads(): inside the transaction that saves the uploads, locks each public ID and re-checks it is
 *   unused, so two concurrent requests can't attach the same upload to two records.
 * - Unclaimed uploads keep the pending tag; seefix-worker's cleanup removes them later.
 */
import { v2 as cloudinary } from "cloudinary";
import { config } from "./config.js";
import { ensureCloudinary } from "./cloudinary.js";
import { query } from "./database.js";
import { ApiError } from "./errors.js";

export const PENDING_TAG = "seefix-pending";
export const ownerTag = (userId) => `seefix-owner-${userId}`;
export const purposeTag = (purpose) => `seefix-purpose-${purpose}`;

const IMAGE_FORMATS = ["jpg", "png", "webp"];
// Clients enforce the same limits before uploading; these are the server-side check.
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;
const WORK_ROLES = ["MAINTENANCE_STAFF", "MAINTENANCE_SUPERVISOR", "WORKER", "ADMIN"];

export const PURPOSES = {
  "report-image": { roles: null, resourceType: "image", formats: IMAGE_FORMATS, maxBytes: MAX_IMAGE_BYTES, folder: () => config.cloudinaryReportFolder },
  "completion-image": { roles: WORK_ROLES, resourceType: "image", formats: IMAGE_FORMATS, maxBytes: MAX_IMAGE_BYTES, folder: () => config.cloudinaryWorkOrderFolder },
  // Documents may be PDFs, office files or images; Cloudinary stores them as "image" or "raw".
  "procurement-document": { roles: ["PROCUREMENT", "ADMIN"], resourceType: "auto", formats: null, maxBytes: MAX_DOCUMENT_BYTES, folder: () => config.cloudinaryDocumentFolder },
};

const SIGNATURE_LIFETIME_SECONDS = 3600; // Cloudinary accepts a signed timestamp for one hour

function purposeFor(user, purpose) {
  const p = PURPOSES[purpose];
  if (!p) throw new ApiError(400, `purpose must be one of: ${Object.keys(PURPOSES).join(", ")}.`, "INVALID_UPLOAD_PURPOSE");
  if (p.roles && !p.roles.includes(user.role)) throw new ApiError(403, "You cannot upload files for this purpose.", "FORBIDDEN");
  return p;
}

const defaultCredentials = () => {
  ensureCloudinary();
  return { cloudName: config.cloudinaryCloudName, apiKey: config.cloudinaryApiKey, apiSecret: config.cloudinaryApiSecret };
};

/** Signed parameters for one direct upload (valid for every file uploaded within the hour). */
export function signUpload(user, purpose, { credentials = defaultCredentials(), now = Date.now } = {}) {
  const p = purposeFor(user, purpose);
  const timestamp = Math.floor(now() / 1000);
  const params = {
    timestamp,
    folder: p.folder(),
    tags: [PENDING_TAG, ownerTag(user.id), purposeTag(purpose)].join(","),
    ...(p.formats ? { allowed_formats: p.formats.join(",") } : {}),
  };
  return {
    uploadUrl: `https://api.cloudinary.com/v1_1/${credentials.cloudName}/${p.resourceType}/upload`,
    fields: { ...params, api_key: credentials.apiKey, signature: cloudinary.utils.api_sign_request(params, credentials.apiSecret) },
    maxBytes: p.maxBytes,
    allowedFormats: p.formats,
    expiresAt: new Date((timestamp + SIGNATURE_LIFETIME_SECONDS) * 1000).toISOString(),
  };
}

async function fetchCloudinaryResource(publicId, resourceType) {
  ensureCloudinary();
  try {
    return await cloudinary.api.resource(publicId, { resource_type: resourceType });
  } catch (error) {
    if (error?.error?.http_code === 404 || error?.http_code === 404) return null;
    throw error;
  }
}

async function alreadyUsed(q, publicId) {
  const r = await q(
    `SELECT 1 FROM "dbo"."ReportImages" WHERE "PublicId"=$1
     UNION ALL SELECT 1 FROM "dbo"."WorkOrderImages" WHERE "PublicId"=$1
     UNION ALL SELECT 1 FROM "dbo"."ProcurementDocuments" WHERE "PublicId"=$1 LIMIT 1`,
    [publicId],
  );
  return r.rowCount > 0;
}

/**
 * Verify uploads before attaching them to a record. `refs`: public IDs (strings) or { publicId, resourceType }.
 * Throws ApiError on the first problem; returns Cloudinary results in the order given.
 */
export async function claimUploads(user, purpose, refs, { max = config.maxReportImages, fetchResource = fetchCloudinaryResource, q = query } = {}) {
  const p = purposeFor(user, purpose);
  const list = (Array.isArray(refs) ? refs : [refs]).filter((r) => r != null && r !== "");
  if (!list.length) throw new ApiError(400, "At least one uploaded file is required.", "UPLOAD_REQUIRED");
  if (list.length > max) throw new ApiError(400, `At most ${max} files are allowed.`, "TOO_MANY_FILES");

  const items = list.map((r) => (typeof r === "string" ? { publicId: r } : { publicId: r.publicId, resourceType: r.resourceType }));
  const ids = items.map((i) => String(i.publicId || "").trim());
  if (ids.some((id) => !id || id.length > 255)) throw new ApiError(400, "Each upload needs a valid publicId.", "VALIDATION_ERROR");
  if (new Set(ids).size !== ids.length) throw new ApiError(400, "The same upload was listed twice.", "DUPLICATE_UPLOAD");

  const results = [];
  for (const [i, item] of items.entries()) {
    const publicId = ids[i];
    const resourceType = p.resourceType === "auto" ? item.resourceType : p.resourceType;
    if (!["image", "raw"].includes(resourceType)) throw new ApiError(400, "resourceType must be image or raw.", "VALIDATION_ERROR");

    const resource = await fetchResource(publicId, resourceType);
    if (!resource) throw new ApiError(400, `Upload ${publicId} was not found.`, "UPLOAD_NOT_FOUND");
    const tags = resource.tags || [];
    // Same response for "someone else's" and "wrong purpose": don't reveal which uploads exist.
    if (!tags.includes(ownerTag(user.id)) || !tags.includes(purposeTag(purpose))) {
      throw new ApiError(403, `Upload ${publicId} can't be used here.`, "UPLOAD_NOT_ALLOWED");
    }
    if (p.formats && (resource.resource_type !== "image" || !p.formats.includes(String(resource.format).toLowerCase()))) {
      throw new ApiError(415, "Images must be JPEG, PNG, or WebP.", "UNSUPPORTED_IMAGE_TYPE");
    }
    if (!(Number(resource.bytes) > 0) || Number(resource.bytes) > p.maxBytes) {
      throw new ApiError(413, `Upload ${publicId} exceeds the ${p.maxBytes / 1024 / 1024} MB limit.`, "FILE_TOO_LARGE");
    }
    if (await alreadyUsed(q, publicId)) throw new ApiError(409, `Upload ${publicId} is already attached to a record.`, "UPLOAD_ALREADY_USED");
    results.push(resource);
  }
  return results;
}

/**
 * Call inside the transaction that saves the uploads, before inserting them. Takes a transaction-scoped lock per
 * public ID (sorted, so overlapping concurrent claims can't deadlock), then re-checks every ID is unused. A concurrent
 * request for the same ID waits on the lock until this transaction ends, then sees the committed row and gets 409.
 */
export async function lockUnusedUploads(client, publicIds) {
  const ids = [...new Set(publicIds)].sort();
  for (const id of ids) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`seefix:upload:${id}`]);
  }
  const q = client.query.bind(client);
  for (const id of ids) {
    if (await alreadyUsed(q, id)) throw new ApiError(409, `Upload ${id} is already attached to a record.`, "UPLOAD_ALREADY_USED");
  }
}
