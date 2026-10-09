import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query, withTransaction } from '../database.js';
import { config } from '../config.js';
import { ApiError } from '../errors.js';
import { requireAuth, signAccessToken } from '../middleware/auth.js';
import { requireEmail, optionalUsername, requirePassword, optionalText, requireOtp, publicUser } from '../services/account-validation.js';
import { issueChallenge, consumeChallenge, deliverChallenge } from '../services/account-challenges.js';
import { auditAccount } from '../services/account-audit.js';

const router = Router();
const RESET_RESPONSE = { message: 'If the account exists, a password-reset code has been sent to its email address.' };
const VERIFICATION_RESPONSE = { message: 'If an eligible account exists, an email verification code has been sent.' };

async function getLockedUser(client, id) {
  const result = await client.query('SELECT * FROM "dbo"."Users" WHERE "Id"=$1 FOR UPDATE', [id]);
  if (!result.rows[0] || !result.rows[0].IsActive) throw new ApiError(404, 'Account not found or inactive.', 'ACCOUNT_NOT_FOUND');
  return result.rows[0];
}
async function confirmPassword(user, password) {
  if (typeof password !== 'string' || !(await bcrypt.compare(password, user.PasswordHash))) {
    throw new ApiError(401, 'Current password is incorrect.', 'CURRENT_PASSWORD_INCORRECT');
  }
}
function invalidCodeResult(result) {
  if (!result.ok) throw new ApiError(400, 'Invalid verification code. Check it and try again.', 'OTP_INVALID');
}

// Public Reporter registration: no access token until the email is verified.
router.post('/register', async (req, res, next) => {
  try {
    const fullName = optionalText(req.body?.fullName, 200, 'Full name');
    if (!fullName || fullName.length < 2) throw new ApiError(400, 'Full name is required.', 'VALIDATION_ERROR');
    const email = requireEmail(req.body?.email);
    const password = requirePassword(req.body?.password);
    const username = optionalUsername(req.body?.username) ?? null;
    const phone = optionalText(req.body?.phone, 50, 'Phone');
    const hash = await bcrypt.hash(password, config.bcryptRounds);
    const created = await withTransaction(null, async client => {
      const r = await client.query(
        `INSERT INTO "dbo"."Users"
          ("InstitutionalId","FullName","Username","Email","PasswordHash","Role","Phone","EmailVerificationRequired")
         VALUES ($1,$2,$3,$4,$5,'REPORTER',$6,TRUE) RETURNING *`,
        [optionalText(req.body?.institutionalId, 100, 'Institutional ID'), fullName, username, email, hash, phone],
      );
      const user = r.rows[0];
      const challenge = await issueChallenge(client, { userId: user.Id, purpose: 'EMAIL_VERIFY', email });
      await auditAccount(client, user.Id, 'ACCOUNT_REGISTERED');
      return { user, challenge };
    });
    await deliverChallenge(created.challenge);
    res.status(201).json({
      user: publicUser(created.user),
      emailVerificationRequired: true,
      message: 'Account created. Check your email for the six-digit verification code.',
    });
  } catch (err) { next(err); }
});

router.post('/login', async (req, res, next) => {
  try {
    const identifier = String(req.body?.identifier ?? req.body?.email ?? req.body?.username ?? '').trim().toLowerCase();
    const password = req.body?.password;
    if (!identifier || typeof password !== 'string') throw new ApiError(400, 'Email/username and password are required.', 'VALIDATION_ERROR');
    const r = await query(
      `SELECT * FROM "dbo"."Users"
       WHERE LOWER("Email")=$1 OR LOWER("Username")=$1 LIMIT 1`, [identifier],
    );
    const user = r.rows[0];
    if (!user?.IsActive || !(await bcrypt.compare(password, user.PasswordHash))) {
      throw new ApiError(401, 'Invalid email/username or password.', 'INVALID_CREDENTIALS');
    }
    if (user.Role === 'REPORTER' && user.EmailVerificationRequired && !user.EmailVerifiedAt) {
      throw new ApiError(403, 'Please verify your email before signing in.', 'EMAIL_VERIFICATION_REQUIRED');
    }
    await withTransaction(user.Id, client => client.query(
      'UPDATE "dbo"."Users" SET "LastLoginAt"=NOW() WHERE "Id"=$1', [user.Id],
    ));
    res.json({ user: publicUser(user), accessToken: signAccessToken(publicUser(user), user.CredentialsVersion) });
  } catch (err) { next(err); }
});

