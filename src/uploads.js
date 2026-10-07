import multer from "multer";
import { config } from "./config.js";
import { ApiError } from "./errors.js";

const imageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
export const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: config.maxReportImages },
});

export function requireImageFiles(files, { min = 1 } = {}) {
  const list = Array.isArray(files) ? files : files ? [files] : [];
  if (list.length < min) throw new ApiError(400, "At least one image is required.", "IMAGE_REQUIRED");
  for (const file of list) {
    if (!imageTypes.has(file.mimetype)) throw new ApiError(415, "Images must be JPEG, PNG, or WebP.", "UNSUPPORTED_IMAGE_TYPE");
  }
  return list;
}
