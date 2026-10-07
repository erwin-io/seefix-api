export class ApiError extends Error {
  constructor(status, message, code = "API_ERROR", details) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function assert(condition, status, message, code = "API_ERROR") {
  if (!condition) throw new ApiError(status, message, code);
}
