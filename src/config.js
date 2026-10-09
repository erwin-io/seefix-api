import "dotenv/config";

function intEnv(name, fallback, min = 0) {
  const raw = process.env[name];
  const value =
    raw == null || raw === ""
      ? fallback
      : Number.parseInt(raw, 10);

  if (!Number.isFinite(value) || value < min) {
    throw new Error(
      `${name} must be an integer >= ${min}.`,
    );
  }

  return value;
}

function csvEnv(name) {
  return String(process.env[name] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export const config = Object.freeze({
  nodeEnv: process.env.NODE_ENV || "development",

  port: intEnv("PORT", 3000, 1),
  host: process.env.API_HOST || "127.0.0.1",

  databaseUrl: String(
    process.env.DATABASE_URL || "",
  ).trim(),

  databaseSslMode: String(
    process.env.DATABASE_SSLMODE || "prefer",
  )
    .trim()
    .toLowerCase(),

  databaseSslRootCert: String(
    process.env.DATABASE_SSLROOTCERT || "",
  ).trim(),

  databaseConnectTimeoutMs: intEnv(
    "DATABASE_CONNECT_TIMEOUT_MS",
    10000,
    1,
  ),

  databasePoolMax: intEnv(
    "DATABASE_POOL_MAX",
    10,
    1,
  ),

  jwtSecret: String(
    process.env.JWT_SECRET || "",
  ).trim(),

  // A dedicated pepper is used to HMAC one-time verification codes.
  otpPepper: String(process.env.OTP_PEPPER || '').trim(),
  smtpHost: String(process.env.SMTP_HOST || '').trim(),
  smtpPort: intEnv('SMTP_PORT', 587, 1),
  smtpUser: String(process.env.SMTP_USER || '').trim(),
  smtpPass: String(process.env.SMTP_PASS || ''),
  smtpFrom: String(process.env.SMTP_FROM || '').trim(),

  jwtExpiresIn: String(
    process.env.JWT_EXPIRES_IN || "7d",
  ).trim(),

  bcryptRounds: intEnv(
    "BCRYPT_ROUNDS",
    12,
    8,
  ),

  agentUrl: String(
    process.env.LOCAL_AGENT_URL ||
      "http://127.0.0.1:8000",
  )
    .trim()
    .replace(/\/+$/, ""),

  agentSecret: String(
    process.env.LOCAL_AGENT_SECRET || "",
  ).trim(),

  // Local Ollama/VLM operations can legitimately take
  // longer than a normal HTTP request.
  agentTimeoutMs: intEnv(
    "AGENT_TIMEOUT_MS",
    180000,
    1000,
  ),

  agentHealthTimeoutMs: intEnv(
    "AGENT_HEALTH_TIMEOUT_MS",
    10000,
    1000,
  ),

  agentDebugErrors:
    String(
      process.env.AGENT_DEBUG_ERRORS || "false",
    ).toLowerCase() === "true",

  cloudinaryCloudName: String(
    process.env.CLOUDINARY_CLOUD_NAME || "",
  ).trim(),

  cloudinaryApiKey: String(
    process.env.CLOUDINARY_API_KEY || "",
  ).trim(),

  cloudinaryApiSecret: String(
    process.env.CLOUDINARY_API_SECRET || "",
  ).trim(),

  cloudinaryReportFolder:
    process.env.CLOUDINARY_REPORT_FOLDER ||
    "seefix/reports",

  cloudinaryWorkOrderFolder:
    process.env.CLOUDINARY_WORK_ORDER_FOLDER ||
    "seefix/work-orders",

  cloudinaryDocumentFolder:
    process.env.CLOUDINARY_DOCUMENT_FOLDER ||
    "seefix/procurement",

  maxUploadMb: intEnv(
    "MAX_UPLOAD_MB",
    10,
    1,
  ),

  maxReportImages: intEnv(
    "MAX_REPORT_IMAGES",
    5,
    1,
  ),

  corsOrigins: csvEnv("CORS_ORIGINS"),

  procurementToEmails: csvEnv(
    "PROCUREMENT_TO_EMAILS",
  ),

  procurementCcEmails: csvEnv(
    "PROCUREMENT_CC_EMAILS",
  ),

  procurementFollowupHours: intEnv(
    "PROCUREMENT_FOLLOWUP_HOURS",
    24,
    1,
  ),

  // Realtime (optional). Empty PUSHER_* = disabled: OutboxEvents rows stay PENDING, clients poll.
  pusherAppId: String(process.env.PUSHER_APP_ID || "").trim(),
  pusherKey: String(process.env.PUSHER_KEY || "").trim(),
  pusherSecret: String(process.env.PUSHER_SECRET || ""),
  pusherCluster: String(process.env.PUSHER_CLUSTER || "").trim(),
  // OutboxEvents -> Pusher dispatcher, started by server.js (or `npm run outbox:dispatch` as a separate worker).
  outboxDispatcherEnabled: String(process.env.OUTBOX_DISPATCHER || "auto").trim().toLowerCase() !== "off",
  outboxPollMs: intEnv("OUTBOX_POLL_MS", 2000, 200),
  outboxBatchSize: intEnv("OUTBOX_BATCH_SIZE", 25, 1),
  outboxMaxAttempts: intEnv("OUTBOX_MAX_ATTEMPTS", 8, 1),
  outboxLeaseSeconds: intEnv("OUTBOX_LEASE_SECONDS", 60, 5),
  outboxBackoffBaseMs: intEnv("OUTBOX_BACKOFF_BASE_MS", 2000, 100),
  outboxBackoffMaxMs: intEnv("OUTBOX_BACKOFF_MAX_MS", 600000, 1000),
});

export function validateRuntimeConfig() {
  const required = [
    ["DATABASE_URL", config.databaseUrl],
    ["JWT_SECRET", config.jwtSecret],
    ["OTP_PEPPER", config.otpPepper],
    ["SMTP_HOST", config.smtpHost],
    ["SMTP_FROM", config.smtpFrom],
    [
      "LOCAL_AGENT_SECRET",
      config.agentSecret,
    ],
  ];

  const missing = required
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}`,
    );
  }

  if (config.otpPepper.length < 32) {
    throw new Error('OTP_PEPPER must be at least 32 characters.');
  }
  if (config.smtpUser && !config.smtpPass) {
    throw new Error('SMTP_PASS is required when SMTP_USER is set.');
  }
  if (config.jwtSecret.length < 32) {
    throw new Error(
      "JWT_SECRET must be at least 32 characters.",
    );
  }
}