// Verification is public so new Reporters can verify before their first login.
router.post('/verify-email', async (req, res, next) => {
  try {
    const email = requireEmail(req.body?.email);
    const code = requireOtp(req.body?.code);
    const result = await withTransaction(null, async client => {
      const found = await client.query('SELECT * FROM "dbo"."Users" WHERE LOWER("Email")=$1 FOR UPDATE', [email]);
      const user = found.rows[0];
      if (!user?.IsActive || user.Role !== 'REPORTER') throw new ApiError(400, 'Verification request is invalid.', 'VERIFICATION_INVALID');
      if (user.EmailVerifiedAt) throw new ApiError(400, 'Verification request is invalid.', 'VERIFICATION_INVALID');
      const consumed = await consumeChallenge(client, { userId: user.Id, purpose: 'EMAIL_VERIFY', email, code });
      if (!consumed.ok) return { ok: false };
      await client.query(
        `UPDATE "dbo"."Users" SET "EmailVerifiedAt"=NOW(),"EmailVerificationRequired"=TRUE WHERE "Id"=$1`, [user.Id],
      );
      await auditAccount(client, user.Id, 'EMAIL_VERIFIED');
      return { ok: true };
    });
    invalidCodeResult(result);
    res.json({ verified: true, message: 'Email verified. You can now sign in.' });
  } catch (err) { next(err); }
});

router.post('/resend-verification', async (req, res, next) => {
  try {
    const email = requireEmail(req.body?.email);
    const challenge = await withTransaction(null, async client => {
      const result = await client.query('SELECT * FROM "dbo"."Users" WHERE LOWER("Email")=$1 FOR UPDATE', [email]);
      const user = result.rows[0];
      if (!user?.IsActive || user.Role !== 'REPORTER' || user.EmailVerifiedAt) return null;
      return issueChallenge(client, { userId: user.Id, purpose: 'EMAIL_VERIFY', email });
    });
    if (challenge) await deliverChallenge(challenge);
    res.json(VERIFICATION_RESPONSE);
  } catch (err) {
    if (err?.code === 'OTP_COOLDOWN' || err?.code === 'OTP_RATE_LIMIT') return res.json(VERIFICATION_RESPONSE);
    next(err);
  }
});

router.post('/forgot-password', async (req, res, next) => {
  try {
    const email = requireEmail(req.body?.email);
    const challenge = await withTransaction(null, async client => {
      const found = await client.query('SELECT * FROM "dbo"."Users" WHERE LOWER("Email")=$1 FOR UPDATE', [email]);
      const user = found.rows[0];
      if (!user?.IsActive) return null;
      return issueChallenge(client, { userId: user.Id, purpose: 'PASSWORD_RESET', email });
    });
    // Do not disclose whether the account exists. Cooldown failures are reported
    // generically for the same reason. Never log a reset code.
    if (challenge) await deliverChallenge(challenge);
    res.json(RESET_RESPONSE);
  } catch (err) {
    if (err?.code === 'OTP_COOLDOWN' || err?.code === 'OTP_RATE_LIMIT') return res.json(RESET_RESPONSE);
    next(err);
  }
});

