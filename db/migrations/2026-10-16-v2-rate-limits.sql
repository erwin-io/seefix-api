-- Web Admin V2 (seefix-api#19): shared fixed-window counters for security-critical rate limits.
-- Vercel runs many API instances, so per-process memory limits are only best effort; login/OTP/AI limits use this
-- table instead (one atomic upsert per checked request). Keys never contain raw emails or passwords: identifiers are
-- SHA-256 hashed by the API before they get here.
-- Additive and safe to run more than once. Rollback at the bottom.
SET client_min_messages = warning;
BEGIN;

CREATE TABLE IF NOT EXISTS "dbo"."RateLimitBuckets" (
  "Key"         varchar(200) PRIMARY KEY,
  "WindowStart" timestamptz  NOT NULL,
  "Count"       integer      NOT NULL CHECK ("Count" >= 0)
);

-- Pruning old windows (the API also deletes expired rows opportunistically).
CREATE INDEX IF NOT EXISTS "IX_RateLimitBuckets_WindowStart" ON "dbo"."RateLimitBuckets" ("WindowStart");

COMMIT;

-- Rollback:
-- DROP TABLE IF EXISTS "dbo"."RateLimitBuckets";
