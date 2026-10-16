-- Rollback of 2026-10-17-report-map-location.sql. Drops saved report map locations (reports, their GPS and buildings
-- are untouched; the map falls back to GPS / building location). Take a backup first if corrections should be kept.
SET client_min_messages = warning;
BEGIN;
DROP TABLE IF EXISTS "dbo"."ReportLocationCorrections";
COMMIT;
