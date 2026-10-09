import crypto from 'node:crypto';

export function generateOtp() {
  return String(crypto.randomInt(100000, 1000000));
}
export function digestOtp({ userId, purpose, email, otp, pepper }) {
  if (!pepper || pepper.length < 32) throw new Error('OTP_PEPPER must be at least 32 characters');
  return crypto.createHmac('sha256', pepper)
    .update(`${userId}:${purpose}:${email.toLowerCase()}:${otp}`)
    .digest('hex');
}
export function otpMatches(stored, candidate) {
  if (!/^[a-f0-9]{64}$/.test(String(stored))) return false;
  if (!/^[a-f0-9]{64}$/.test(String(candidate))) return false;
  return crypto.timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(candidate, 'hex'));
}
