-- Web Admin V2 (seefix-api#20): universal search indexes and campus building geometry.
-- Additive and safe to run more than once. Run after 2026-10-16-v2-cache-domain-versions.sql. Rollback at the bottom.
--
-- * pg_trgm GIN indexes make the ILIKE '%term%' searches of GET /api/search index-assisted.
--   (Neon allows CREATE EXTENSION pg_trgm for the database owner.)
-- * Building geometry lives on dbo."Buildings" (no PostGIS needed): a default pin, an optional perimeter polygon as a
--   JSON array of [lat, lng] pairs, a tolerance in metres and a revision number. Every geometry change is recorded in
--   dbo."BuildingGeometryHistory". Reports keep their raw GPS untouched; the map only derives a display location.
SET client_min_messages = warning;
BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "IX_Reports_Search_Trgm" ON "dbo"."Reports"
  USING gin (("ReportNo" || ' ' || coalesce("Description", '') || ' ' || coalesce("Building", '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "IX_WorkOrders_Search_Trgm" ON "dbo"."WorkOrders"
  USING gin (("WorkOrderNo" || ' ' || coalesce("AssignedPartyName", '') || ' ' || coalesce("ResponsibleLeadName", '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "IX_ProcurementHandoffs_Search_Trgm" ON "dbo"."ProcurementHandoffs"
  USING gin (("HandoffNo" || ' ' || coalesce("ExternalSystemReference", '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "IX_MaintenanceRequests_Search_Trgm" ON "dbo"."MaintenanceRequests"
  USING gin (("RequestNo" || ' ' || coalesce("ScopeOfWork", '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "IX_Users_Search_Trgm" ON "dbo"."Users"
  USING gin (("FullName" || ' ' || "Email" || ' ' || coalesce("Username", '')) gin_trgm_ops);

ALTER TABLE "dbo"."Buildings"
  ADD COLUMN IF NOT EXISTS "DefaultLat"        numeric(9,6) NULL,
  ADD COLUMN IF NOT EXISTS "DefaultLng"        numeric(9,6) NULL,
  ADD COLUMN IF NOT EXISTS "Perimeter"         jsonb        NULL,
  ADD COLUMN IF NOT EXISTS "ToleranceMeters"   integer      NOT NULL DEFAULT 25,
  ADD COLUMN IF NOT EXISTS "GeometryRevision"  integer      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "GeometryUpdatedAt" timestamptz  NULL,
  ADD COLUMN IF NOT EXISTS "GeometryUpdatedBy" uuid         NULL REFERENCES "dbo"."Users"("Id") ON DELETE SET NULL;

DO $$ BEGIN
  ALTER TABLE "dbo"."Buildings" ADD CONSTRAINT "CK_Buildings_Geometry" CHECK (
    ("DefaultLat" IS NULL) = ("DefaultLng" IS NULL)
    AND ("DefaultLat" IS NULL OR ("DefaultLat" BETWEEN -90 AND 90 AND "DefaultLng" BETWEEN -180 AND 180))
    AND "ToleranceMeters" BETWEEN 0 AND 1000
    AND ("Perimeter" IS NULL OR jsonb_typeof("Perimeter") = 'array')
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "dbo"."BuildingGeometryHistory" (
  "Id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "BuildingId"      uuid NOT NULL REFERENCES "dbo"."Buildings"("Id") ON DELETE CASCADE,
  "Revision"        integer NOT NULL,
  "DefaultLat"      numeric(9,6) NULL,
  "DefaultLng"      numeric(9,6) NULL,
  "Perimeter"       jsonb NULL,
  "ToleranceMeters" integer NOT NULL,
  "Reason"          text NULL,
  "ChangedBy"       uuid NULL REFERENCES "dbo"."Users"("Id") ON DELETE SET NULL,
  "ChangedAt"       timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("BuildingId", "Revision")
);

COMMIT;

-- Rollback (business data untouched; geometry and its history are removed):
-- DROP TABLE IF EXISTS "dbo"."BuildingGeometryHistory";
-- ALTER TABLE "dbo"."Buildings" DROP CONSTRAINT IF EXISTS "CK_Buildings_Geometry",
--   DROP COLUMN IF EXISTS "DefaultLat", DROP COLUMN IF EXISTS "DefaultLng", DROP COLUMN IF EXISTS "Perimeter",
--   DROP COLUMN IF EXISTS "ToleranceMeters", DROP COLUMN IF EXISTS "GeometryRevision",
--   DROP COLUMN IF EXISTS "GeometryUpdatedAt", DROP COLUMN IF EXISTS "GeometryUpdatedBy";
-- DROP INDEX IF EXISTS "dbo"."IX_Reports_Search_Trgm", "dbo"."IX_WorkOrders_Search_Trgm",
--   "dbo"."IX_ProcurementHandoffs_Search_Trgm", "dbo"."IX_MaintenanceRequests_Search_Trgm", "dbo"."IX_Users_Search_Trgm";
-- (pg_trgm is left installed; DROP EXTENSION pg_trgm only if nothing else uses it.)
