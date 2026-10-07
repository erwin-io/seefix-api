import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { query } from "../database.js";
import { ApiError } from "../errors.js";

export function signAccessToken(user) {
  return jwt.sign({ sub: user.id, role: user.role, email: user.email }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
}

export async function requireAuth(req, _res, next) {
  try {
    const header = req.get("authorization") || "";
    const [scheme, token] = header.split(/\s+/, 2);
    if (scheme?.toLowerCase() !== "bearer" || !token) throw new ApiError(401, "Authentication required.", "AUTH_REQUIRED");
    let payload;
    try { payload = jwt.verify(token, config.jwtSecret); }
    catch { throw new ApiError(401, "The access token is invalid or expired.", "INVALID_TOKEN"); }
    const result = await query(
      `SELECT "Id" AS id, "FullName" AS "fullName", "Email" AS email, "Role" AS role,
              "DepartmentOrTrade" AS "departmentOrTrade", "Phone" AS phone, "IsActive" AS "isActive"
       FROM "dbo"."Users" WHERE "Id"=$1`, [payload.sub]
    );
    const user = result.rows[0];
    if (!user?.isActive) throw new ApiError(401, "This user account is inactive.", "INACTIVE_ACCOUNT");
    req.user = user;
    next();
  } catch (error) { next(error); }
}

export function requireRoles(...allowedRoles) {
  const allowed = new Set(allowedRoles);
  return (req, _res, next) => {
    if (!req.user || !allowed.has(req.user.role)) return next(new ApiError(403, "You do not have permission for this operation.", "FORBIDDEN"));
    next();
  };
}
