-- Web Admin V2 (seefix-api#18): transactional cache-domain versions.
--
-- Every committed change to a business table bumps the version of its cache domain, inside the writer's own
-- transaction. Because this is done by triggers, the API, seefix-agents and seefix-worker are all covered without
-- code changes in those writers.
--
-- How it stays correct and deadlock-free:
--  * The triggers are DEFERRABLE INITIALLY DEFERRED constraint triggers, so they fire at COMMIT, after every business
--    row lock the transaction needs has been taken. Lock acquisition order is therefore always
--    "business rows ... then version rows", and version rows are only ever locked as the last step.
--  * Each firing first locks the single '*' row, then its domain row. Every transaction takes '*' first, so two
--    committing transactions can never hold domain rows in opposite orders.
--  * A transaction bumps each domain at most once (transaction-local marker), however many rows it changed.
--  * Versions come from the '*' counter, so they are strictly increasing across all domains and only become visible
--    on commit. A reader that reads the version BEFORE reading data never labels old data with a newer version.
--
-- Additive and safe to run more than once. Existing behaviour is unchanged. Run BEFORE deploying an API version that
-- serves /api/sync/versions, then `npm run verify:db`. Rollback is at the bottom.
SET client_min_messages = warning;
BEGIN;

CREATE TABLE IF NOT EXISTS "dbo"."CacheDomainVersions" (
  "Domain"    varchar(40) PRIMARY KEY,
  "Version"   bigint      NOT NULL DEFAULT 0 CHECK ("Version" >= 0),
  "ChangedAt" timestamptz NOT NULL DEFAULT now()
);

INSERT INTO "dbo"."CacheDomainVersions" ("Domain")
VALUES ('*'), ('reports'), ('work_orders'), ('procurement'), ('action_items'), ('users'), ('reference')
ON CONFLICT ("Domain") DO NOTHING;

CREATE OR REPLACE FUNCTION "dbo"."BumpCacheDomainVersion"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  domain  text := TG_ARGV[0];
  marker  text := 'seefix.cache_bumped_' || TG_ARGV[0];
  next_v  bigint;
BEGIN
  -- Once per domain per transaction.
  IF current_setting(marker, true) = txid_current()::text THEN
    RETURN NULL;
  END IF;
  UPDATE "dbo"."CacheDomainVersions" SET "Version" = "Version" + 1, "ChangedAt" = now()
   WHERE "Domain" = '*' RETURNING "Version" INTO next_v;
  UPDATE "dbo"."CacheDomainVersions" SET "Version" = next_v, "ChangedAt" = now()
   WHERE "Domain" = domain;
  PERFORM set_config(marker, txid_current()::text, true);
  RETURN NULL;
END $$;

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('Reports', 'reports'), ('ReportImages', 'reports'), ('ReportStatusHistory', 'reports'),
      ('ReportAssessmentHistory', 'reports'), ('ReportVerifications', 'reports'),
      ('ReportDuplicateCandidates', 'reports'), ('MaintenanceRequests', 'reports'),
      ('MaintenanceRequestMaterials', 'reports'), ('MaintenanceRequestSkills', 'reports'),
      ('MaintenanceRequestRevisions', 'reports'), ('MaintenanceReviews', 'reports'),
      ('WorkOrders', 'work_orders'), ('WorkOrderAssignments', 'work_orders'), ('WorkOrderPeople', 'work_orders'),
      ('WorkOrderMaterials', 'work_orders'), ('WorkOrderImages', 'work_orders'), ('WorkOrderUpdates', 'work_orders'),
      ('ProcurementHandoffs', 'procurement'), ('ProcurementClarifications', 'procurement'),
      ('ProcurementDocuments', 'procurement'), ('ProcurementOutcomes', 'procurement'),
      ('WorkflowActionItems', 'action_items'),
      ('Users', 'users'),
      ('Buildings', 'reference'), ('FacilityLocations', 'reference'), ('DamageCategories', 'reference'),
      ('Skills', 'reference'), ('Materials', 'reference'), ('CategorySkillRequirements', 'reference'),
      ('CategoryMaterialReferences', 'reference'), ('SystemSettings', 'reference')
    ) AS v(tbl, dom)
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON "dbo".%I', 'CT_' || t.tbl || '_CacheVersion', t.tbl);
    EXECUTE format(
      'CREATE CONSTRAINT TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON "dbo".%I '
      'DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "dbo"."BumpCacheDomainVersion"(%L)',
      'CT_' || t.tbl || '_CacheVersion', t.tbl, t.dom);
  END LOOP;
END $$;

COMMIT;

-- Rollback (drops only what this file created; no business data is touched):
-- DO $$ DECLARE t record; BEGIN
--   FOR t IN SELECT tgname, tgrelid::regclass AS rel FROM pg_trigger WHERE tgname LIKE 'CT\_%\_CacheVersion' LOOP
--     EXECUTE format('DROP TRIGGER %I ON %s', t.tgname, t.rel);
--   END LOOP; END $$;
-- DROP FUNCTION IF EXISTS "dbo"."BumpCacheDomainVersion"();
-- DROP TABLE IF EXISTS "dbo"."CacheDomainVersions";
