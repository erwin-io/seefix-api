import multer from "multer";
import { config } from "../config.js";
import { ApiError } from "../errors.js";
import { mapDatabaseError } from "../database.js";

export function notFound(req, _res, next) {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`, "ROUTE_NOT_FOUND"));
}

export function errorHandler(error, _req, res, _next) {
  let mapped = mapDatabaseError(error);
  if (mapped instanceof multer.MulterError) {
    mapped = mapped.code === "LIMIT_FILE_SIZE"
      ? new ApiError(413, `Uploaded file exceeds the ${config.maxUploadMb} MB limit.`, "FILE_TOO_LARGE")
      : new ApiError(400, mapped.message, "UPLOAD_ERROR");
  }
  const status = mapped instanceof ApiError ? mapped.status : 500;
  if (status >= 500) console.error("[API ERROR]", mapped);
  res.status(status).json({
    error: {
      code: mapped instanceof ApiError ? mapped.code : "INTERNAL_ERROR",
      message: mapped instanceof ApiError ? mapped.message : "Internal server error.",
      ...(mapped instanceof ApiError && mapped.details ? { details: mapped.details } : {}),
    },
  });
}
