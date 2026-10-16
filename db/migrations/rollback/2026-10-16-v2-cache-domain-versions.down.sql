-- Rollback of 2026-10-16-v2-cache-domain-versions.sql. Drops only what that migration created; no business data.
-- Roll back V2 migrations in reverse order: search-buildings, rate-limits, then this one.
SET client_min_messages = warning;
BEGIN;
DO $$ DECLARE t record; BEGIN
  FOR t IN SELECT tgname, tgrelid::regclass AS rel FROM pg_trigger WHERE tgname LIKE 'CT\_%\_CacheVersion' LOOP
    EXECUTE format('DROP TRIGGER %I ON %s', t.tgname, t.rel);
  END LOOP;
END $$;
DROP FUNCTION IF EXISTS "dbo"."BumpCacheDomainVersion"();
DROP TABLE IF EXISTS "dbo"."CacheDomainVersions";
COMMIT;
