import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query } from '../database.js';
import { ApiError } from '../errors.js';

export function signAccessToken(user, credentialsVersion = 0) {
  return jwt.sign(
    { sub: user.id, role: user.role, email: user.email, tv: Number(credentialsVersion || 0) },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn },
  );
}

export async function requireAuth(req, _res, next) {
  try {
    const [scheme, token] = (req.get('authorization') || '').split(/\s+/, 2);
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new ApiError(401, 'Authentication required.', 'AUTH_REQUIRED');
    }
    let payload;
    try { payload = jwt.verify(token, config.jwtSecret); }
    catch { throw new ApiError(401, 'The access token is invalid or expired.', 'INVALID_TOKEN'); }
    const r = await query(
      `SELECT "Id" AS id,"InstitutionalId" AS "institutionalId",
       "FullName" AS "fullName","Username" AS username,"Email" AS email,
       "Role" AS role,"JobTitle" AS "jobTitle","DepartmentOrTrade" AS "departmentOrTrade",
       "Phone" AS phone,"IsActive" AS "isActive","EmailVerifiedAt" AS "emailVerifiedAt",
       "EmailVerificationRequired" AS "emailVerificationRequired",
       "CredentialsVersion" AS "credentialsVersion"
       FROM "dbo"."Users" WHERE "Id"=$1`, [payload.sub],
    );
    const user = r.rows[0];
    if (!user?.isActive) throw new ApiError(401, 'User account is inactive.', 'INACTIVE_ACCOUNT');
    // Version zero preserves already-issued JWTs from the previous API version.
    if (Number(payload.tv ?? 0) !== Number(user.credentialsVersion)) {
      throw new ApiError(401, 'Your session has expired after an account security change. Please sign in again.', 'SESSION_REVOKED');
    }
    if (user.role === 'REPORTER' && user.emailVerificationRequired && !user.emailVerifiedAt) {
      throw new ApiError(403, 'Please verify your email before continuing.', 'EMAIL_VERIFICATION_REQUIRED');
    }
    req.user = user;
    next();
  } catch (error) { next(error); }
}

export function requireRoles(...roles) {
  const allowed = new Set(roles);
  return (req, _res, next) => {
    if (!req.user || !allowed.has(req.user.role)) {
      return next(new ApiError(403, 'You do not have permission for this operation.', 'FORBIDDEN'));
    }
    next();
  };
}
