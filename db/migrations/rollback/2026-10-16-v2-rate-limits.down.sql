-- Rollback of 2026-10-16-v2-rate-limits.sql (only throwaway rate-limit counters are lost).
SET client_min_messages = warning;
BEGIN;
DROP TABLE IF EXISTS "dbo"."RateLimitBuckets";
COMMIT;
