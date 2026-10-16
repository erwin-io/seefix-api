-- Campus map (Web Admin follow-up): maintenance can fix where a report is shown on the map.
-- Additive and safe to run more than once. Run after 2026-10-16-v2-cache-domain-versions.sql. Rollback in
-- rollback/2026-10-17-report-map-location.down.sql.
--
-- * dbo."ReportLocationCorrections": one saved map location per report, set by maintenance (manual pin or a building's
--   location). It is a separate table so dbo."Reports" (its raw GPS, building text and triggers) is never changed.
--   GET /api/map shows a corrected report with source CORRECTED; raw GPS is still returned unchanged.
-- * Every change bumps the 'reports' cache domain (same deferred constraint trigger as the other report tables), so
--   open maps refresh.
-- * The campus map area (centre, radius, minimum zoom) needs no schema change: it is the dbo."SystemSettings" row
--   'campus.map', written by PUT /api/admin/campus-settings (defaults apply until an admin saves it).
SET client_min_messages = warning;
BEGIN;

CREATE TABLE IF NOT EXISTS "dbo"."ReportLocationCorrections" (
  "ReportId"   uuid PRIMARY KEY REFERENCES "dbo"."Reports"("Id") ON DELETE CASCADE,
  "Lat"        numeric(9, 6) NOT NULL CHECK ("Lat" BETWEEN -90 AND 90),
  "Lng"        numeric(9, 6) NOT NULL CHECK ("Lng" BETWEEN -180 AND 180),
  "Source"     varchar(20)   NOT NULL CHECK ("Source" IN ('MANUAL', 'BUILDING')),
  "BuildingId" uuid REFERENCES "dbo"."Buildings"("Id") ON DELETE SET NULL,
  "Reason"     varchar(500),
  "UpdatedBy"  uuid NOT NULL REFERENCES "dbo"."Users"("Id"),
  "UpdatedAt"  timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS "CT_ReportLocationCorrections_CacheVersion" ON "dbo"."ReportLocationCorrections";
CREATE CONSTRAINT TRIGGER "CT_ReportLocationCorrections_CacheVersion"
  AFTER INSERT OR UPDATE OR DELETE ON "dbo"."ReportLocationCorrections"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "dbo"."BumpCacheDomainVersion"('reports');

COMMIT;
