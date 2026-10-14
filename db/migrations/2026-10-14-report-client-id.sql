-- Offline Reporter (plan D1): idempotent report creation by clientReportId.
-- Safe to run more than once. Existing reports and legacy clients are unaffected (both columns stay NULL).
-- Run BEFORE deploying an app version that sends clientReportId; then `npm run verify:db`.
BEGIN;

ALTER TABLE "dbo"."Reports" ADD COLUMN IF NOT EXISTS "ClientReportId" uuid NULL;
-- SHA-256 of the submitted fields and per-photo content digests (see clientRequestHash in report-service.js).
ALTER TABLE "dbo"."Reports" ADD COLUMN IF NOT EXISTS "ClientRequestHash" char(64) NULL;

-- One report per (Reporter, clientReportId). NULLs are excluded, so legacy requests never collide.
CREATE UNIQUE INDEX IF NOT EXISTS "UX_Reports_Reporter_ClientReportId"
  ON "dbo"."Reports" ("ReporterId", "ClientReportId")
  WHERE "ClientReportId" IS NOT NULL;

COMMIT;

-- Rollback (only if no app version depends on it yet):
-- DROP INDEX IF EXISTS "dbo"."UX_Reports_Reporter_ClientReportId";
-- ALTER TABLE "dbo"."Reports" DROP COLUMN IF EXISTS "ClientRequestHash", DROP COLUMN IF EXISTS "ClientReportId";