router.post('/reset-password', async (req, res, next) => {
  try {
    const email = requireEmail(req.body?.email);
    const code = requireOtp(req.body?.code);
    const newPassword = requirePassword(req.body?.newPassword);
    const hash = await bcrypt.hash(newPassword, config.bcryptRounds);
    const result = await withTransaction(null, async client => {
      const found = await client.query('SELECT * FROM "dbo"."Users" WHERE LOWER("Email")=$1 FOR UPDATE', [email]);
      const user = found.rows[0];
      if (!user?.IsActive) throw new ApiError(400, 'Invalid or expired reset request.', 'RESET_INVALID');
      const consumed = await consumeChallenge(client, { userId: user.Id, purpose: 'PASSWORD_RESET', email, code });
      if (!consumed.ok) return { ok: false };
      await client.query(
        `UPDATE "dbo"."Users" SET "PasswordHash"=$2,"CredentialsVersion"="CredentialsVersion"+1 WHERE "Id"=$1`,
        [user.Id, hash],
      );
      await auditAccount(client, user.Id, 'PASSWORD_RESET');
      return { ok: true };
    });
    invalidCodeResult(result);
    res.json({ message: 'Password updated. Please sign in with your new password.' });
  } catch (err) { next(err); }
});

router.get('/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));
router.patch('/me', requireAuth, async (req, res, next) => {
  try {
    const fields = [
      ['fullName', 'FullName', 200],
      ['phone', 'Phone', 50],
      ['jobTitle', 'JobTitle', 150],
      ['departmentOrTrade', 'DepartmentOrTrade', 150],
    ];
    const assignments = [];
    const values = [];
    for (const [key, column, max] of fields) {
      if (!Object.prototype.hasOwnProperty.call(req.body ?? {}, key)) continue;
      if (req.user.role === 'REPORTER' && ['jobTitle','departmentOrTrade'].includes(key)) {
        throw new ApiError(403, 'This field is managed by the organization.', 'FIELD_NOT_EDITABLE');
      }
      const value = optionalText(req.body[key], max, key);
      if (key === 'fullName' && (!value || value.length < 2)) throw new ApiError(400, 'Full name is required.', 'VALIDATION_ERROR');
      values.push(value);
      assignments.push(`"${column}"=$${values.length}`);
    }
    if (!assignments.length) throw new ApiError(400, 'No editable profile fields supplied.', 'VALIDATION_ERROR');
    const user = await withTransaction(req.user.id, async client => {
      values.push(req.user.id);
      const r = await client.query(
        `UPDATE "dbo"."Users" SET ${assignments.join(',')},"UpdatedAt"=NOW() WHERE "Id"=$${values.length} RETURNING *`,
        values,
      );
      await auditAccount(client, req.user.id, 'PROFILE_UPDATED', { fields: fields.map(([key])=>key).filter(key=>Object.hasOwn(req.body,key)) });
      return r.rows[0];
    });
    res.json({ user: publicUser(user), message: 'Profile updated.' });
  } catch (err) { next(err); }
});

router.patch('/me/username', requireAuth, async (req, res, next) => {
  try {
    const username = optionalUsername(req.body?.username);
    if (!username) throw new ApiError(400, 'Username is required.', 'INVALID_USERNAME');
    const user = await withTransaction(req.user.id, async client => {
      const user = await getLockedUser(client, req.user.id);
      await confirmPassword(user, req.body?.currentPassword);
      const r = await client.query('UPDATE "dbo"."Users" SET "Username"=$2 WHERE "Id"=$1 RETURNING *', [user.Id, username]);
      await auditAccount(client, user.Id, 'USERNAME_CHANGED');
      return r.rows[0];
    });
    res.json({ user: publicUser(user), message: 'Username changed.' });
  } catch (err) { next(err); }
});

router.post('/me/change-password', requireAuth, async (req, res, next) => {
  try {
    const newPassword = requirePassword(req.body?.newPassword);
    const hash = await bcrypt.hash(newPassword, config.bcryptRounds);
    await withTransaction(req.user.id, async client => {
      const user = await getLockedUser(client, req.user.id);
      await confirmPassword(user, req.body?.currentPassword);
      if (await bcrypt.compare(newPassword, user.PasswordHash)) throw new ApiError(400, 'New password must be different.', 'PASSWORD_UNCHANGED');
      await client.query(
        `UPDATE "dbo"."Users" SET "PasswordHash"=$2,"CredentialsVersion"="CredentialsVersion"+1 WHERE "Id"=$1`,
        [user.Id, hash],
      );
      await auditAccount(client, user.Id, 'PASSWORD_CHANGED');
    });
    res.json({ message: 'Password changed. Please sign in again on all devices.' });
  } catch (err) { next(err); }
});

router.post('/me/change-email', requireAuth, async (req, res, next) => {
  try {
    const newEmail = requireEmail(req.body?.newEmail);
    const outcome = await withTransaction(req.user.id, async client => {
      const user = await getLockedUser(client, req.user.id);
      await confirmPassword(user, req.body?.currentPassword);
      if (user.Email.toLowerCase() === newEmail) throw new ApiError(400, 'New email must be different.', 'EMAIL_UNCHANGED');
      // Check ownership before issuing a code. DB unique index remains the final guard.
      const conflict = await client.query('SELECT 1 FROM "dbo"."Users" WHERE LOWER("Email")=$1 AND "Id"<>$2', [newEmail,user.Id]);
      if (conflict.rowCount) throw new ApiError(409, 'Email is already in use.', 'EMAIL_IN_USE');
      if (user.Role === 'REPORTER') {
        const challenge = await issueChallenge(client, { userId: user.Id, purpose: 'EMAIL_CHANGE', email: newEmail });
        return { needsVerification: true, challenge };
      }
      const r = await client.query(
        `UPDATE "dbo"."Users" SET "Email"=$2,"EmailVerifiedAt"=NULL,
         "EmailVerificationRequired"=FALSE,"CredentialsVersion"="CredentialsVersion"+1 WHERE "Id"=$1 RETURNING *`,
        [user.Id, newEmail],
      );
      await auditAccount(client, user.Id, 'EMAIL_CHANGED_DIRECT', { role: user.Role });
      return { needsVerification: false, user: r.rows[0] };
    });
    if (outcome.needsVerification) {
      await deliverChallenge(outcome.challenge);
      return res.json({ pendingEmail: newEmail, verificationRequired: true, message: 'A verification code was sent to your new email. Your existing email remains active until confirmation.' });
    }
    res.json({ user: publicUser(outcome.user), verificationRequired: false, message: 'Email changed. Please sign in with the new email.' });
  } catch (err) { next(err); }
});

router.post('/me/change-email/confirm', requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== 'REPORTER') throw new ApiError(403, 'Email confirmation applies only to Reporters.', 'FORBIDDEN');
    const email = requireEmail(req.body?.newEmail);
    const code = requireOtp(req.body?.code);
    const result = await withTransaction(req.user.id, async client => {
      const user = await getLockedUser(client, req.user.id);
      const consumed = await consumeChallenge(client, { userId: user.Id, purpose: 'EMAIL_CHANGE', email, code });
      if (!consumed.ok) return { ok: false };
      const check = await client.query('SELECT 1 FROM "dbo"."Users" WHERE LOWER("Email")=$1 AND "Id"<>$2', [email,user.Id]);
      if (check.rowCount) throw new ApiError(409, 'This email is now in use.', 'EMAIL_IN_USE');
      const r = await client.query(
        `UPDATE "dbo"."Users" SET "Email"=$2,"EmailVerifiedAt"=NOW(),
         "EmailVerificationRequired"=TRUE,"CredentialsVersion"="CredentialsVersion"+1 WHERE "Id"=$1 RETURNING *`,
        [user.Id, email],
      );
      await auditAccount(client, user.Id, 'EMAIL_CHANGED_VERIFIED');
      return { ok: true, user: r.rows[0] };
    });
    invalidCodeResult(result);
    res.json({ user: publicUser(result.user), message: 'New email verified. Please sign in again.' });
  } catch (err) { next(err); }
});

export default router;
