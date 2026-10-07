import { v2 as cloudinary } from "cloudinary";
import { config } from "./config.js";
import { ApiError } from "./errors.js";

let configured = false;
function ensureConfigured() {
  if (configured) return;
  if (!config.cloudinaryCloudName || !config.cloudinaryApiKey || !config.cloudinaryApiSecret) {
    throw new ApiError(500, "Cloudinary configuration is required for evidence uploads.", "CLOUDINARY_NOT_CONFIGURED");
  }
  cloudinary.config({ cloud_name: config.cloudinaryCloudName, api_key: config.cloudinaryApiKey, api_secret: config.cloudinaryApiSecret, secure: true });
  configured = true;
}

export function uploadBuffer(buffer, { folder, resourceType = "image", publicId } = {}) {
  ensureConfigured();
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: resourceType, ...(publicId ? { public_id: publicId } : {}) },
      (error, result) => error ? reject(error) : resolve(result),
    );
    stream.end(buffer);
  });
}

export async function destroyAsset(publicId, resourceType = "image") {
  try {
    ensureConfigured();
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType, invalidate: true });
  } catch (error) { console.warn("[CLOUDINARY] Cleanup failed:", error.message); }
}

export function reportImageRecord(result, isPrimary = false) {
  return {
    cloudinaryAssetId: result.asset_id || null,
    publicId: result.public_id,
    secureUrl: result.secure_url,
    version: result.version || null,
    format: result.format || null,
    width: result.width || null,
    height: result.height || null,
    bytes: result.bytes || null,
    resourceType: result.resource_type || "image",
    isPrimary,
  };
}
