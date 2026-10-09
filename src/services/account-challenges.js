import { config } from '../config.js';
import { ApiError } from '../errors.js';
import { requireOtp } from './account-validation.js';
import { sendAccountOtp } from './account-email.js';
import { generateOtp, digestOtp, otpMatches } from './account-otp.js';

const purposes = new Set(['EMAIL_VERIFY', 'EMAIL_CHANGE', 'PASSWORD_RESET']);
// Locking user row serializes challenge issuing and validation for the same user.
// Sending happens AFTER the database transaction; an email failure leaves an
// unsent but expiring challenge, and resend is available after the cooldown.
export async function issueChallenge(client, { userId, purpose, email }) {
  if (!purposes.has(purpose)) throw new Error('Invalid OTP purpose');
  const last = await client.query(
    `SELECT "CreatedAt" FROM "dbo"."UserAuthChallenges"
     WHERE "UserId"=$1 AND "Purpose"=$2 ORDER BY "CreatedAt" DESC LIMIT 1`,
    [userId, purpose],
  );
  if (last.rows[0] && Date.now() - new Date(last.rows[0].CreatedAt).getTime() < 60_000) {
    throw new ApiError(429, 'Please wait one minute before requesting another code.', 'OTP_COOLDOWN');
  }
  // Prevent more than 5 challenges of the same purpose per hour.
  const hour = await client.query(
    `SELECT COUNT(*)::int AS n FROM "dbo"."UserAuthChallenges"
     WHERE "UserId"=$1 AND "Purpose"=$2 AND "CreatedAt" > NOW() - INTERVAL '1 hour'`,
    [userId, purpose],
  );
  if (Number(hour.rows[0]?.n || 0) >= 5) {
    throw new ApiError(429, 'Too many code requests. Please try again in one hour.', 'OTP_RATE_LIMIT');
  }
  const code = generateOtp();
  await client.query(
    `UPDATE "dbo"."UserAuthChallenges" SET "ConsumedAt"=NOW()
     WHERE "UserId"=$1 AND "Purpose"=$2 AND "ConsumedAt" IS NULL`,
    [userId, purpose],
  );
  await client.query(
    `INSERT INTO "dbo"."UserAuthChallenges"
     ("UserId","Purpose","TargetEmail","CodeHash","ExpiresAt")
     VALUES ($1,$2,$3,$4,NOW()+INTERVAL '10 minutes')`,
    [userId, purpose, email, digestOtp({ userId, purpose, email, otp: code, pepper: config.otpPepper })],
  );
  return { email, code, purpose };
}
export async function deliverChallenge(challenge) {
  return sendAccountOtp(challenge);
}
export async function consumeChallenge(client, { userId, purpose, email, code }) {
  requireOtp(code);
  const challenge = await client.query(
    `SELECT * FROM "dbo"."UserAuthChallenges"
     WHERE "UserId"=$1 AND "Purpose"=$2 AND "ConsumedAt" IS NULL
     ORDER BY "CreatedAt" DESC LIMIT 1 FOR UPDATE`,
    [userId, purpose],
  );
  const row = challenge.rows[0];
  if (!row || new Date(row.ExpiresAt).getTime() <= Date.now() || row.AttemptsRemaining <= 0) {
    throw new ApiError(400, 'Verification code expired or unavailable. Request another code.', 'OTP_EXPIRED');
  }
  const valid = row.TargetEmail.toLowerCase() === email.toLowerCase() && otpMatches(
    row.CodeHash,
    digestOtp({ userId, purpose, email, otp: code, pepper: config.otpPepper }),
  );
  if (!valid) {
    await client.query(
      `UPDATE "dbo"."UserAuthChallenges" SET "AttemptsRemaining"=GREATEST(0,"AttemptsRemaining"-1)
       WHERE "Id"=$1`,
      [row.Id],
    );
    // IMPORTANT: Caller must not roll back the transaction on this error;
    // consumeChallenge returns a failure result so attempts decrement persists.
    return { ok: false };
  }
  await client.query(`UPDATE "dbo"."UserAuthChallenges" SET "ConsumedAt"=NOW() WHERE "Id"=$1`, [row.Id]);
  return { ok: true };
}
