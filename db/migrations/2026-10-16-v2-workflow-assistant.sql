-- Web Admin V2 (seefix-api#21): assistant drafts, guarded assessment regeneration queue, persistent reminders.
-- Additive and safe to run more than once. Run after 2026-10-16-v2-search-buildings.sql.
-- Rollback: db/migrations/rollback/2026-10-16-v2-workflow-assistant.down.sql. Contract: docs/V2_ASSISTANT.md.
--
-- * AssistantDrafts: private text drafts. They never change a workflow table; a human submits through the normal routes.
-- * AssessmentRegenerationJobs: a PostgreSQL PENDING queue the Agent claims (no direct API → Agent push). The current
--   assessment stays reviewable while a job runs. Finish is fenced on job status + attempt + "still no human decision".
-- * AssistantReminders: scheduled in UTC; seefix-worker claims due rows and delivers through Notifications/Outbox.
-- None of these tables is a cache domain; the Agent's assessment write still bumps `reports` via the existing triggers.
SET client_min_messages = warning;
BEGIN;

CREATE TABLE IF NOT EXISTS "dbo"."AssistantDrafts" (
  "Id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "UserId"         uuid NOT NULL REFERENCES "dbo"."Users"("Id") ON DELETE CASCADE,
  "Kind"           varchar(40) NOT NULL,
  "EntityType"     varchar(40) NOT NULL,
  "EntityId"       uuid NOT NULL,
  "Body"           text NOT NULL,
  "Status"         varchar(20) NOT NULL DEFAULT 'DRAFT',
  "IdempotencyKey" uuid NOT NULL,
  "CreatedAt"      timestamptz NOT NULL DEFAULT now(),
  "UpdatedAt"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "CK_AssistantDrafts_Kind" CHECK ("Kind" IN ('REVIEW_NOTE','WORK_ORDER_UPDATE','CLARIFICATION_REPLY')),
  CONSTRAINT "CK_AssistantDrafts_Status" CHECK ("Status" IN ('DRAFT','DISCARDED')),
  CONSTRAINT "CK_AssistantDrafts_Body" CHECK (length("Body") BETWEEN 1 AND 8000),
  CONSTRAINT "UQ_AssistantDrafts_Idempotency" UNIQUE ("UserId","IdempotencyKey")
);
CREATE INDEX IF NOT EXISTS "IX_AssistantDrafts_User" ON "dbo"."AssistantDrafts" ("UserId","Status","CreatedAt" DESC);

CREATE TABLE IF NOT EXISTS "dbo"."AssessmentRegenerationJobs" (
  "Id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "ReportId"         uuid NOT NULL REFERENCES "dbo"."Reports"("Id") ON DELETE CASCADE,
  "RequestedBy"      uuid NULL REFERENCES "dbo"."Users"("Id") ON DELETE SET NULL,
  "Reason"           text NOT NULL,
  "IdempotencyKey"   uuid NOT NULL,
  "Status"           varchar(20) NOT NULL DEFAULT 'PENDING',
  "BaseAgentAttempt" integer NOT NULL,
  "AttemptCount"     integer NOT NULL DEFAULT 0,
  "ClaimedAt"        timestamptz NULL,
  "ClaimedBy"        varchar(150) NULL,
  "FinishedAt"       timestamptz NULL,
  "LastError"        text NULL,
  "CancelledBy"      uuid NULL REFERENCES "dbo"."Users"("Id") ON DELETE SET NULL,
  "CreatedAt"        timestamptz NOT NULL DEFAULT now(),
  "UpdatedAt"        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "CK_AssessmentRegenerationJobs_Status"
    CHECK ("Status" IN ('PENDING','PROCESSING','COMPLETED','FAILED','CANCELLED','SUPERSEDED')),
  CONSTRAINT "CK_AssessmentRegenerationJobs_Reason" CHECK (length("Reason") BETWEEN 3 AND 1000),
  CONSTRAINT "UQ_AssessmentRegenerationJobs_Idempotency" UNIQUE ("RequestedBy","IdempotencyKey")
);
-- One active job per report: a second request (or a replay with a new key) can never queue a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS "UX_AssessmentRegenerationJobs_Active" ON "dbo"."AssessmentRegenerationJobs" ("ReportId")
  WHERE "Status" IN ('PENDING','PROCESSING');
CREATE INDEX IF NOT EXISTS "IX_AssessmentRegenerationJobs_Queue" ON "dbo"."AssessmentRegenerationJobs" ("Status","CreatedAt");
CREATE INDEX IF NOT EXISTS "IX_AssessmentRegenerationJobs_Report" ON "dbo"."AssessmentRegenerationJobs" ("ReportId","CreatedAt" DESC);

CREATE TABLE IF NOT EXISTS "dbo"."AssistantReminders" (
  "Id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "CreatedBy"       uuid NOT NULL REFERENCES "dbo"."Users"("Id") ON DELETE CASCADE,
  "RecipientUserId" uuid NOT NULL REFERENCES "dbo"."Users"("Id") ON DELETE CASCADE,
  "Title"           varchar(250) NOT NULL,
  "Message"         text NULL,
  "EntityType"      varchar(40) NULL,
  "EntityId"        uuid NULL,
  "DueAt"           timestamptz NOT NULL,
  "TimeZone"        varchar(64) NOT NULL,
  "Status"          varchar(20) NOT NULL DEFAULT 'SCHEDULED',
  "NextRunAt"       timestamptz NOT NULL,
  "Attempts"        integer NOT NULL DEFAULT 0,
  "ClaimedAt"       timestamptz NULL,
  "ClaimedBy"       varchar(150) NULL,
  "LastError"       text NULL,
  "NotificationId"  uuid NULL REFERENCES "dbo"."Notifications"("Id") ON DELETE SET NULL,
  "SentAt"          timestamptz NULL,
  "CancelledAt"     timestamptz NULL,
  "CancelledBy"     uuid NULL REFERENCES "dbo"."Users"("Id") ON DELETE SET NULL,
  "IdempotencyKey"  uuid NOT NULL,
  "CreatedAt"       timestamptz NOT NULL DEFAULT now(),
  "UpdatedAt"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "CK_AssistantReminders_Status" CHECK ("Status" IN ('SCHEDULED','PROCESSING','SENT','CANCELLED','FAILED')),
  CONSTRAINT "CK_AssistantReminders_Entity" CHECK (("EntityType" IS NULL) = ("EntityId" IS NULL)),
  CONSTRAINT "CK_AssistantReminders_Message" CHECK ("Message" IS NULL OR length("Message") <= 2000),
  CONSTRAINT "CK_AssistantReminders_Attempts" CHECK ("Attempts" >= 0),
  CONSTRAINT "UQ_AssistantReminders_Idempotency" UNIQUE ("CreatedBy","IdempotencyKey")
);
CREATE INDEX IF NOT EXISTS "IX_AssistantReminders_Due" ON "dbo"."AssistantReminders" ("Status","NextRunAt");
CREATE INDEX IF NOT EXISTS "IX_AssistantReminders_Recipient" ON "dbo"."AssistantReminders" ("RecipientUserId","DueAt" DESC);
CREATE INDEX IF NOT EXISTS "IX_AssistantReminders_Creator" ON "dbo"."AssistantReminders" ("CreatedBy","Status");

DO $$ BEGIN
  CREATE TRIGGER "TR_AssistantDrafts_UpdatedAt" BEFORE UPDATE ON "dbo"."AssistantDrafts"
    FOR EACH ROW EXECUTE FUNCTION "dbo"."SetUpdatedAt"();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER "TR_AssessmentRegenerationJobs_UpdatedAt" BEFORE UPDATE ON "dbo"."AssessmentRegenerationJobs"
    FOR EACH ROW EXECUTE FUNCTION "dbo"."SetUpdatedAt"();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER "TR_AssistantReminders_UpdatedAt" BEFORE UPDATE ON "dbo"."AssistantReminders"
    FOR EACH ROW EXECUTE FUNCTION "dbo"."SetUpdatedAt"();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The single eligibility rule for a reassessment, used by the API request, the Agent claim and the Agent finish.
-- A cancelled report is never PENDING_REVIEW, so it can never be revived through this path.
CREATE OR REPLACE FUNCTION "dbo"."IsReportReassessable"(p_report uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "dbo"."Reports" r
     WHERE r."Id" = p_report AND r."Status" = 'PENDING_REVIEW' AND r."AgentStatus" = 'COMPLETED'
       AND NOT EXISTS (SELECT 1 FROM "dbo"."MaintenanceReviews" rv WHERE rv."ReportId" = r."Id" AND rv."Status" <> 'CANCELLED')
       AND NOT EXISTS (SELECT 1 FROM "dbo"."MaintenanceRequests" mr WHERE mr."ReportId" = r."Id" AND mr."Status" <> 'DRAFT'))
$$;

-- Human authority wins: once a report leaves PENDING_REVIEW, or a review is recorded, active jobs are superseded.
-- One function per table: PL/pgSQL resolves NEW."ReportId" even in an untaken CASE branch, so it can't be shared.
CREATE OR REPLACE FUNCTION "dbo"."SupersedeReassessmentJobs"(p_report uuid, p_reason text) RETURNS void
LANGUAGE sql AS $$
  UPDATE "dbo"."AssessmentRegenerationJobs" SET "Status" = 'SUPERSEDED', "FinishedAt" = now(), "LastError" = p_reason
   WHERE "ReportId" = p_report AND "Status" IN ('PENDING','PROCESSING')
$$;
CREATE OR REPLACE FUNCTION "dbo"."SupersedeReassessmentOnReportStatus"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "dbo"."SupersedeReassessmentJobs"(NEW."Id", 'REPORT_' || NEW."Status");
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION "dbo"."SupersedeReassessmentOnReview"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "dbo"."SupersedeReassessmentJobs"(NEW."ReportId", 'HUMAN_REVIEW_RECORDED');
  RETURN NEW;
END $$;

DO $$ BEGIN
  CREATE TRIGGER "TR_Reports_SupersedeReassessment" AFTER UPDATE OF "Status" ON "dbo"."Reports"
    FOR EACH ROW WHEN (OLD."Status" = 'PENDING_REVIEW' AND NEW."Status" <> 'PENDING_REVIEW')
    EXECUTE FUNCTION "dbo"."SupersedeReassessmentOnReportStatus"();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER "TR_MaintenanceReviews_SupersedeReassessment" AFTER INSERT OR UPDATE OF "Status" ON "dbo"."MaintenanceReviews"
    FOR EACH ROW WHEN (NEW."Status" <> 'CANCELLED')
    EXECUTE FUNCTION "dbo"."SupersedeReassessmentOnReview"();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Agent: claim the oldest eligible PENDING job. Ineligible ones are superseded on the way (never claimed).
CREATE OR REPLACE FUNCTION "dbo"."ClaimNextAssessmentRegeneration"(p_worker text)
RETURNS TABLE ("JobId" uuid, "ReportId" uuid, "Attempt" integer)
LANGUAGE plpgsql AS $$
DECLARE j record;
BEGIN
  LOOP
    SELECT * INTO j FROM "dbo"."AssessmentRegenerationJobs"
     WHERE "Status" = 'PENDING' ORDER BY "CreatedAt", "Id" LIMIT 1 FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN RETURN; END IF;
    IF "dbo"."IsReportReassessable"(j."ReportId") THEN
      UPDATE "dbo"."AssessmentRegenerationJobs"
         SET "Status" = 'PROCESSING', "AttemptCount" = "AttemptCount" + 1, "ClaimedAt" = now(), "ClaimedBy" = left(p_worker, 150)
       WHERE "Id" = j."Id";
      "JobId" := j."Id"; "ReportId" := j."ReportId"; "Attempt" := j."AttemptCount" + 1;
      RETURN NEXT; RETURN;
    END IF;
    UPDATE "dbo"."AssessmentRegenerationJobs"
       SET "Status" = 'SUPERSEDED', "FinishedAt" = now(), "LastError" = 'NOT_REASSESSABLE' WHERE "Id" = j."Id";
  END LOOP;
END $$;

-- Agent: call FIRST, in the same transaction as the assessment write. Locks the report (the review route locks it too,
-- so a review and a late result serialize). true = write allowed; false = discard (late attempt, cancelled, superseded,
-- human decision). With p_ok = false it records the failure instead; the report is never touched by a failure.
CREATE OR REPLACE FUNCTION "dbo"."FinishAssessmentRegeneration"(p_job uuid, p_attempt integer, p_ok boolean, p_error text)
RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE j record;
BEGIN
  -- Report first, then job: the same lock order as the review route (report FOR UPDATE → supersede trigger).
  PERFORM 1 FROM "dbo"."Reports" WHERE "Id" = (SELECT "ReportId" FROM "dbo"."AssessmentRegenerationJobs" WHERE "Id" = p_job) FOR UPDATE;
  SELECT * INTO j FROM "dbo"."AssessmentRegenerationJobs" WHERE "Id" = p_job FOR UPDATE;
  IF NOT FOUND OR j."Status" <> 'PROCESSING' OR j."AttemptCount" <> p_attempt THEN RETURN false; END IF;
  IF NOT "dbo"."IsReportReassessable"(j."ReportId") THEN
    UPDATE "dbo"."AssessmentRegenerationJobs"
       SET "Status" = 'SUPERSEDED', "FinishedAt" = now(), "LastError" = 'NOT_REASSESSABLE' WHERE "Id" = p_job;
    RETURN false;
  END IF;
  UPDATE "dbo"."AssessmentRegenerationJobs"
     SET "Status" = CASE WHEN p_ok THEN 'COMPLETED' ELSE 'FAILED' END, "FinishedAt" = now(),
         "LastError" = CASE WHEN p_ok THEN NULL ELSE left(p_error, 2000) END
   WHERE "Id" = p_job;
  RETURN true;
END $$;

-- Agent startup / periodic: a PROCESSING job whose Agent died goes back to PENDING (FAILED after 3 attempts).
CREATE OR REPLACE FUNCTION "dbo"."RequeueStaleAssessmentRegenerations"(p_minutes integer)
RETURNS integer
LANGUAGE sql AS $$
  WITH s AS (
    UPDATE "dbo"."AssessmentRegenerationJobs"
       SET "Status" = CASE WHEN "AttemptCount" >= 3 THEN 'FAILED' ELSE 'PENDING' END,
           "FinishedAt" = CASE WHEN "AttemptCount" >= 3 THEN now() END,
           "LastError" = 'STALE_CLAIM'
     WHERE "Status" = 'PROCESSING' AND "ClaimedAt" < now() - make_interval(mins => p_minutes)
    RETURNING 1)
  SELECT count(*)::int FROM s
$$;

-- Worker: claim due reminders, plus PROCESSING ones whose lease expired (Worker outage recovery). Reminders for
-- recipients that are inactive or REPORTER are cancelled instead of delivered.
CREATE OR REPLACE FUNCTION "dbo"."ClaimDueAssistantReminders"(p_worker text, p_batch integer, p_lease_seconds integer)
RETURNS SETOF "dbo"."AssistantReminders"
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "dbo"."AssistantReminders" r
     SET "Status" = 'CANCELLED', "CancelledAt" = now(), "LastError" = 'RECIPIENT_INACTIVE'
    FROM "dbo"."Users" u
   WHERE u."Id" = r."RecipientUserId" AND (NOT u."IsActive" OR u."Role" = 'REPORTER')
     AND r."Status" IN ('SCHEDULED','PROCESSING') AND r."NextRunAt" <= now();
  RETURN QUERY
  UPDATE "dbo"."AssistantReminders" r
     SET "Status" = 'PROCESSING', "Attempts" = r."Attempts" + 1, "ClaimedAt" = now(), "ClaimedBy" = left(p_worker, 150)
   WHERE r."Id" IN (
     SELECT x."Id" FROM "dbo"."AssistantReminders" x
      WHERE (x."Status" = 'SCHEDULED' AND x."NextRunAt" <= now())
         OR (x."Status" = 'PROCESSING' AND x."ClaimedAt" < now() - make_interval(secs => p_lease_seconds))
      ORDER BY x."NextRunAt", x."Id"
      LIMIT greatest(1, least(p_batch, 500))
      FOR UPDATE SKIP LOCKED)
  RETURNING r.*;
END $$;

-- Worker: call in the SAME transaction as createNotification. false = cancelled or re-claimed meanwhile → roll back.
-- Failure: retry with backoff 2^attempts minutes (max 60), FAILED after 5 attempts.
CREATE OR REPLACE FUNCTION "dbo"."FinishAssistantReminder"(p_id uuid, p_attempt integer, p_ok boolean, p_error text, p_notification uuid)
RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "dbo"."AssistantReminders"
     SET "Status" = CASE WHEN p_ok THEN 'SENT' WHEN "Attempts" >= 5 THEN 'FAILED' ELSE 'SCHEDULED' END,
         "SentAt" = CASE WHEN p_ok THEN now() END,
         "NotificationId" = CASE WHEN p_ok THEN p_notification END,
         "LastError" = CASE WHEN p_ok THEN NULL ELSE left(p_error, 2000) END,
         "NextRunAt" = CASE WHEN p_ok THEN "NextRunAt" ELSE now() + make_interval(mins => least(60, power(2, "Attempts")::int)) END
   WHERE "Id" = p_id AND "Status" = 'PROCESSING' AND "Attempts" = p_attempt;
  RETURN FOUND;
END $$;

COMMIT;
