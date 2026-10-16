-- Rollback of 2026-10-16-v2-workflow-assistant.sql. Removes assistant drafts, reassessment jobs and reminders with their
-- functions and triggers. Reports, reviews, assessments (ReportAssessmentHistory) and Notifications already delivered are
-- untouched. Take a backup first if pending reminders or drafts should be kept.
SET client_min_messages = warning;
BEGIN;
DROP TRIGGER IF EXISTS "TR_Reports_SupersedeReassessment" ON "dbo"."Reports";
DROP TRIGGER IF EXISTS "TR_MaintenanceReviews_SupersedeReassessment" ON "dbo"."MaintenanceReviews";
DROP FUNCTION IF EXISTS "dbo"."SupersedeReassessmentOnReportStatus"();
DROP FUNCTION IF EXISTS "dbo"."SupersedeReassessmentOnReview"();
DROP FUNCTION IF EXISTS "dbo"."SupersedeReassessmentJobs"(uuid, text);
DROP FUNCTION IF EXISTS "dbo"."ClaimNextAssessmentRegeneration"(text);
DROP FUNCTION IF EXISTS "dbo"."FinishAssessmentRegeneration"(uuid, integer, boolean, text);
DROP FUNCTION IF EXISTS "dbo"."RequeueStaleAssessmentRegenerations"(integer);
DROP FUNCTION IF EXISTS "dbo"."IsReportReassessable"(uuid);
DROP FUNCTION IF EXISTS "dbo"."ClaimDueAssistantReminders"(text, integer, integer);
DROP FUNCTION IF EXISTS "dbo"."FinishAssistantReminder"(uuid, integer, boolean, text, uuid);
DROP TABLE IF EXISTS "dbo"."AssistantReminders";
DROP TABLE IF EXISTS "dbo"."AssessmentRegenerationJobs";
DROP TABLE IF EXISTS "dbo"."AssistantDrafts";
COMMIT;
