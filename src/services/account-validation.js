import { ApiError } from '../errors.js';

export function requireEmail(raw) {
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(400, 'A valid email address is required.', 'INVALID_EMAIL');
  }
  return email;
}
export function optionalUsername(raw) {
  if (raw === undefined) return undefined;
  if (raw === null || String(raw).trim() === '') return null;
  const username = String(raw).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,29}$/.test(username)) {
    throw new ApiError(400, 'Username must be 3–30 characters using letters, digits, period, underscore, or hyphen.', 'INVALID_USERNAME');
  }
  return username;
}
export function requirePassword(raw) {
  if (typeof raw !== 'string' || raw.length < 8 || Buffer.byteLength(raw, 'utf8') > 72) {
    throw new ApiError(400, 'Password must be at least 8 characters and at most 72 UTF-8 bytes.', 'INVALID_PASSWORD');
  }
  return raw;
}
export function optionalText(raw, max, label) {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  if (typeof raw !== 'string' || raw.trim().length > max) {
    throw new ApiError(400, `${label} must be at most ${max} characters.`, 'VALIDATION_ERROR');
  }
  return raw.trim() || null;
}
export function requireOtp(raw) {
  const code = String(raw ?? '').trim();
  if (!/^\d{6}$/.test(code)) throw new ApiError(400, 'Enter the six-digit verification code.', 'INVALID_CODE_FORMAT');
  return code;
}
export function publicUser(row) {
  if (!row) return null;
  const at = row.EmailVerifiedAt ?? row.emailVerifiedAt;
  const required = row.EmailVerificationRequired ?? row.emailVerificationRequired ?? false;
  return {
    id: row.Id ?? row.id,
    institutionalId: row.InstitutionalId ?? row.institutionalId ?? null,
    fullName: row.FullName ?? row.fullName,
    username: row.Username ?? row.username ?? null,
    email: row.Email ?? row.email,
    role: row.Role ?? row.role,
    jobTitle: row.JobTitle ?? row.jobTitle ?? null,
    departmentOrTrade: row.DepartmentOrTrade ?? row.departmentOrTrade ?? null,
    phone: row.Phone ?? row.phone ?? null,
    isActive: row.IsActive ?? row.isActive ?? true,
    emailVerified: Boolean(at),
    emailVerificationRequired: Boolean(required),
  };
}
