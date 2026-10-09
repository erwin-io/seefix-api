import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { ApiError } from '../errors.js';

let transport;
function transporter() {
  if (!config.smtpHost || !config.smtpFrom) {
    throw new ApiError(503, 'Account email service is temporarily unavailable.', 'EMAIL_SERVICE_UNAVAILABLE');
  }
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpPort === 465,
      requireTLS: config.smtpPort !== 465,
      ...(config.smtpUser ? { auth: { user: config.smtpUser, pass: config.smtpPass } } : {}),
    });
  }
  return transport;
}
const subjects = {
  EMAIL_VERIFY: 'Verify your SEEFIX account',
  EMAIL_CHANGE: 'Confirm your new SEEFIX email address',
  PASSWORD_RESET: 'SEEFIX password reset code',
};

export async function sendAccountOtp({ email, code, purpose }) {
  const subject = subjects[purpose];
  if (!subject) throw new Error('Invalid email purpose');
  const text = `Your SEEFIX code is ${code}. It expires in 10 minutes. Do not share this code. If you did not request it, you can ignore this email.`;
  try {
    await transporter().sendMail({ from: config.smtpFrom, to: email, subject, text });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    console.error('[ACCOUNT MAIL] Email delivery failed:', err?.message);
    throw new ApiError(503, 'We could not send the email. Please try again later.', 'EMAIL_DELIVERY_FAILED');
  }
}
