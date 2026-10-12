import { v2 as cloudinary } from "cloudinary";
import { config } from "./config.js";
import { ApiError } from "./errors.js";

let configured = false;
export function ensureCloudinary() {
  if (configured) return;
  if (!config.cloudinaryCloudName || !config.cloudinaryApiKey || !config.cloudinaryApiSecret) {
    throw new ApiError(500, "Cloudinary configuration is required for evidence uploads.", "CLOUDINARY_NOT_CONFIGURED");
  }
  cloudinary.config({ cloud_name: config.cloudinaryCloudName, api_key: config.cloudinaryApiKey, api_secret: config.cloudinaryApiSecret, secure: true });
  configured = true;
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
