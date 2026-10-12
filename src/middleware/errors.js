import { ApiError } from "../errors.js";
import { mapDatabaseError } from "../database.js";

export function notFound(req, _res, next) {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`, "ROUTE_NOT_FOUND"));
}

export function errorHandler(error, _req, res, _next) {
  const mapped = mapDatabaseError(error);
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
