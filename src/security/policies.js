import { clientIp, hashKey, memoryRateLimit, sharedRateLimit } from "./rate-limit.js";

/**
 * Rate-limit policies (seefix-api#19, docs/V2_SECURITY.md). Shared = database-backed, correct across instances.
 * IP limits are generous because many staff can share one address (office NAT, the web admin's proxy); the strict
 * limits are per account identifier, so one attacker can't lock out a whole office.
 */
const MIN = 60;
const ip = (req) => clientIp(req);
// First non-empty of the given body fields, exactly as the route reads them (login accepts identifier/email/username).
const bodyId = (...fields) => (req) => {
  const value = fields.map((f) => req.body?.[f]).find((v) => v !== undefined && v !== null);
  const text = String(value ?? "").trim();
  return text ? hashKey(text) : null;
};

const TOO_MANY_SIGN_INS = "Too many sign-in attempts. Please wait a few minutes and try again.";
const TOO_MANY_CODES = "Too many attempts. Please wait and try again.";

export const limits = {
  login: [
    sharedRateLimit({ name: "login-ip", windowSeconds: 15 * MIN, max: 60, key: ip, message: TOO_MANY_SIGN_INS }),
    sharedRateLimit({ name: "login-id", windowSeconds: 15 * MIN, max: 10, key: bodyId("identifier", "email", "username"), message: TOO_MANY_SIGN_INS }),
  ],
  register: [
    sharedRateLimit({ name: "register-ip", windowSeconds: 60 * MIN, max: 20, key: ip, message: TOO_MANY_CODES }),
  ],
  // Code requests: the per-user cooldown (1/min, 5/h) already exists; these add per-IP and per-address limits,
  // which also cover addresses with no account.
  codeRequest: [
    sharedRateLimit({ name: "code-req-ip", windowSeconds: 60 * MIN, max: 30, key: ip, message: TOO_MANY_CODES }),
    sharedRateLimit({ name: "code-req-email", windowSeconds: 60 * MIN, max: 10, key: bodyId("email"), message: TOO_MANY_CODES }),
  ],
  // Code checks: each challenge already has limited attempts; this bounds guessing across re-issued challenges.
  codeCheck: [
    sharedRateLimit({ name: "code-check-ip", windowSeconds: 15 * MIN, max: 60, key: ip, message: TOO_MANY_CODES }),
    sharedRateLimit({ name: "code-check-email", windowSeconds: 15 * MIN, max: 15, key: bodyId("email"), message: TOO_MANY_CODES }),
  ],
  // Current-password checks by a signed-in session (a stolen token must not brute-force the password).
  passwordCheck: [
    sharedRateLimit({ name: "pw-check-user", windowSeconds: 15 * MIN, max: 10, key: (req) => req.user?.id, message: TOO_MANY_CODES }),
  ],
  // Model calls are slow and run on one AI host.
  aiGenerate: [
    sharedRateLimit({
      name: "ai-gen-user", windowSeconds: 60 * MIN, max: 30, key: (req) => req.user?.id,
      message: "Too many AI requests. Please wait before regenerating again.",
    }),
  ],
  // Assistant chat (seefix-api#21): one model call per question, queued behind report jobs on the AI host.
  assistantAsk: [
    sharedRateLimit({
      name: "assistant-ask-user", windowSeconds: 60 * MIN, max: 120, key: (req) => req.user?.id,
      message: "Too many assistant questions. Please wait a little.",
    }),
  ],
};

/**
 * Best-effort general throttle per signed-in user, per instance. 600/min leaves room for loading a 10k-row table
 * (20 pages of 500) many times over, while stopping runaway loops.
 */
export const userThrottle = memoryRateLimit({ windowMs: 60_000, max: 600, key: (req) => req.user?.id });
