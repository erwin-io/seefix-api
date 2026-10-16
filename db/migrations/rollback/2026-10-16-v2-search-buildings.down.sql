-- Rollback of 2026-10-16-v2-search-buildings.sql. Removes the search indexes and building geometry + its history;
-- buildings, reports and their GPS are untouched. pg_trgm stays installed (DROP EXTENSION only if nothing uses it).
-- Take a backup first if building geometry has been entered and should be kept.
SET client_min_messages = warning;
BEGIN;
DROP TABLE IF EXISTS "dbo"."BuildingGeometryHistory";
ALTER TABLE "dbo"."Buildings" DROP CONSTRAINT IF EXISTS "CK_Buildings_Geometry",
  DROP COLUMN IF EXISTS "DefaultLat", DROP COLUMN IF EXISTS "DefaultLng", DROP COLUMN IF EXISTS "Perimeter",
  DROP COLUMN IF EXISTS "ToleranceMeters", DROP COLUMN IF EXISTS "GeometryRevision",
  DROP COLUMN IF EXISTS "GeometryUpdatedAt", DROP COLUMN IF EXISTS "GeometryUpdatedBy";
DROP INDEX IF EXISTS "dbo"."IX_Reports_Search_Trgm", "dbo"."IX_WorkOrders_Search_Trgm",
  "dbo"."IX_ProcurementHandoffs_Search_Trgm", "dbo"."IX_MaintenanceRequests_Search_Trgm", "dbo"."IX_Users_Search_Trgm";
COMMIT;
