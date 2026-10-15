-- SEEFIX baseline: the dbo schema as of the 2026-10-13 backup (seefix-db/seefix-dbo-2026-10-13.sql),
-- generated with pg_dump --schema-only --no-owner --no-privileges, plus reference/setup data only
-- (Buildings, DamageCategories, SystemSettings). No users, reports or other personal/transactional data.
--
-- Runs only on an EMPTY database. On a database that already has dbo tables, scripts/database/migrate.js
-- records this file as "adopted" without running it (see db/README.md, "Adoption").
-- Never edit this file: its checksum is recorded. Change the schema with a new migration instead.
--
-- PostgreSQL database dump
--


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: dbo; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS dbo;


--
-- Name: AdvanceReportAfterAgentAssessment(); Type: FUNCTION; Schema: dbo; Owner: -
--

CREATE FUNCTION dbo."AdvanceReportAfterAgentAssessment"() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF OLD."AgentStatus" IS DISTINCT FROM NEW."AgentStatus"
       AND NEW."AgentStatus"='COMPLETED'
       AND NEW."Status"='SUBMITTED'
    THEN
        NEW."Status" := 'PENDING_REVIEW';
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: ApplyCompletedMaintenanceReview(); Type: FUNCTION; Schema: dbo; Owner: -
--

CREATE FUNCTION dbo."ApplyCompletedMaintenanceReview"() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_report_status VARCHAR(40);
    v_request_status VARCHAR(40);
BEGIN
    IF NEW."Status" <> 'COMPLETED' THEN
        RETURN NEW;
    END IF;

    CASE NEW."Decision"
        WHEN 'INTERNAL' THEN
            v_report_status := 'ROUTED_INTERNAL';
            v_request_status := 'ROUTED_INTERNAL';
        WHEN 'PROCUREMENT' THEN
            v_report_status := 'PROCUREMENT';
            v_request_status := 'REVIEWED';
        WHEN 'NO_ACTION' THEN
            v_report_status := 'NO_ACTION';
            v_request_status := 'CANCELLED';
        WHEN 'DUPLICATE' THEN
            v_report_status := 'DUPLICATE';
            v_request_status := 'CANCELLED';
        ELSE
            RAISE EXCEPTION 'Unsupported Maintenance Review decision: %', NEW."Decision";
    END CASE;

    UPDATE "dbo"."Reports"
       SET "FinalCategory" = COALESCE(NEW."FinalCategory","FinalCategory"),
           "FinalUrgency" = COALESCE(NEW."FinalUrgency","FinalUrgency"),
           "OverrideReason" = NEW."OverrideReason",
           "ReviewedBy" = NEW."ReviewedBy",
           "ReviewedAt" = NEW."ReviewedAt",
           "Status" = v_report_status
     WHERE "Id" = NEW."ReportId";

    IF NEW."MaintenanceRequestId" IS NOT NULL THEN
        UPDATE "dbo"."MaintenanceRequests"
           SET "EffectiveCategory" = COALESCE(NEW."FinalCategory","EffectiveCategory"),
               "EffectiveUrgency" = COALESCE(NEW."FinalUrgency","EffectiveUrgency"),
               "Status" = v_request_status,
               "AuthorizedBy" = NEW."ReviewedBy",
               "AuthorizedAt" = NEW."ReviewedAt"
         WHERE "Id" = NEW."MaintenanceRequestId";
    END IF;

    RETURN NEW;
END;
$$;


--
-- Name: ClaimNextPendingCompletionWorkOrder(text); Type: FUNCTION; Schema: dbo; Owner: -
--

CREATE FUNCTION dbo."ClaimNextPendingCompletionWorkOrder"(p_worker_name text) RETURNS TABLE("Id" uuid, "WorkOrderNo" character varying, "CompletionAgentAttemptCount" integer)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    WITH candidate AS
    (
        SELECT wo."Id"
          FROM "dbo"."WorkOrders" wo
         WHERE wo."Status"='COMPLETION_SUBMITTED'
           AND wo."CompletionAgentStatus"='PENDING'
         ORDER BY wo."CompletionSubmittedAt" ASC NULLS LAST, wo."CreatedAt" ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
    )
    UPDATE "dbo"."WorkOrders" wo
       SET "CompletionAgentStatus"='PROCESSING',
           "CompletionAgentClaimedAt"=NOW(),
           "CompletionAgentClaimedBy"=p_worker_name,
           "CompletionAgentStartedAt"=NOW(),
           "CompletionAgentCompletedAt"=NULL,
           "CompletionAgentAttemptCount"=wo."CompletionAgentAttemptCount"+1,
           "CompletionAgentLastError"=NULL
      FROM candidate c
     WHERE wo."Id"=c."Id"
    RETURNING wo."Id",wo."WorkOrderNo",wo."CompletionAgentAttemptCount";
END;
$$;


--
-- Name: ClaimNextPendingReport(text); Type: FUNCTION; Schema: dbo; Owner: -
--

CREATE FUNCTION dbo."ClaimNextPendingReport"(p_worker_name text) RETURNS TABLE("Id" uuid, "ReportNo" character varying, "AgentAttemptCount" integer)
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN QUERY
  WITH candidate AS (
    SELECT r."Id" FROM "dbo"."Reports" r
     WHERE r."AgentStatus"='PENDING' AND r."Status"='SUBMITTED'
       AND (r."AgentNextRetryAt" IS NULL OR r."AgentNextRetryAt" <= NOW())
     ORDER BY r."CreatedAt" ASC
     LIMIT 1 FOR UPDATE SKIP LOCKED
  )
  UPDATE "dbo"."Reports" r
     SET "AgentStatus"='PROCESSING', "AgentClaimedAt"=NOW(),
         "AgentClaimedBy"=p_worker_name, "AgentStartedAt"=NOW(),
         "AgentCompletedAt"=NULL, "AgentAttemptCount"=r."AgentAttemptCount"+1,
         "AgentLastError"=NULL, "AgentNextRetryAt"=NULL
    FROM candidate c
   WHERE r."Id"=c."Id" AND r."Status"='SUBMITTED' AND r."AgentStatus"='PENDING'
  RETURNING r."Id", r."ReportNo", r."AgentAttemptCount";
END;
$$;


--
-- Name: ClaimReportForAgent(uuid, text); Type: FUNCTION; Schema: dbo; Owner: -
--

CREATE FUNCTION dbo."ClaimReportForAgent"(p_report_id uuid, p_worker_name text) RETURNS TABLE("Id" uuid, "ReportNo" character varying, "AgentAttemptCount" integer)
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN QUERY
  UPDATE "dbo"."Reports" r
     SET "AgentStatus"='PROCESSING', "AgentClaimedAt"=NOW(),
         "AgentClaimedBy"=p_worker_name, "AgentStartedAt"=NOW(),
         "AgentCompletedAt"=NULL, "AgentAttemptCount"=r."AgentAttemptCount"+1,
         "AgentLastError"=NULL, "AgentNextRetryAt"=NULL
   WHERE r."Id"=p_report_id AND r."Status"='SUBMITTED'
     AND r."AgentStatus" IN ('PENDING','FAILED')
  RETURNING r."Id", r."ReportNo", r."AgentAttemptCount";
END;
$$;


--
-- Name: CurrentAppUserId(); Type: FUNCTION; Schema: dbo; Owner: -
--

CREATE FUNCTION dbo."CurrentAppUserId"() RETURNS uuid
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    v_user_id TEXT;
BEGIN
    v_user_id := NULLIF(current_setting('app.user_id', true), '');
    IF v_user_id IS NULL THEN
        RETURN NULL;
    END IF;
    RETURN v_user_id::UUID;
EXCEPTION
    WHEN OTHERS THEN
        RETURN NULL;
END;
$$;


--
-- Name: EnsureProcurementHandoffRoute(); Type: FUNCTION; Schema: dbo; Owner: -
--

CREATE FUNCTION dbo."EnsureProcurementHandoffRoute"() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_decision VARCHAR(30);
    v_report_id UUID;
BEGIN
    SELECT mr."Decision", mr."ReportId"
      INTO v_decision, v_report_id
      FROM "dbo"."MaintenanceReviews" mr
     WHERE mr."Id" = NEW."MaintenanceReviewId";

    IF v_decision <> 'PROCUREMENT' THEN
        RAISE EXCEPTION 'Procurement handoff requires Maintenance Review decision PROCUREMENT.';
    END IF;

    IF NOT EXISTS
    (
        SELECT 1
          FROM "dbo"."MaintenanceReviews" mr
         WHERE mr."Id"=NEW."MaintenanceReviewId"
           AND mr."MaintenanceRequestId"=NEW."MaintenanceRequestId"
           AND mr."Status"='COMPLETED'
    ) THEN
        RAISE EXCEPTION 'Procurement handoff must reference the completed review for the same Maintenance Request.';
    END IF;

    RETURN NEW;
END;
$$;


--
-- Name: EnsureProcurementOutcomeConsistency(); Type: FUNCTION; Schema: dbo; Owner: -
--

CREATE FUNCTION dbo."EnsureProcurementOutcomeConsistency"() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NOT EXISTS
    (
        SELECT 1
          FROM "dbo"."ProcurementHandoffs" ph
          JOIN "dbo"."MaintenanceReviews" rv ON rv."Id"=ph."MaintenanceReviewId"
         WHERE ph."Id"=NEW."ProcurementHandoffId"
           AND ph."MaintenanceRequestId"=NEW."MaintenanceRequestId"
           AND ph."Status"='COMPLETED'
           AND rv."Decision"='PROCUREMENT'
           AND rv."Status"='COMPLETED'
    ) THEN
        RAISE EXCEPTION 'Procurement Outcome requires the matching completed Procurement handoff and completed PROCUREMENT Maintenance Review.';
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: EnsureReportHasImageFromImage(); Type: FUNCTION; Schema: dbo; Owner: -
--

CREATE FUNCTION dbo."EnsureReportHasImageFromImage"() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_report_id UUID := COALESCE(NEW."ReportId", OLD."ReportId");
BEGIN
    IF EXISTS (SELECT 1 FROM "dbo"."Reports" r WHERE r."Id"=v_report_id)
       AND NOT EXISTS (SELECT 1 FROM "dbo"."ReportImages" ri WHERE ri."ReportId"=v_report_id)
    THEN
        RAISE EXCEPTION 'Report % requires at least one image.', v_report_id;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: EnsureReportHasImageFromReport(); Type: FUNCTION; Schema: dbo; Owner: -
--

CREATE FUNCTION dbo."EnsureReportHasImageFromReport"() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NOT EXISTS
    (
        SELECT 1 FROM "dbo"."ReportImages" ri WHERE ri."ReportId" = NEW."Id"
    ) THEN
        RAISE EXCEPTION 'Report % requires at least one image.', NEW."Id";
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: EnsureWorkOrderHasCompletionEvidenceFromImage(); Type: FUNCTION; Schema: dbo; Owner: -
--

CREATE FUNCTION dbo."EnsureWorkOrderHasCompletionEvidenceFromImage"() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_work_order_id UUID := COALESCE(NEW."WorkOrderId", OLD."WorkOrderId");
BEGIN
    IF EXISTS
       (
           SELECT 1 FROM "dbo"."WorkOrders" wo
            WHERE wo."Id"=v_work_order_id
              AND wo."Status" IN ('COMPLETION_SUBMITTED','COMPLETED')
       )
       AND NOT EXISTS
       (
           SELECT 1 FROM "dbo"."WorkOrderImages" woi
            WHERE woi."WorkOrderId"=v_work_order_id
              AND woi."ImageType"='COMPLETION'
       )
    THEN
        RAISE EXCEPTION 'WorkOrder % requires at least one COMPLETION image.', v_work_order_id;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: EnsureWorkOrderHasCompletionEvidenceFromWorkOrder(); Type: FUNCTION; Schema: dbo; Owner: -
--

CREATE FUNCTION dbo."EnsureWorkOrderHasCompletionEvidenceFromWorkOrder"() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW."Status" IN ('COMPLETION_SUBMITTED','COMPLETED')
       AND NOT EXISTS
       (
           SELECT 1
             FROM "dbo"."WorkOrderImages" woi
            WHERE woi."WorkOrderId"=NEW."Id"
              AND woi."ImageType"='COMPLETION'
       )
    THEN
        RAISE EXCEPTION 'WorkOrder % requires at least one COMPLETION image.', NEW."Id";
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: EnsureWorkOrderRouteConsistency(); Type: FUNCTION; Schema: dbo; Owner: -
--

CREATE FUNCTION dbo."EnsureWorkOrderRouteConsistency"() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_decision VARCHAR(30);
    v_review_report UUID;
    v_review_request UUID;
    v_outcome_request UUID;
BEGIN
    SELECT mr."Decision", mr."ReportId", mr."MaintenanceRequestId"
      INTO v_decision, v_review_report, v_review_request
      FROM "dbo"."MaintenanceReviews" mr
     WHERE mr."Id" = NEW."MaintenanceReviewId"
       AND mr."Status"='COMPLETED';

    IF v_decision IS NULL THEN
        RAISE EXCEPTION 'Work Order requires a completed Maintenance Review.';
    END IF;

    IF v_review_report <> NEW."ReportId" OR v_review_request <> NEW."MaintenanceRequestId" THEN
        RAISE EXCEPTION 'Work Order Report/Maintenance Request do not match the Maintenance Review.';
    END IF;

    IF NEW."RouteType"='INTERNAL' THEN
        IF v_decision <> 'INTERNAL' THEN
            RAISE EXCEPTION 'INTERNAL Work Order requires Maintenance Review decision INTERNAL.';
        END IF;
        IF NEW."ProcurementOutcomeId" IS NOT NULL THEN
            RAISE EXCEPTION 'INTERNAL Work Order must not reference a Procurement Outcome.';
        END IF;
    ELSE
        IF v_decision <> 'PROCUREMENT' THEN
            RAISE EXCEPTION 'PROCUREMENT Work Order requires Maintenance Review decision PROCUREMENT.';
        END IF;
        SELECT po."MaintenanceRequestId"
          INTO v_outcome_request
          FROM "dbo"."ProcurementOutcomes" po
         WHERE po."Id"=NEW."ProcurementOutcomeId";
        IF v_outcome_request IS NULL OR v_outcome_request <> NEW."MaintenanceRequestId" THEN
            RAISE EXCEPTION 'PROCUREMENT Work Order must reference the matching Procurement Outcome.';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;


--
-- Name: GenerateMaintenanceRequestNo(); Type: FUNCTION; Schema: dbo; Owner: -
--

CREATE FUNCTION dbo."GenerateMaintenanceRequestNo"() RETURNS character varying
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_year TEXT := TO_CHAR(CURRENT_DATE, 'YYYY');
    v_next INTEGER;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('SEEFIX:MR:' || v_year));
    SELECT COALESCE(MAX(RIGHT("RequestNo", 6)::INTEGER), 0) + 1
      INTO v_next
      FROM "dbo"."MaintenanceRequests"
     WHERE "RequestNo" LIKE 'MR-' || v_year || '-%';
    RETURN 'MR-' || v_year || '-' || LPAD(v_next::TEXT, 6, '0');
END;
$$;


--
-- Name: GenerateProcurementHandoffNo(); Type: FUNCTION; Schema: dbo; Owner: -
--

CREATE FUNCTION dbo."GenerateProcurementHandoffNo"() RETURNS character varying
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_year TEXT := TO_CHAR(CURRENT_DATE, 'YYYY');
    v_next INTEGER;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('SEEFIX:PH:' || v_year));
    SELECT COALESCE(MAX(RIGHT("HandoffNo", 6)::INTEGER), 0) + 1
      INTO v_next
      FROM "dbo"."ProcurementHandoffs"
     WHERE "HandoffNo" LIKE 'PH-' || v_year || '-%';
    RETURN 'PH-' || v_year || '-' || LPAD(v_next::TEXT, 6, '0');
END;
$$;


--
-- Name: GenerateReportNo(); Type: FUNCTION; Schema: dbo; Owner: -
--

CREATE FUNCTION dbo."GenerateReportNo"() RETURNS character varying
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_year TEXT := TO_CHAR(CURRENT_DATE, 'YYYY');
    v_next INTEGER;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('SEEFIX:RPT:' || v_year));
    SELECT COALESCE(MAX(RIGHT("ReportNo", 6)::INTEGER), 0) + 1
      INTO v_next
      FROM "dbo"."Reports"
     WHERE "ReportNo" LIKE 'RPT-' || v_year || '-%';
    RETURN 'RPT-' || v_year || '-' || LPAD(v_next::TEXT, 6, '0');
END;
$$;


--
-- Name: GenerateWorkOrderNo(); Type: FUNCTION; Schema: dbo; Owner: -
--

CREATE FUNCTION dbo."GenerateWorkOrderNo"() RETURNS character varying
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_year TEXT := TO_CHAR(CURRENT_DATE, 'YYYY');
    v_next INTEGER;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('SEEFIX:WO:' || v_year));
    SELECT COALESCE(MAX(RIGHT("WorkOrderNo", 6)::INTEGER), 0) + 1
      INTO v_next
      FROM "dbo"."WorkOrders"
     WHERE "WorkOrderNo" LIKE 'WO-' || v_year || '-%';
    RETURN 'WO-' || v_year || '-' || LPAD(v_next::TEXT, 6, '0');
END;
$$;


--
-- Name: GuardCancelledReportMutation(); Type: FUNCTION; Schema: dbo; Owner: -
--

CREATE FUNCTION dbo."GuardCancelledReportMutation"() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD."Status" = 'CANCELLED' AND (
       NEW."Status" IS DISTINCT FROM OLD."Status"
       OR NEW."AgentStatus" IS DISTINCT FROM OLD."AgentStatus") THEN
    RAISE EXCEPTION 'Cancelled Report % cannot be reopened or reprocessed.', OLD."Id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: GuardLateMaintenanceDraft(); Type: FUNCTION; Schema: dbo; Owner: -
--

CREATE FUNCTION dbo."GuardLateMaintenanceDraft"() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_status TEXT;
BEGIN
  IF NEW."Status" = 'DRAFT' THEN
    SELECT "Status" INTO v_status
    FROM "dbo"."Reports" WHERE "Id" = NEW."ReportId" FOR UPDATE;
    IF v_status IS DISTINCT FROM 'PENDING_REVIEW' THEN
      RAISE EXCEPTION 'Report % is not awaiting review; DRAFT is not allowed.', NEW."ReportId"
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: LogMaintenanceRequestStatusHistory(); Type: FUNCTION; Schema: dbo; Owner: -
--

CREATE FUNCTION dbo."LogMaintenanceRequestStatusHistory"() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP='INSERT' THEN
        INSERT INTO "dbo"."MaintenanceRequestStatusHistory"
        ("MaintenanceRequestId","OldStatus","NewStatus","ChangedBy")
        VALUES (NEW."Id",NULL,NEW."Status","dbo"."CurrentAppUserId"());
    ELSIF OLD."Status" IS DISTINCT FROM NEW."Status" THEN
        INSERT INTO "dbo"."MaintenanceRequestStatusHistory"
        ("MaintenanceRequestId","OldStatus","NewStatus","ChangedBy")
        VALUES (NEW."Id",OLD."Status",NEW."Status","dbo"."CurrentAppUserId"());
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: LogMaintenanceReviewStatusHistory(); Type: FUNCTION; Schema: dbo; Owner: -
--

CREATE FUNCTION dbo."LogMaintenanceReviewStatusHistory"() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP='INSERT' THEN
        INSERT INTO "dbo"."MaintenanceReviewStatusHistory"
        ("MaintenanceReviewId","OldStatus","NewStatus","DecisionSnapshot","ChangedBy")
        VALUES (NEW."Id",NULL,NEW."Status",NEW."Decision","dbo"."CurrentAppUserId"());
    ELSIF OLD."Status" IS DISTINCT FROM NEW."Status" OR OLD."Decision" IS DISTINCT FROM NEW."Decision" THEN
        INSERT INTO "dbo"."MaintenanceReviewStatusHistory"
        ("MaintenanceReviewId","OldStatus","NewStatus","DecisionSnapshot","ChangedBy")
        VALUES (NEW."Id",OLD."Status",NEW."Status",NEW."Decision","dbo"."CurrentAppUserId"());
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: LogProcurementHandoffStatusHistory(); Type: FUNCTION; Schema: dbo; Owner: -
--

CREATE FUNCTION dbo."LogProcurementHandoffStatusHistory"() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP='INSERT' THEN
        INSERT INTO "dbo"."ProcurementHandoffStatusHistory"
        ("ProcurementHandoffId","OldStatus","NewStatus","ChangedBy")
        VALUES (NEW."Id",NULL,NEW."Status","dbo"."CurrentAppUserId"());
    ELSIF OLD."Status" IS DISTINCT FROM NEW."Status" THEN
        INSERT INTO "dbo"."ProcurementHandoffStatusHistory"
        ("ProcurementHandoffId","OldStatus","NewStatus","ChangedBy")
        VALUES (NEW."Id",OLD."Status",NEW."Status","dbo"."CurrentAppUserId"());
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: LogReportStatusHistory(); Type: FUNCTION; Schema: dbo; Owner: -
--

CREATE FUNCTION dbo."LogReportStatusHistory"() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_user_id UUID := "dbo"."CurrentAppUserId"();
BEGIN
    IF TG_OP='INSERT' THEN
        INSERT INTO "dbo"."ReportStatusHistory" ("ReportId","StatusType","OldStatus","NewStatus","ChangedBy")
        VALUES (NEW."Id",'REPORT',NULL,NEW."Status",v_user_id);
        INSERT INTO "dbo"."ReportStatusHistory" ("ReportId","StatusType","OldStatus","NewStatus","ChangedBy")
        VALUES (NEW."Id",'AGENT',NULL,NEW."AgentStatus",v_user_id);
        RETURN NEW;
    END IF;

    IF OLD."Status" IS DISTINCT FROM NEW."Status" THEN
        INSERT INTO "dbo"."ReportStatusHistory" ("ReportId","StatusType","OldStatus","NewStatus","ChangedBy")
        VALUES (NEW."Id",'REPORT',OLD."Status",NEW."Status",v_user_id);
    END IF;

    IF OLD."AgentStatus" IS DISTINCT FROM NEW."AgentStatus" THEN
        INSERT INTO "dbo"."ReportStatusHistory" ("ReportId","StatusType","OldStatus","NewStatus","ChangedBy")
        VALUES (NEW."Id",'AGENT',OLD."AgentStatus",NEW."AgentStatus",v_user_id);
    END IF;

    RETURN NEW;
END;
$$;


--
-- Name: LogWorkOrderAssignment(); Type: FUNCTION; Schema: dbo; Owner: -
--

CREATE FUNCTION dbo."LogWorkOrderAssignment"() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_has_assignment BOOLEAN;
BEGIN
    v_has_assignment :=
        NULLIF(BTRIM(COALESCE(NEW."AssignedPartyName",'')),'') IS NOT NULL
        OR NEW."ResponsibleLeadUserId" IS NOT NULL
        OR NULLIF(BTRIM(COALESCE(NEW."ResponsibleLeadName",'')),'') IS NOT NULL;

    IF TG_OP='INSERT' THEN
        IF v_has_assignment THEN
            INSERT INTO "dbo"."WorkOrderAssignments"
            ("WorkOrderId","AssignedPartyName","ResponsibleLeadUserId","ResponsibleLeadName","ResponsibleLeadContact","ResponsibleLeadEmail","AssignedBy","AssignedAt","Reason")
            VALUES
            (NEW."Id",NEW."AssignedPartyName",NEW."ResponsibleLeadUserId",NEW."ResponsibleLeadName",NEW."ResponsibleLeadContact",NEW."ResponsibleLeadEmail",COALESCE(NEW."AssignedBy","dbo"."CurrentAppUserId"()),COALESCE(NEW."AssignedAt",NOW()),'Initial assignment');
        END IF;
        RETURN NEW;
    END IF;

    IF OLD."AssignedPartyName" IS DISTINCT FROM NEW."AssignedPartyName"
       OR OLD."ResponsibleLeadUserId" IS DISTINCT FROM NEW."ResponsibleLeadUserId"
       OR OLD."ResponsibleLeadName" IS DISTINCT FROM NEW."ResponsibleLeadName"
       OR OLD."ResponsibleLeadContact" IS DISTINCT FROM NEW."ResponsibleLeadContact"
       OR OLD."ResponsibleLeadEmail" IS DISTINCT FROM NEW."ResponsibleLeadEmail"
    THEN
        INSERT INTO "dbo"."WorkOrderAssignments"
        ("WorkOrderId","AssignedPartyName","ResponsibleLeadUserId","ResponsibleLeadName","ResponsibleLeadContact","ResponsibleLeadEmail","AssignedBy","AssignedAt","Reason")
        VALUES
        (NEW."Id",NEW."AssignedPartyName",NEW."ResponsibleLeadUserId",NEW."ResponsibleLeadName",NEW."ResponsibleLeadContact",NEW."ResponsibleLeadEmail",COALESCE(NEW."AssignedBy","dbo"."CurrentAppUserId"()),COALESCE(NEW."AssignedAt",NOW()),'Assignment updated');
    END IF;

    RETURN NEW;
END;
$$;


--
-- Name: LogWorkOrderStatusHistory(); Type: FUNCTION; Schema: dbo; Owner: -
--

CREATE FUNCTION dbo."LogWorkOrderStatusHistory"() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP='INSERT' THEN
        INSERT INTO "dbo"."WorkOrderStatusHistory"
        ("WorkOrderId","OldStatus","NewStatus","ChangedBy")
        VALUES (NEW."Id",NULL,NEW."Status","dbo"."CurrentAppUserId"());
    ELSIF OLD."Status" IS DISTINCT FROM NEW."Status" THEN
        INSERT INTO "dbo"."WorkOrderStatusHistory"
        ("WorkOrderId","OldStatus","NewStatus","ChangedBy")
        VALUES (NEW."Id",OLD."Status",NEW."Status","dbo"."CurrentAppUserId"());
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: RefreshReportVerificationCount(); Type: FUNCTION; Schema: dbo; Owner: -
--

CREATE FUNCTION dbo."RefreshReportVerificationCount"() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_report_id UUID;
BEGIN
    v_report_id := COALESCE(NEW."ReportId", OLD."ReportId");

    UPDATE "dbo"."Reports" r
       SET "VerificationCount" =
       (
           SELECT COUNT(*)::INTEGER
             FROM "dbo"."ReportVerifications" rv
            WHERE rv."ReportId" = v_report_id
       )
     WHERE r."Id" = v_report_id;

    IF TG_OP='UPDATE' AND OLD."ReportId" IS DISTINCT FROM NEW."ReportId" THEN
        UPDATE "dbo"."Reports" r
           SET "VerificationCount" =
           (
               SELECT COUNT(*)::INTEGER
                 FROM "dbo"."ReportVerifications" rv
                WHERE rv."ReportId" = OLD."ReportId"
           )
         WHERE r."Id" = OLD."ReportId";
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: RequeueStaleAgentReports(integer); Type: FUNCTION; Schema: dbo; Owner: -
--

CREATE FUNCTION dbo."RequeueStaleAgentReports"(p_stale_minutes integer) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE v_count INTEGER;
BEGIN
  UPDATE "dbo"."Reports"
     SET "AgentStatus"='PENDING', "AgentClaimedAt"=NULL,
         "AgentClaimedBy"=NULL, "AgentStartedAt"=NULL,
         "AgentLastError"=COALESCE("AgentLastError" || E'\n', '') ||
            'Automatically requeued after stale PROCESSING claim.'
   WHERE "AgentStatus"='PROCESSING' AND "Status"='SUBMITTED'
     AND COALESCE("AgentStartedAt","AgentClaimedAt","UpdatedAt")
       < NOW() - make_interval(mins => GREATEST(p_stale_minutes,1));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;


--
-- Name: RequeueStaleCompletionAgentWorkOrders(integer); Type: FUNCTION; Schema: dbo; Owner: -
--

CREATE FUNCTION dbo."RequeueStaleCompletionAgentWorkOrders"(p_stale_minutes integer) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_count INTEGER;
BEGIN
    UPDATE "dbo"."WorkOrders"
       SET "CompletionAgentStatus"='PENDING',
           "CompletionAgentClaimedAt"=NULL,
           "CompletionAgentClaimedBy"=NULL,
           "CompletionAgentStartedAt"=NULL,
           "CompletionAgentLastError"=COALESCE("CompletionAgentLastError" || E'\n','') || 'Automatically requeued after stale completion-Agent claim.'
     WHERE "CompletionAgentStatus"='PROCESSING'
       AND COALESCE("CompletionAgentClaimedAt","CompletionAgentStartedAt") < NOW() - make_interval(mins => p_stale_minutes);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;


--
-- Name: SetUpdatedAt(); Type: FUNCTION; Schema: dbo; Owner: -
--

CREATE FUNCTION dbo."SetUpdatedAt"() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW."UpdatedAt" := NOW();
    RETURN NEW;
END;
$$;


--
-- Name: SyncProcurementHandoffState(); Type: FUNCTION; Schema: dbo; Owner: -
--

CREATE FUNCTION dbo."SyncProcurementHandoffState"() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_report_id UUID;
BEGIN
    SELECT mr."ReportId"
      INTO v_report_id
      FROM "dbo"."MaintenanceRequests" mr
     WHERE mr."Id"=NEW."MaintenanceRequestId";

    IF NEW."Status" IN ('SUBMITTED','ACKNOWLEDGED','IN_PROCESS','CLARIFICATION_REQUIRED') THEN
        UPDATE "dbo"."MaintenanceRequests"
           SET "Status"='SUBMITTED_TO_PROCUREMENT'
         WHERE "Id"=NEW."MaintenanceRequestId"
           AND "Status" IN ('REVIEWED','SUBMITTED_TO_PROCUREMENT');

        UPDATE "dbo"."Reports"
           SET "Status"='PROCUREMENT'
         WHERE "Id"=v_report_id
           AND "Status" NOT IN ('RESOLVED','CANCELLED','DUPLICATE','NO_ACTION');

    ELSIF NEW."Status"='COMPLETED' THEN
        UPDATE "dbo"."MaintenanceRequests"
           SET "Status"='PROCUREMENT_COMPLETED'
         WHERE "Id"=NEW."MaintenanceRequestId"
           AND "Status" <> 'WORK_ORDER_CREATED';
    END IF;

    RETURN NEW;
END;
$$;


--
-- Name: SyncReportAndRequestFromWorkOrder(); Type: FUNCTION; Schema: dbo; Owner: -
--

CREATE FUNCTION dbo."SyncReportAndRequestFromWorkOrder"() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_report_status VARCHAR(40);
BEGIN
    CASE NEW."Status"
        WHEN 'PENDING_ASSIGNMENT' THEN v_report_status := 'PENDING_ASSIGNMENT';
        WHEN 'ASSIGNED' THEN v_report_status := 'ASSIGNED';
        WHEN 'IN_PROGRESS' THEN v_report_status := 'IN_PROGRESS';
        WHEN 'PENDING_PARTS' THEN v_report_status := 'PENDING_PARTS';
        WHEN 'ON_HOLD' THEN v_report_status := 'ON_HOLD';
        WHEN 'COMPLETION_SUBMITTED' THEN v_report_status := 'COMPLETION_SUBMITTED';
        WHEN 'REWORK_REQUIRED' THEN v_report_status := 'REWORK_REQUIRED';
        WHEN 'COMPLETED' THEN v_report_status := 'RESOLVED';
        WHEN 'CANCELLED' THEN v_report_status := 'CANCELLED';
        ELSE RETURN NEW;
    END CASE;

    UPDATE "dbo"."Reports"
       SET "Status" = v_report_status,
           "ResolvedAt" = CASE WHEN NEW."Status"='COMPLETED' THEN NEW."ResolvedAt" ELSE "ResolvedAt" END
     WHERE "Id" = NEW."ReportId";

    UPDATE "dbo"."MaintenanceRequests"
       SET "Status" = 'WORK_ORDER_CREATED'
     WHERE "Id" = NEW."MaintenanceRequestId"
       AND "Status" <> 'WORK_ORDER_CREATED';

    RETURN NEW;
END;
$$;


--
-- Name: full_reset(); Type: PROCEDURE; Schema: dbo; Owner: -
--

CREATE PROCEDURE dbo.full_reset()
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Transactional + configurable data.
    -- Preserves only Users and SystemSettings as requested.
    TRUNCATE TABLE
        "dbo"."WorkOrderAssignments",
        "dbo"."WorkOrderPeople",
        "dbo"."WorkOrderMaterials",
        "dbo"."WorkOrderImages",
        "dbo"."WorkOrderUpdates",
        "dbo"."WorkOrderStatusHistory",
        "dbo"."WorkOrders",
        "dbo"."ProcurementDocuments",
        "dbo"."ProcurementClarifications",
        "dbo"."ProcurementHandoffStatusHistory",
        "dbo"."ProcurementOutcomes",
        "dbo"."ProcurementHandoffs",
        "dbo"."MaintenanceReviewStatusHistory",
        "dbo"."MaintenanceReviews",
        "dbo"."MaintenanceRequestSkills",
        "dbo"."MaintenanceRequestMaterials",
        "dbo"."MaintenanceRequestRevisions",
        "dbo"."MaintenanceRequestStatusHistory",
        "dbo"."MaintenanceRequests",
        "dbo"."ReportDuplicateCandidates",
        "dbo"."ReportVerifications",
        "dbo"."ReportAssessmentHistory",
        "dbo"."ReportImages",
        "dbo"."ReportStatusHistory",
        "dbo"."Reports",
        "dbo"."WorkflowActionItems",
        "dbo"."Notifications",
        "dbo"."OutboxEvents",
        "dbo"."AuditLogs",
        "dbo"."CategoryMaterialReferences",
        "dbo"."CategorySkillRequirements",
        "dbo"."FacilityLocations",
        "dbo"."Materials",
        "dbo"."Skills",
        "dbo"."DamageCategories",
        "dbo"."Buildings";
END;
$$;


--
-- Name: record_reset(); Type: PROCEDURE; Schema: dbo; Owner: -
--

CREATE PROCEDURE dbo.record_reset()
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Transactional/non-configurable records only.
    -- Preserves Users, SystemSettings, Buildings/FacilityLocations, DamageCategories,
    -- Skills, Materials, and category reference configuration.
    TRUNCATE TABLE
        "dbo"."WorkOrderAssignments",
        "dbo"."WorkOrderPeople",
        "dbo"."WorkOrderMaterials",
        "dbo"."WorkOrderImages",
        "dbo"."WorkOrderUpdates",
        "dbo"."WorkOrderStatusHistory",
        "dbo"."WorkOrders",
        "dbo"."ProcurementDocuments",
        "dbo"."ProcurementClarifications",
        "dbo"."ProcurementHandoffStatusHistory",
        "dbo"."ProcurementOutcomes",
        "dbo"."ProcurementHandoffs",
        "dbo"."MaintenanceReviewStatusHistory",
        "dbo"."MaintenanceReviews",
        "dbo"."MaintenanceRequestSkills",
        "dbo"."MaintenanceRequestMaterials",
        "dbo"."MaintenanceRequestRevisions",
        "dbo"."MaintenanceRequestStatusHistory",
        "dbo"."MaintenanceRequests",
        "dbo"."ReportDuplicateCandidates",
        "dbo"."ReportVerifications",
        "dbo"."ReportAssessmentHistory",
        "dbo"."ReportImages",
        "dbo"."ReportStatusHistory",
        "dbo"."Reports",
        "dbo"."WorkflowActionItems",
        "dbo"."Notifications",
        "dbo"."OutboxEvents",
        "dbo"."AuditLogs";
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: AuditLogs; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."AuditLogs" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "ActorUserId" uuid,
    "ActorType" character varying(30) DEFAULT 'USER'::character varying NOT NULL,
    "Action" character varying(150) NOT NULL,
    "EntityType" character varying(60),
    "EntityId" uuid,
    "OldData" jsonb,
    "NewData" jsonb,
    "Metadata" jsonb,
    "IpAddress" inet,
    "UserAgent" text,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: Buildings; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."Buildings" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "Code" character varying(60) NOT NULL,
    "Name" character varying(200) NOT NULL,
    "Description" text,
    "IsActive" boolean DEFAULT true NOT NULL,
    "SortOrder" integer DEFAULT 0 NOT NULL,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "UpdatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: CategoryMaterialReferences; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."CategoryMaterialReferences" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "CategoryId" uuid NOT NULL,
    "MaterialId" uuid NOT NULL,
    "DefaultQtyMin" numeric(12,3),
    "DefaultQtyMax" numeric(12,3),
    "IsCommon" boolean DEFAULT true NOT NULL,
    "Notes" text,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "CK_CategoryMaterialReferences_Qty" CHECK (((("DefaultQtyMin" IS NULL) OR ("DefaultQtyMin" >= (0)::numeric)) AND (("DefaultQtyMax" IS NULL) OR ("DefaultQtyMax" >= (0)::numeric)) AND (("DefaultQtyMin" IS NULL) OR ("DefaultQtyMax" IS NULL) OR ("DefaultQtyMax" >= "DefaultQtyMin"))))
);


--
-- Name: CategorySkillRequirements; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."CategorySkillRequirements" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "CategoryId" uuid NOT NULL,
    "SkillId" uuid NOT NULL,
    "MinimumProficiencyLevel" smallint,
    "IsRequired" boolean DEFAULT true NOT NULL,
    "IsLeadSkill" boolean DEFAULT false NOT NULL,
    "Notes" text,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "CK_CategorySkillRequirements_Level" CHECK ((("MinimumProficiencyLevel" IS NULL) OR (("MinimumProficiencyLevel" >= 1) AND ("MinimumProficiencyLevel" <= 5))))
);


--
-- Name: DamageCategories; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."DamageCategories" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "Code" character varying(60) NOT NULL,
    "Name" character varying(150) NOT NULL,
    "Description" text,
    "DefaultUrgency" character varying(20),
    "UrgencyGuidance" text,
    "DefaultMinHours" numeric(10,2),
    "DefaultMaxHours" numeric(10,2),
    "DefaultRequiredService" text,
    "DefaultRequiredCapability" text,
    "SafetyGuidance" text,
    "PreferredTrade" character varying(150),
    "RequiresMaintenanceReview" boolean DEFAULT false NOT NULL,
    "IsActive" boolean DEFAULT true NOT NULL,
    "SortOrder" integer DEFAULT 0 NOT NULL,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "UpdatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "CK_DamageCategories_DefaultUrgency" CHECK ((("DefaultUrgency" IS NULL) OR (("DefaultUrgency")::text = ANY (ARRAY[('Low'::character varying)::text, ('Medium'::character varying)::text, ('High'::character varying)::text, ('Critical'::character varying)::text])))),
    CONSTRAINT "CK_DamageCategories_Hours" CHECK (((("DefaultMinHours" IS NULL) OR ("DefaultMinHours" > (0)::numeric)) AND (("DefaultMaxHours" IS NULL) OR ("DefaultMaxHours" > (0)::numeric)) AND (("DefaultMinHours" IS NULL) OR ("DefaultMaxHours" IS NULL) OR ("DefaultMaxHours" >= "DefaultMinHours"))))
);


--
-- Name: FacilityLocations; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."FacilityLocations" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "BuildingId" uuid NOT NULL,
    "Floor" character varying(100),
    "RoomOrArea" character varying(200) NOT NULL,
    "LocationType" character varying(40) DEFAULT 'ROOM_OR_AREA'::character varying NOT NULL,
    "Code" character varying(100),
    "IsActive" boolean DEFAULT true NOT NULL,
    "Notes" text,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "UpdatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "CK_FacilityLocations_Type" CHECK ((("LocationType")::text = ANY (ARRAY[('ROOM'::character varying)::text, ('LABORATORY'::character varying)::text, ('OFFICE'::character varying)::text, ('HALLWAY'::character varying)::text, ('COMMON_AREA'::character varying)::text, ('OUTDOOR_AREA'::character varying)::text, ('ROOM_OR_AREA'::character varying)::text, ('OTHER'::character varying)::text])))
);


--
-- Name: MaintenanceRequestMaterials; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."MaintenanceRequestMaterials" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "MaintenanceRequestId" uuid NOT NULL,
    "MaterialId" uuid,
    "MaterialName" character varying(200) NOT NULL,
    "Unit" character varying(50),
    "QuantityMin" numeric(12,3),
    "QuantityMax" numeric(12,3),
    "IsPreliminary" boolean DEFAULT true NOT NULL,
    "Source" character varying(30) DEFAULT 'AGENT'::character varying NOT NULL,
    "Notes" text,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "CK_MaintenanceRequestMaterials_Qty" CHECK (((("QuantityMin" IS NULL) OR ("QuantityMin" >= (0)::numeric)) AND (("QuantityMax" IS NULL) OR ("QuantityMax" >= (0)::numeric)) AND (("QuantityMin" IS NULL) OR ("QuantityMax" IS NULL) OR ("QuantityMax" >= "QuantityMin"))))
);


--
-- Name: MaintenanceRequestRevisions; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."MaintenanceRequestRevisions" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "MaintenanceRequestId" uuid NOT NULL,
    "RevisionNo" integer NOT NULL,
    "Reason" text,
    "SnapshotJson" jsonb NOT NULL,
    "CreatedBy" uuid,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "CK_MaintenanceRequestRevisions_No" CHECK (("RevisionNo" >= 0))
);


--
-- Name: MaintenanceRequestSkills; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."MaintenanceRequestSkills" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "MaintenanceRequestId" uuid NOT NULL,
    "SkillId" uuid,
    "SkillName" character varying(180) NOT NULL,
    "MinimumProficiencyLevel" smallint,
    "IsRequired" boolean DEFAULT true NOT NULL,
    "IsLeadSkill" boolean DEFAULT false NOT NULL,
    "Source" character varying(30) DEFAULT 'AGENT'::character varying NOT NULL,
    "Notes" text,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "CK_MaintenanceRequestSkills_Level" CHECK ((("MinimumProficiencyLevel" IS NULL) OR (("MinimumProficiencyLevel" >= 1) AND ("MinimumProficiencyLevel" <= 5))))
);


--
-- Name: MaintenanceRequestStatusHistory; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."MaintenanceRequestStatusHistory" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "MaintenanceRequestId" uuid NOT NULL,
    "OldStatus" character varying(40),
    "NewStatus" character varying(40) NOT NULL,
    "ChangedBy" uuid,
    "Reason" text,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: MaintenanceRequests; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."MaintenanceRequests" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "RequestNo" character varying(30) DEFAULT dbo."GenerateMaintenanceRequestNo"() NOT NULL,
    "ReportId" uuid NOT NULL,
    "Status" character varying(40) DEFAULT 'DRAFT'::character varying NOT NULL,
    "EffectiveCategory" character varying(150) NOT NULL,
    "EffectiveUrgency" character varying(20) NOT NULL,
    "RequiredService" text NOT NULL,
    "RequiredCapability" text NOT NULL,
    "ScopeOfWork" text NOT NULL,
    "SafetyRequirements" text,
    "PreliminaryMaterialsNotes" text,
    "EstimatedLaborHoursMin" numeric(10,2),
    "EstimatedLaborHoursMax" numeric(10,2),
    "EstimatedManpowerMin" integer,
    "EstimatedManpowerMax" integer,
    "EstimatedDurationDaysMin" numeric(10,2),
    "EstimatedDurationDaysMax" numeric(10,2),
    "TargetStartAt" timestamp with time zone,
    "DesiredCompletionAt" timestamp with time zone,
    "AgentGenerated" boolean DEFAULT true NOT NULL,
    "AgentGeneratedAt" timestamp with time zone,
    "AgentModelId" character varying(200),
    "AgentPromptVersion" character varying(150),
    "AgentRecommendationJson" jsonb,
    "KnowledgeSnapshotJson" jsonb,
    "CurrentRevisionNo" integer DEFAULT 0 NOT NULL,
    "AuthorizedBy" uuid,
    "AuthorizedAt" timestamp with time zone,
    "LastRevisedAt" timestamp with time zone,
    "CreatedBy" uuid,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "UpdatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "CK_MaintenanceRequests_Estimates" CHECK (((("EstimatedLaborHoursMin" IS NULL) OR ("EstimatedLaborHoursMin" > (0)::numeric)) AND (("EstimatedLaborHoursMax" IS NULL) OR ("EstimatedLaborHoursMax" > (0)::numeric)) AND (("EstimatedLaborHoursMin" IS NULL) OR ("EstimatedLaborHoursMax" IS NULL) OR ("EstimatedLaborHoursMax" >= "EstimatedLaborHoursMin")) AND (("EstimatedManpowerMin" IS NULL) OR ("EstimatedManpowerMin" >= 1)) AND (("EstimatedManpowerMax" IS NULL) OR ("EstimatedManpowerMax" >= 1)) AND (("EstimatedManpowerMin" IS NULL) OR ("EstimatedManpowerMax" IS NULL) OR ("EstimatedManpowerMax" >= "EstimatedManpowerMin")) AND (("EstimatedDurationDaysMin" IS NULL) OR ("EstimatedDurationDaysMin" > (0)::numeric)) AND (("EstimatedDurationDaysMax" IS NULL) OR ("EstimatedDurationDaysMax" > (0)::numeric)) AND (("EstimatedDurationDaysMin" IS NULL) OR ("EstimatedDurationDaysMax" IS NULL) OR ("EstimatedDurationDaysMax" >= "EstimatedDurationDaysMin")))),
    CONSTRAINT "CK_MaintenanceRequests_Status" CHECK ((("Status")::text = ANY (ARRAY[('DRAFT'::character varying)::text, ('REVIEWED'::character varying)::text, ('ROUTED_INTERNAL'::character varying)::text, ('SUBMITTED_TO_PROCUREMENT'::character varying)::text, ('PROCUREMENT_COMPLETED'::character varying)::text, ('WORK_ORDER_CREATED'::character varying)::text, ('CANCELLED'::character varying)::text]))),
    CONSTRAINT "CK_MaintenanceRequests_Urgency" CHECK ((("EffectiveUrgency")::text = ANY (ARRAY[('Low'::character varying)::text, ('Medium'::character varying)::text, ('High'::character varying)::text, ('Critical'::character varying)::text])))
);


--
-- Name: TABLE "MaintenanceRequests"; Type: COMMENT; Schema: dbo; Owner: -
--

COMMENT ON TABLE dbo."MaintenanceRequests" IS 'AI-prepared maintenance action plan/request. Maintenance Review decides whether it routes directly to an internal Work Order or to Procurement.';


--
-- Name: COLUMN "MaintenanceRequests"."KnowledgeSnapshotJson"; Type: COMMENT; Schema: dbo; Owner: -
--

COMMENT ON COLUMN dbo."MaintenanceRequests"."KnowledgeSnapshotJson" IS 'Audit snapshot of bounded database knowledge used by the Agent; not a second source of truth.';


--
-- Name: MaintenanceReviewStatusHistory; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."MaintenanceReviewStatusHistory" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "MaintenanceReviewId" uuid NOT NULL,
    "OldStatus" character varying(20),
    "NewStatus" character varying(20) NOT NULL,
    "DecisionSnapshot" character varying(30),
    "ChangedBy" uuid,
    "Reason" text,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: MaintenanceReviews; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."MaintenanceReviews" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "ReportId" uuid NOT NULL,
    "MaintenanceRequestId" uuid,
    "Status" character varying(20) DEFAULT 'PENDING'::character varying NOT NULL,
    "Decision" character varying(30),
    "FinalCategory" character varying(150),
    "FinalUrgency" character varying(20),
    "PriorityScoreAtReview" integer,
    "OverrideReason" text,
    "DecisionReason" text,
    "Notes" text,
    "ReviewedBy" uuid,
    "ReviewedAt" timestamp with time zone,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "UpdatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "CK_MaintenanceReviews_Completed" CHECK (((("Status")::text <> 'COMPLETED'::text) OR (("Decision" IS NOT NULL) AND ("ReviewedBy" IS NOT NULL) AND ("ReviewedAt" IS NOT NULL) AND ((("Decision")::text = ANY (ARRAY[('NO_ACTION'::character varying)::text, ('DUPLICATE'::character varying)::text])) OR (("MaintenanceRequestId" IS NOT NULL) AND ("FinalCategory" IS NOT NULL) AND ("FinalUrgency" IS NOT NULL)))))),
    CONSTRAINT "CK_MaintenanceReviews_Decision" CHECK ((("Decision" IS NULL) OR (("Decision")::text = ANY (ARRAY[('INTERNAL'::character varying)::text, ('PROCUREMENT'::character varying)::text, ('NO_ACTION'::character varying)::text, ('DUPLICATE'::character varying)::text])))),
    CONSTRAINT "CK_MaintenanceReviews_Status" CHECK ((("Status")::text = ANY (ARRAY[('PENDING'::character varying)::text, ('COMPLETED'::character varying)::text, ('CANCELLED'::character varying)::text]))),
    CONSTRAINT "CK_MaintenanceReviews_Urgency" CHECK ((("FinalUrgency" IS NULL) OR (("FinalUrgency")::text = ANY (ARRAY[('Low'::character varying)::text, ('Medium'::character varying)::text, ('High'::character varying)::text, ('Critical'::character varying)::text]))))
);


--
-- Name: TABLE "MaintenanceReviews"; Type: COMMENT; Schema: dbo; Owner: -
--

COMMENT ON TABLE dbo."MaintenanceReviews" IS 'The human maintenance-office triage gate after AI prioritization. It records the final category/urgency and routes the work either INTERNAL, PROCUREMENT, NO_ACTION, or DUPLICATE.';


--
-- Name: Materials; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."Materials" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "Code" character varying(80) NOT NULL,
    "Name" character varying(180) NOT NULL,
    "Unit" character varying(50),
    "Description" text,
    "IsActive" boolean DEFAULT true NOT NULL,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "UpdatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: Notifications; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."Notifications" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "UserId" uuid NOT NULL,
    "Type" character varying(80) NOT NULL,
    "Title" character varying(250) NOT NULL,
    "Message" text NOT NULL,
    "EntityType" character varying(40),
    "EntityId" uuid,
    "Payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
    "IsRead" boolean DEFAULT false NOT NULL,
    "ReadAt" timestamp with time zone,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "UpdatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: OutboxEvents; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."OutboxEvents" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "AggregateType" character varying(50) NOT NULL,
    "AggregateId" uuid NOT NULL,
    "Transport" character varying(20) NOT NULL,
    "RecipientUserId" uuid,
    "ChannelName" character varying(250),
    "Destination" text,
    "EventName" character varying(150) NOT NULL,
    "Payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
    "DeduplicationKey" character varying(500),
    "Status" character varying(20) DEFAULT 'PENDING'::character varying NOT NULL,
    "AttemptCount" integer DEFAULT 0 NOT NULL,
    "NextAttemptAt" timestamp with time zone,
    "LastError" text,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "SentAt" timestamp with time zone,
    CONSTRAINT "CK_OutboxEvents_Attempts" CHECK (("AttemptCount" >= 0)),
    CONSTRAINT "CK_OutboxEvents_Status" CHECK ((("Status")::text = ANY (ARRAY[('PENDING'::character varying)::text, ('PROCESSING'::character varying)::text, ('SENT'::character varying)::text, ('FAILED'::character varying)::text, ('CANCELLED'::character varying)::text]))),
    CONSTRAINT "CK_OutboxEvents_Transport" CHECK ((("Transport")::text = ANY (ARRAY[('PUSHER'::character varying)::text, ('EMAIL'::character varying)::text, ('INTERNAL'::character varying)::text])))
);


--
-- Name: ProcurementClarifications; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."ProcurementClarifications" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "ProcurementHandoffId" uuid NOT NULL,
    "Question" text NOT NULL,
    "AskedByUserId" uuid,
    "AskedByName" character varying(200),
    "AskedByEmail" character varying(320),
    "AskedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "Status" character varying(20) DEFAULT 'OPEN'::character varying NOT NULL,
    "AiResponseDraft" text,
    "AiDraftJson" jsonb,
    "Response" text,
    "AnsweredBy" uuid,
    "AnsweredAt" timestamp with time zone,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "UpdatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "CK_ProcurementClarifications_Status" CHECK ((("Status")::text = ANY (ARRAY[('OPEN'::character varying)::text, ('ANSWERED'::character varying)::text, ('CANCELLED'::character varying)::text])))
);


--
-- Name: ProcurementDocuments; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."ProcurementDocuments" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "ProcurementHandoffId" uuid NOT NULL,
    "ClarificationId" uuid,
    "DocumentType" character varying(40) NOT NULL,
    "StorageProvider" character varying(50),
    "PublicId" character varying(500),
    "SecureUrl" text NOT NULL,
    "FileName" character varying(255),
    "MimeType" character varying(150),
    "Bytes" bigint,
    "UploadedBy" uuid,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ProcurementHandoffStatusHistory; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."ProcurementHandoffStatusHistory" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "ProcurementHandoffId" uuid NOT NULL,
    "OldStatus" character varying(40),
    "NewStatus" character varying(40) NOT NULL,
    "ChangedBy" uuid,
    "Reason" text,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ProcurementHandoffs; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."ProcurementHandoffs" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "HandoffNo" character varying(30) DEFAULT dbo."GenerateProcurementHandoffNo"() NOT NULL,
    "MaintenanceRequestId" uuid NOT NULL,
    "MaintenanceReviewId" uuid NOT NULL,
    "SubmittedRevisionId" uuid,
    "Status" character varying(40) DEFAULT 'SUBMITTED'::character varying NOT NULL,
    "ToEmails" text[] DEFAULT ARRAY[]::text[] NOT NULL,
    "CcEmails" text[] DEFAULT ARRAY[]::text[] NOT NULL,
    "EmailSubject" text,
    "EmailMessage" text,
    "PackageGeneratedAt" timestamp with time zone,
    "PackageDocumentUrl" text,
    "PackageVersion" integer DEFAULT 1 NOT NULL,
    "RequestSnapshotJson" jsonb DEFAULT '{}'::jsonb NOT NULL,
    "SubmittedBy" uuid,
    "SubmittedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "AcknowledgedBy" uuid,
    "AcknowledgedAt" timestamp with time zone,
    "ExpectedResponseAt" timestamp with time zone,
    "LastFollowUpAt" timestamp with time zone,
    "NextFollowUpAt" timestamp with time zone,
    "ExternalSystemReference" character varying(200),
    "ExternalSystemUrl" text,
    "CompletedBy" uuid,
    "CompletedAt" timestamp with time zone,
    "Notes" text,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "UpdatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "CK_ProcurementHandoffs_PackageVersion" CHECK (("PackageVersion" >= 1)),
    CONSTRAINT "CK_ProcurementHandoffs_Status" CHECK ((("Status")::text = ANY (ARRAY[('SUBMITTED'::character varying)::text, ('ACKNOWLEDGED'::character varying)::text, ('IN_PROCESS'::character varying)::text, ('CLARIFICATION_REQUIRED'::character varying)::text, ('COMPLETED'::character varying)::text, ('CANCELLED'::character varying)::text])))
);


--
-- Name: TABLE "ProcurementHandoffs"; Type: COMMENT; Schema: dbo; Owner: -
--

COMMENT ON TABLE dbo."ProcurementHandoffs" IS 'SEEFIX-to-UC Procurement bridge used only when Maintenance Review chooses PROCUREMENT. Bidding/provider selection remains outside SEEFIX.';


--
-- Name: COLUMN "ProcurementHandoffs"."RequestSnapshotJson"; Type: COMMENT; Schema: dbo; Owner: -
--

COMMENT ON COLUMN dbo."ProcurementHandoffs"."RequestSnapshotJson" IS 'Frozen snapshot of the maintenance request sent to Procurement.';


--
-- Name: ProcurementOutcomes; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."ProcurementOutcomes" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "ProcurementHandoffId" uuid NOT NULL,
    "MaintenanceRequestId" uuid NOT NULL,
    "ProcurementReferenceNo" character varying(200),
    "ExecutionType" character varying(30) NOT NULL,
    "AssignedPartyName" character varying(250) NOT NULL,
    "ResponsibleLeadUserId" uuid,
    "ResponsibleLeadName" character varying(200),
    "ResponsibleLeadContact" character varying(100),
    "ResponsibleLeadEmail" character varying(320),
    "PlannedStartAt" timestamp with time zone,
    "AgreedDurationDays" numeric(10,2),
    "PlannedDeadlineAt" timestamp with time zone,
    "PlannedCrewSize" integer,
    "ReferenceDocumentId" uuid,
    "Notes" text,
    "RecordedBy" uuid NOT NULL,
    "RecordedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "UpdatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "CK_ProcurementOutcomes_DurationCrew" CHECK (((("AgreedDurationDays" IS NULL) OR ("AgreedDurationDays" > (0)::numeric)) AND (("PlannedCrewSize" IS NULL) OR ("PlannedCrewSize" >= 1)) AND (("PlannedDeadlineAt" IS NULL) OR ("PlannedStartAt" IS NULL) OR ("PlannedDeadlineAt" >= "PlannedStartAt")))),
    CONSTRAINT "CK_ProcurementOutcomes_ExecutionType" CHECK ((("ExecutionType")::text = ANY (ARRAY[('INTERNAL'::character varying)::text, ('AGENCY'::character varying)::text, ('CONTRACTOR'::character varying)::text, ('INDIVIDUAL'::character varying)::text, ('GROUP'::character varying)::text, ('OTHER'::character varying)::text]))),
    CONSTRAINT "CK_ProcurementOutcomes_Lead" CHECK ((("ResponsibleLeadUserId" IS NOT NULL) OR (NULLIF(btrim(("ResponsibleLeadName")::text), ''::text) IS NOT NULL)))
);


--
-- Name: ReportAssessmentHistory; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."ReportAssessmentHistory" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "ReportId" uuid NOT NULL,
    "AgentAttemptCount" integer NOT NULL,
    "AnalysisStatus" character varying(30),
    "ScopeDecision" character varying(60),
    "AiCategory" character varying(150),
    "AiRawRecommendedUrgency" character varying(20),
    "AiRecommendedUrgency" character varying(20),
    "PriorityScore" integer,
    "AiProvider" character varying(100),
    "AiModelId" character varying(200),
    "AiPromptVersion" character varying(150),
    "AiPolicyVersion" character varying(100),
    "AssessmentJson" jsonb,
    "ProcessingTimeMs" integer,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ReportDuplicateCandidates; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."ReportDuplicateCandidates" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "SourceReportId" uuid NOT NULL,
    "CandidateReportId" uuid NOT NULL,
    "MatchMethod" character varying(60) DEFAULT 'LOCATION_CATEGORY'::character varying NOT NULL,
    "MatchScore" numeric(6,5),
    "MatchReason" text,
    "Status" character varying(20) DEFAULT 'PENDING'::character varying NOT NULL,
    "ReviewedBy" uuid,
    "ReviewedAt" timestamp with time zone,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "CK_ReportDuplicateCandidates_NotSelf" CHECK (("SourceReportId" <> "CandidateReportId")),
    CONSTRAINT "CK_ReportDuplicateCandidates_Status" CHECK ((("Status")::text = ANY (ARRAY[('PENDING'::character varying)::text, ('CONFIRMED'::character varying)::text, ('DISMISSED'::character varying)::text])))
);


--
-- Name: ReportImages; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."ReportImages" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "ReportId" uuid NOT NULL,
    "CloudinaryAssetId" character varying(255),
    "PublicId" character varying(500) NOT NULL,
    "SecureUrl" text NOT NULL,
    "Version" bigint,
    "Format" character varying(30),
    "Width" integer,
    "Height" integer,
    "Bytes" bigint,
    "ResourceType" character varying(30) DEFAULT 'image'::character varying NOT NULL,
    "IsPrimary" boolean DEFAULT false NOT NULL,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ReportStatusHistory; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."ReportStatusHistory" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "ReportId" uuid NOT NULL,
    "StatusType" character varying(20) NOT NULL,
    "OldStatus" character varying(60),
    "NewStatus" character varying(60) NOT NULL,
    "ChangedBy" uuid,
    "Reason" text,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "CK_ReportStatusHistory_Type" CHECK ((("StatusType")::text = ANY (ARRAY[('REPORT'::character varying)::text, ('AGENT'::character varying)::text])))
);


--
-- Name: ReportVerifications; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."ReportVerifications" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "ReportId" uuid NOT NULL,
    "UserId" uuid NOT NULL,
    "Source" character varying(30) DEFAULT 'APP'::character varying NOT NULL,
    "Note" text,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: Reports; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."Reports" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "ReportNo" character varying(30) DEFAULT dbo."GenerateReportNo"() NOT NULL,
    "ReporterId" uuid NOT NULL,
    "Description" text,
    "Notes" text,
    "LocationId" uuid,
    "Building" character varying(200),
    "Floor" character varying(100),
    "RoomOrArea" character varying(200),
    "GpsLat" numeric(9,6),
    "GpsLng" numeric(9,6),
    "Status" character varying(40) DEFAULT 'SUBMITTED'::character varying NOT NULL,
    "AgentStatus" character varying(20) DEFAULT 'PENDING'::character varying NOT NULL,
    "AgentAttemptCount" integer DEFAULT 0 NOT NULL,
    "AgentClaimedAt" timestamp with time zone,
    "AgentClaimedBy" character varying(150),
    "AgentStartedAt" timestamp with time zone,
    "AgentCompletedAt" timestamp with time zone,
    "AgentNextRetryAt" timestamp with time zone,
    "AgentLastError" text,
    "AnalysisStatus" character varying(30),
    "ScopeDecision" character varying(60),
    "ScopeShouldAnalyze" boolean,
    "AiCategory" character varying(150),
    "AiSummary" text,
    "AiRawRecommendedUrgency" character varying(20),
    "AiRecommendedUrgency" character varying(20),
    "AiPolicyApplied" boolean DEFAULT false NOT NULL,
    "AiPolicyVersion" character varying(100),
    "AiPolicyReason" text,
    "AiAnalysisCertainty" character varying(20),
    "AiNeedsReview" boolean,
    "AiEstimatedMinHours" numeric(10,2),
    "AiEstimatedMaxHours" numeric(10,2),
    "RiskImmediateDanger" boolean DEFAULT false NOT NULL,
    "RiskElectricalExposure" boolean DEFAULT false NOT NULL,
    "RiskFireOrSmokeIndicator" boolean DEFAULT false NOT NULL,
    "RiskStructuralInstabilityIndicator" boolean DEFAULT false NOT NULL,
    "RiskActiveFlooding" boolean DEFAULT false NOT NULL,
    "RiskBlockedAccessOrExit" boolean DEFAULT false NOT NULL,
    "RiskPublicAccessExposure" boolean DEFAULT false NOT NULL,
    "ParentReportId" uuid,
    "RecurrenceCount" integer DEFAULT 0 NOT NULL,
    "IsRecurring" boolean DEFAULT false NOT NULL,
    "VerificationCount" integer DEFAULT 0 NOT NULL,
    "PriorityUrgencyPoints" integer,
    "PriorityRecurrencePoints" integer,
    "PriorityVerificationPoints" integer,
    "PriorityAgePoints" integer,
    "PriorityPublicExposurePoints" integer,
    "PriorityScore" integer,
    "AiProvider" character varying(100),
    "AiModelId" character varying(200),
    "AiPromptVersion" character varying(150),
    "OriginalWidth" integer,
    "OriginalHeight" integer,
    "ProcessedWidth" integer,
    "ProcessedHeight" integer,
    "AiProcessingTimeMs" integer,
    "AssessmentJson" jsonb,
    "FinalCategory" character varying(150),
    "FinalUrgency" character varying(20),
    "OverrideReason" text,
    "ReviewedBy" uuid,
    "ReviewedAt" timestamp with time zone,
    "ResolvedAt" timestamp with time zone,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "UpdatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "CK_Reports_AgentStatus" CHECK ((("AgentStatus")::text = ANY (ARRAY[('PENDING'::character varying)::text, ('PROCESSING'::character varying)::text, ('COMPLETED'::character varying)::text, ('FAILED'::character varying)::text]))),
    CONSTRAINT "CK_Reports_AiRawUrgency" CHECK ((("AiRawRecommendedUrgency" IS NULL) OR (("AiRawRecommendedUrgency")::text = ANY (ARRAY[('Low'::character varying)::text, ('Medium'::character varying)::text, ('High'::character varying)::text, ('Critical'::character varying)::text])))),
    CONSTRAINT "CK_Reports_AiUrgency" CHECK ((("AiRecommendedUrgency" IS NULL) OR (("AiRecommendedUrgency")::text = ANY (ARRAY[('Low'::character varying)::text, ('Medium'::character varying)::text, ('High'::character varying)::text, ('Critical'::character varying)::text])))),
    CONSTRAINT "CK_Reports_AnalysisStatus" CHECK ((("AnalysisStatus" IS NULL) OR (("AnalysisStatus")::text = ANY (ARRAY[('Assessed'::character varying)::text, ('No Assessment'::character varying)::text])))),
    CONSTRAINT "CK_Reports_Certainty" CHECK ((("AiAnalysisCertainty" IS NULL) OR (("AiAnalysisCertainty")::text = ANY (ARRAY[('Low'::character varying)::text, ('Medium'::character varying)::text, ('High'::character varying)::text])))),
    CONSTRAINT "CK_Reports_Counts" CHECK ((("AgentAttemptCount" >= 0) AND ("RecurrenceCount" >= 0) AND ("VerificationCount" >= 0))),
    CONSTRAINT "CK_Reports_FinalUrgency" CHECK ((("FinalUrgency" IS NULL) OR (("FinalUrgency")::text = ANY (ARRAY[('Low'::character varying)::text, ('Medium'::character varying)::text, ('High'::character varying)::text, ('Critical'::character varying)::text])))),
    CONSTRAINT "CK_Reports_GpsLat" CHECK ((("GpsLat" IS NULL) OR (("GpsLat" >= ('-90'::integer)::numeric) AND ("GpsLat" <= (90)::numeric)))),
    CONSTRAINT "CK_Reports_GpsLng" CHECK ((("GpsLng" IS NULL) OR (("GpsLng" >= ('-180'::integer)::numeric) AND ("GpsLng" <= (180)::numeric)))),
    CONSTRAINT "CK_Reports_ScopeDecision" CHECK ((("ScopeDecision" IS NULL) OR (("ScopeDecision")::text = ANY (ARRAY[('Facility Issue'::character varying)::text, ('No Visible Maintenance Issue'::character varying)::text, ('Out of Scope'::character varying)::text, ('Insufficient Image'::character varying)::text])))),
    CONSTRAINT "CK_Reports_Status" CHECK ((("Status")::text = ANY (ARRAY[('SUBMITTED'::character varying)::text, ('PENDING_REVIEW'::character varying)::text, ('ROUTED_INTERNAL'::character varying)::text, ('PROCUREMENT'::character varying)::text, ('PENDING_ASSIGNMENT'::character varying)::text, ('ASSIGNED'::character varying)::text, ('IN_PROGRESS'::character varying)::text, ('PENDING_PARTS'::character varying)::text, ('ON_HOLD'::character varying)::text, ('COMPLETION_SUBMITTED'::character varying)::text, ('REWORK_REQUIRED'::character varying)::text, ('RESOLVED'::character varying)::text, ('NEEDS_INFORMATION'::character varying)::text, ('NO_ACTION'::character varying)::text, ('DUPLICATE'::character varying)::text, ('CANCELLED'::character varying)::text])))
);


--
-- Name: TABLE "Reports"; Type: COMMENT; Schema: dbo; Owner: -
--

COMMENT ON TABLE dbo."Reports" IS 'Central Reporter record and durable initial AI queue. After Agent completion it enters the live Maintenance Review priority queue.';


--
-- Name: COLUMN "Reports"."PriorityScore"; Type: COMMENT; Schema: dbo; Owner: -
--

COMMENT ON COLUMN dbo."Reports"."PriorityScore" IS 'Assessment-time deterministic priority snapshot. Use dbo.v_ReportPriorityLive for the live age-aware queue.';


--
-- Name: Skills; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."Skills" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "Code" character varying(80) NOT NULL,
    "Name" character varying(150) NOT NULL,
    "Description" text,
    "IsActive" boolean DEFAULT true NOT NULL,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "UpdatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: SystemSettings; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."SystemSettings" (
    "Key" character varying(150) NOT NULL,
    "Value" jsonb NOT NULL,
    "Description" text,
    "UpdatedBy" uuid,
    "UpdatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: UserAuthChallenges; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."UserAuthChallenges" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "UserId" uuid NOT NULL,
    "Purpose" character varying(30) NOT NULL,
    "TargetEmail" character varying(320) NOT NULL,
    "CodeHash" character varying(64) NOT NULL,
    "AttemptsRemaining" integer DEFAULT 5 NOT NULL,
    "ExpiresAt" timestamp with time zone NOT NULL,
    "ConsumedAt" timestamp with time zone,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "UserAuthChallenges_AttemptsRemaining_check" CHECK ((("AttemptsRemaining" >= 0) AND ("AttemptsRemaining" <= 5))),
    CONSTRAINT "UserAuthChallenges_Purpose_check" CHECK ((("Purpose")::text = ANY (ARRAY[('EMAIL_VERIFY'::character varying)::text, ('EMAIL_CHANGE'::character varying)::text, ('PASSWORD_RESET'::character varying)::text])))
);


--
-- Name: Users; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."Users" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "InstitutionalId" character varying(100),
    "FullName" character varying(200) NOT NULL,
    "Email" character varying(320) NOT NULL,
    "PasswordHash" text NOT NULL,
    "Role" character varying(40) NOT NULL,
    "JobTitle" character varying(180),
    "DepartmentOrTrade" character varying(180),
    "Phone" character varying(50),
    "IsActive" boolean DEFAULT true NOT NULL,
    "LastLoginAt" timestamp with time zone,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "UpdatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "Username" character varying(50),
    "EmailVerifiedAt" timestamp with time zone,
    "EmailVerificationRequired" boolean DEFAULT false NOT NULL,
    "CredentialsVersion" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "CK_Users_Role" CHECK ((("Role")::text = ANY (ARRAY[('REPORTER'::character varying)::text, ('MAINTENANCE_STAFF'::character varying)::text, ('MAINTENANCE_SUPERVISOR'::character varying)::text, ('PROCUREMENT'::character varying)::text, ('WORKER'::character varying)::text, ('ADMIN'::character varying)::text])))
);


--
-- Name: WorkOrderAssignments; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."WorkOrderAssignments" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "WorkOrderId" uuid NOT NULL,
    "AssignedPartyName" character varying(250),
    "ResponsibleLeadUserId" uuid,
    "ResponsibleLeadName" character varying(200),
    "ResponsibleLeadContact" character varying(100),
    "ResponsibleLeadEmail" character varying(320),
    "AssignedBy" uuid,
    "AssignedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "Reason" text,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE "WorkOrderAssignments"; Type: COMMENT; Schema: dbo; Owner: -
--

COMMENT ON TABLE dbo."WorkOrderAssignments" IS 'Assignment/reassignment history for maintenance dispatch accountability.';


--
-- Name: WorkOrderImages; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."WorkOrderImages" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "WorkOrderId" uuid NOT NULL,
    "ImageType" character varying(30) NOT NULL,
    "CloudinaryAssetId" character varying(255),
    "PublicId" character varying(500) NOT NULL,
    "SecureUrl" text NOT NULL,
    "Version" bigint,
    "Format" character varying(30),
    "Width" integer,
    "Height" integer,
    "Bytes" bigint,
    "ResourceType" character varying(30) DEFAULT 'image'::character varying NOT NULL,
    "CreatedBy" uuid,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "CK_WorkOrderImages_Type" CHECK ((("ImageType")::text = ANY (ARRAY[('PROGRESS'::character varying)::text, ('COMPLETION'::character varying)::text, ('OTHER'::character varying)::text])))
);


--
-- Name: WorkOrderMaterials; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."WorkOrderMaterials" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "WorkOrderId" uuid NOT NULL,
    "Stage" character varying(20) NOT NULL,
    "MaterialId" uuid,
    "MaterialName" character varying(200) NOT NULL,
    "Unit" character varying(50),
    "Quantity" numeric(12,3),
    "Notes" text,
    "RecordedBy" uuid,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "CK_WorkOrderMaterials_Quantity" CHECK ((("Quantity" IS NULL) OR ("Quantity" >= (0)::numeric))),
    CONSTRAINT "CK_WorkOrderMaterials_Stage" CHECK ((("Stage")::text = ANY (ARRAY[('PLANNED'::character varying)::text, ('ACTUAL'::character varying)::text])))
);


--
-- Name: WorkOrderPeople; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."WorkOrderPeople" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "WorkOrderId" uuid NOT NULL,
    "UserId" uuid,
    "FullName" character varying(200) NOT NULL,
    "RoleOrTrade" character varying(150),
    "Contact" character varying(100),
    "IsLead" boolean DEFAULT false NOT NULL,
    "Notes" text,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: WorkOrderStatusHistory; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."WorkOrderStatusHistory" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "WorkOrderId" uuid NOT NULL,
    "OldStatus" character varying(40),
    "NewStatus" character varying(40) NOT NULL,
    "ChangedBy" uuid,
    "Reason" text,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: WorkOrderUpdates; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."WorkOrderUpdates" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "WorkOrderId" uuid NOT NULL,
    "UpdateType" character varying(30) NOT NULL,
    "StatusSnapshot" character varying(40),
    "Message" text NOT NULL,
    "ProgressPercent" numeric(5,2),
    "CreatedBy" uuid,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "CK_WorkOrderUpdates_Progress" CHECK ((("ProgressPercent" IS NULL) OR (("ProgressPercent" >= (0)::numeric) AND ("ProgressPercent" <= (100)::numeric)))),
    CONSTRAINT "CK_WorkOrderUpdates_Type" CHECK ((("UpdateType")::text = ANY (ARRAY[('NOTE'::character varying)::text, ('PROGRESS'::character varying)::text, ('STATUS'::character varying)::text, ('PARTS'::character varying)::text, ('HOLD'::character varying)::text, ('COMPLETION'::character varying)::text, ('OTHER'::character varying)::text])))
);


--
-- Name: WorkOrders; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."WorkOrders" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "WorkOrderNo" character varying(30) DEFAULT dbo."GenerateWorkOrderNo"() NOT NULL,
    "ReportId" uuid NOT NULL,
    "MaintenanceRequestId" uuid NOT NULL,
    "MaintenanceReviewId" uuid NOT NULL,
    "RouteType" character varying(30) NOT NULL,
    "ProcurementOutcomeId" uuid,
    "Status" character varying(40) DEFAULT 'PENDING_ASSIGNMENT'::character varying NOT NULL,
    "ExecutionType" character varying(30) NOT NULL,
    "AssignedPartyName" character varying(250),
    "ResponsibleLeadUserId" uuid,
    "ResponsibleLeadName" character varying(200),
    "ResponsibleLeadContact" character varying(100),
    "ResponsibleLeadEmail" character varying(320),
    "AssignedBy" uuid,
    "AssignedAt" timestamp with time zone,
    "PlannedStartAt" timestamp with time zone,
    "Deadline" timestamp with time zone,
    "PlannedDurationDays" numeric(10,2),
    "PlannedCrewSize" integer,
    "PlannedLaborHours" numeric(10,2),
    "Instructions" text,
    "SafetyRequirements" text,
    "ProcurementReferenceNo" character varying(200),
    "PlanningVarianceJson" jsonb,
    "CreatedBy" uuid,
    "StartedBy" uuid,
    "StartedAt" timestamp with time zone,
    "CompletionSubmittedBy" uuid,
    "CompletionSubmittedAt" timestamp with time zone,
    "RepairNotes" text,
    "ActualLaborHours" numeric(10,2),
    "ActualCrewSize" integer,
    "ActualDurationDays" numeric(10,2),
    "ActualMaterialsNotes" text,
    "CompletionAgentStatus" character varying(30) DEFAULT 'NOT_REQUESTED'::character varying NOT NULL,
    "CompletionAgentAttemptCount" integer DEFAULT 0 NOT NULL,
    "CompletionAgentClaimedAt" timestamp with time zone,
    "CompletionAgentClaimedBy" character varying(150),
    "CompletionAgentStartedAt" timestamp with time zone,
    "CompletionAgentCompletedAt" timestamp with time zone,
    "CompletionAgentLastError" text,
    "CompletionVisualResult" character varying(60),
    "CompletionAssessmentJson" jsonb,
    "CompletionAiProvider" character varying(100),
    "CompletionAiModelId" character varying(200),
    "CompletionAiPromptVersion" character varying(150),
    "CompletionAiProcessingTimeMs" integer,
    "CompletedBy" uuid,
    "ResolvedAt" timestamp with time zone,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "UpdatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "CK_WorkOrders_AssignmentMetadata" CHECK (((("Status")::text = 'PENDING_ASSIGNMENT'::text) OR ((NULLIF(btrim(("AssignedPartyName")::text), ''::text) IS NOT NULL) AND (("ResponsibleLeadUserId" IS NOT NULL) OR (NULLIF(btrim(("ResponsibleLeadName")::text), ''::text) IS NOT NULL)) AND ("AssignedAt" IS NOT NULL)))),
    CONSTRAINT "CK_WorkOrders_CompletedMetadata" CHECK (((("Status")::text <> 'COMPLETED'::text) OR (("CompletedBy" IS NOT NULL) AND ("ResolvedAt" IS NOT NULL)))),
    CONSTRAINT "CK_WorkOrders_CompletionMetadata" CHECK (((("Status")::text <> ALL (ARRAY[('COMPLETION_SUBMITTED'::character varying)::text, ('COMPLETED'::character varying)::text])) OR ((NULLIF(btrim("RepairNotes"), ''::text) IS NOT NULL) AND ("CompletionSubmittedAt" IS NOT NULL) AND ("CompletionSubmittedBy" IS NOT NULL)))),
    CONSTRAINT "CK_WorkOrders_ExecutionType" CHECK ((("ExecutionType")::text = ANY (ARRAY[('INTERNAL'::character varying)::text, ('AGENCY'::character varying)::text, ('CONTRACTOR'::character varying)::text, ('INDIVIDUAL'::character varying)::text, ('GROUP'::character varying)::text, ('OTHER'::character varying)::text]))),
    CONSTRAINT "CK_WorkOrders_Numeric" CHECK (((("PlannedDurationDays" IS NULL) OR ("PlannedDurationDays" > (0)::numeric)) AND (("PlannedCrewSize" IS NULL) OR ("PlannedCrewSize" >= 1)) AND (("PlannedLaborHours" IS NULL) OR ("PlannedLaborHours" > (0)::numeric)) AND (("ActualLaborHours" IS NULL) OR ("ActualLaborHours" >= (0)::numeric)) AND (("ActualCrewSize" IS NULL) OR ("ActualCrewSize" >= 1)) AND (("ActualDurationDays" IS NULL) OR ("ActualDurationDays" >= (0)::numeric)) AND (("Deadline" IS NULL) OR ("PlannedStartAt" IS NULL) OR ("Deadline" >= "PlannedStartAt")) AND ("CompletionAgentAttemptCount" >= 0))),
    CONSTRAINT "CK_WorkOrders_ProcurementSource" CHECK ((((("RouteType")::text = 'INTERNAL'::text) AND ("ProcurementOutcomeId" IS NULL)) OR ((("RouteType")::text = 'PROCUREMENT'::text) AND ("ProcurementOutcomeId" IS NOT NULL)))),
    CONSTRAINT "CK_WorkOrders_RouteType" CHECK ((("RouteType")::text = ANY (ARRAY[('INTERNAL'::character varying)::text, ('PROCUREMENT'::character varying)::text]))),
    CONSTRAINT "CK_WorkOrders_StartMetadata" CHECK (((("Status")::text <> ALL (ARRAY[('IN_PROGRESS'::character varying)::text, ('PENDING_PARTS'::character varying)::text, ('ON_HOLD'::character varying)::text, ('COMPLETION_SUBMITTED'::character varying)::text, ('REWORK_REQUIRED'::character varying)::text, ('COMPLETED'::character varying)::text])) OR ("StartedAt" IS NOT NULL))),
    CONSTRAINT "CK_WorkOrders_Status" CHECK ((("Status")::text = ANY (ARRAY[('PENDING_ASSIGNMENT'::character varying)::text, ('ASSIGNED'::character varying)::text, ('IN_PROGRESS'::character varying)::text, ('PENDING_PARTS'::character varying)::text, ('ON_HOLD'::character varying)::text, ('COMPLETION_SUBMITTED'::character varying)::text, ('REWORK_REQUIRED'::character varying)::text, ('COMPLETED'::character varying)::text, ('CANCELLED'::character varying)::text])))
);


--
-- Name: TABLE "WorkOrders"; Type: COMMENT; Schema: dbo; Owner: -
--

COMMENT ON TABLE dbo."WorkOrders" IS 'Execution record created either directly from an INTERNAL Maintenance Review or from a completed PROCUREMENT outcome. No second Work Order confirmation gate is required; assignment and execution are tracked directly.';


--
-- Name: WorkflowActionItems; Type: TABLE; Schema: dbo; Owner: -
--

CREATE TABLE dbo."WorkflowActionItems" (
    "Id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "EntityType" character varying(40) NOT NULL,
    "EntityId" uuid NOT NULL,
    "ActionType" character varying(80) NOT NULL,
    "AssignedRole" character varying(40),
    "AssignedUserId" uuid,
    "Priority" character varying(20) DEFAULT 'NORMAL'::character varying NOT NULL,
    "Status" character varying(20) DEFAULT 'OPEN'::character varying NOT NULL,
    "Title" character varying(250) NOT NULL,
    "Message" text,
    "DueAt" timestamp with time zone,
    "NextReminderAt" timestamp with time zone,
    "EscalationAt" timestamp with time zone,
    "CompletedBy" uuid,
    "CompletedAt" timestamp with time zone,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "UpdatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "CK_WorkflowActionItems_Priority" CHECK ((("Priority")::text = ANY (ARRAY[('LOW'::character varying)::text, ('NORMAL'::character varying)::text, ('HIGH'::character varying)::text, ('CRITICAL'::character varying)::text]))),
    CONSTRAINT "CK_WorkflowActionItems_Status" CHECK ((("Status")::text = ANY (ARRAY[('OPEN'::character varying)::text, ('COMPLETED'::character varying)::text, ('CANCELLED'::character varying)::text])))
);


--
-- Name: v_CompletedWorkOrderKnowledge; Type: VIEW; Schema: dbo; Owner: -
--

CREATE VIEW dbo."v_CompletedWorkOrderKnowledge" AS
 SELECT wo."Id" AS "WorkOrderId",
    wo."WorkOrderNo",
    wo."RouteType",
    wo."ExecutionType",
    r."Id" AS "ReportId",
    r."ReportNo",
    COALESCE(r."FinalCategory", r."AiCategory") AS "EffectiveCategory",
    COALESCE(r."FinalUrgency", r."AiRecommendedUrgency") AS "EffectiveUrgency",
    mr."RequiredService",
    mr."RequiredCapability",
    mr."EstimatedLaborHoursMin",
    mr."EstimatedLaborHoursMax",
    mr."EstimatedManpowerMin",
    mr."EstimatedManpowerMax",
    mr."EstimatedDurationDaysMin",
    mr."EstimatedDurationDaysMax",
    wo."PlannedDurationDays",
    wo."PlannedCrewSize",
    wo."PlannedLaborHours",
    wo."ActualDurationDays",
    wo."ActualCrewSize",
    wo."ActualLaborHours",
        CASE
            WHEN ((wo."StartedAt" IS NOT NULL) AND (wo."ResolvedAt" IS NOT NULL)) THEN (EXTRACT(epoch FROM (wo."ResolvedAt" - wo."StartedAt")) / 3600.0)
            ELSE NULL::numeric
        END AS "ObservedElapsedHours",
    wo."StartedAt",
    wo."ResolvedAt",
    r."Building",
    r."Floor",
    r."RoomOrArea",
    wo."ProcurementOutcomeId"
   FROM ((dbo."WorkOrders" wo
     JOIN dbo."Reports" r ON ((r."Id" = wo."ReportId")))
     JOIN dbo."MaintenanceRequests" mr ON ((mr."Id" = wo."MaintenanceRequestId")))
  WHERE ((wo."Status")::text = 'COMPLETED'::text);


--
-- Name: v_ReportPriorityLive; Type: VIEW; Schema: dbo; Owner: -
--

CREATE VIEW dbo."v_ReportPriorityLive" AS
 WITH cfg AS (
         SELECT COALESCE(( SELECT (("SystemSettings"."Value" #>> '{}'::text[]))::integer AS int4
                   FROM dbo."SystemSettings"
                  WHERE (("SystemSettings"."Key")::text = 'AgentRecurrenceThreshold'::text)), 2) AS recurrence_threshold,
            COALESCE(( SELECT (("SystemSettings"."Value" #>> '{}'::text[]))::integer AS int4
                   FROM dbo."SystemSettings"
                  WHERE (("SystemSettings"."Key")::text = 'AgentVerificationThreshold'::text)), 2) AS verification_threshold
        ), base AS (
         SELECT r."Id",
            r."ReportNo",
            r."ReporterId",
            r."Description",
            r."Notes",
            r."LocationId",
            r."Building",
            r."Floor",
            r."RoomOrArea",
            r."GpsLat",
            r."GpsLng",
            r."Status",
            r."AgentStatus",
            r."AgentAttemptCount",
            r."AgentClaimedAt",
            r."AgentClaimedBy",
            r."AgentStartedAt",
            r."AgentCompletedAt",
            r."AgentNextRetryAt",
            r."AgentLastError",
            r."AnalysisStatus",
            r."ScopeDecision",
            r."ScopeShouldAnalyze",
            r."AiCategory",
            r."AiSummary",
            r."AiRawRecommendedUrgency",
            r."AiRecommendedUrgency",
            r."AiPolicyApplied",
            r."AiPolicyVersion",
            r."AiPolicyReason",
            r."AiAnalysisCertainty",
            r."AiNeedsReview",
            r."AiEstimatedMinHours",
            r."AiEstimatedMaxHours",
            r."RiskImmediateDanger",
            r."RiskElectricalExposure",
            r."RiskFireOrSmokeIndicator",
            r."RiskStructuralInstabilityIndicator",
            r."RiskActiveFlooding",
            r."RiskBlockedAccessOrExit",
            r."RiskPublicAccessExposure",
            r."ParentReportId",
            r."RecurrenceCount",
            r."IsRecurring",
            r."VerificationCount",
            r."PriorityUrgencyPoints",
            r."PriorityRecurrencePoints",
            r."PriorityVerificationPoints",
            r."PriorityAgePoints",
            r."PriorityPublicExposurePoints",
            r."PriorityScore",
            r."AiProvider",
            r."AiModelId",
            r."AiPromptVersion",
            r."OriginalWidth",
            r."OriginalHeight",
            r."ProcessedWidth",
            r."ProcessedHeight",
            r."AiProcessingTimeMs",
            r."AssessmentJson",
            r."FinalCategory",
            r."FinalUrgency",
            r."OverrideReason",
            r."ReviewedBy",
            r."ReviewedAt",
            r."ResolvedAt",
            r."CreatedAt",
            r."UpdatedAt",
            COALESCE(r."FinalCategory", r."AiCategory") AS "EffectiveCategory",
            COALESCE(r."FinalUrgency", r."AiRecommendedUrgency") AS "EffectiveUrgency",
            (EXTRACT(epoch FROM (now() - r."CreatedAt")) / 86400.0) AS age_days,
            cfg.recurrence_threshold,
            cfg.verification_threshold
           FROM (dbo."Reports" r
             CROSS JOIN cfg)
        )
 SELECT "Id",
    "ReportNo",
    "ReporterId",
    "Status",
    "AgentStatus",
    "AnalysisStatus",
    "ScopeDecision",
    "EffectiveCategory",
    "EffectiveUrgency",
    "AiSummary",
    "Building",
    "Floor",
    "RoomOrArea",
    "LocationId",
    "RecurrenceCount",
    "VerificationCount",
    "RiskPublicAccessExposure",
    "CreatedAt",
    age_days AS "AgeDays",
        CASE "EffectiveUrgency"
            WHEN 'Critical'::text THEN 100
            WHEN 'High'::text THEN 75
            WHEN 'Medium'::text THEN 50
            WHEN 'Low'::text THEN 25
            ELSE 0
        END AS "LiveUrgencyPoints",
        CASE
            WHEN ("RecurrenceCount" >= recurrence_threshold) THEN 15
            ELSE 0
        END AS "LiveRecurrencePoints",
        CASE
            WHEN ("VerificationCount" >= verification_threshold) THEN 10
            ELSE 0
        END AS "LiveVerificationPoints",
        CASE
            WHEN (age_days > (7)::numeric) THEN 20
            WHEN (age_days > (3)::numeric) THEN 10
            ELSE 0
        END AS "LiveAgePoints",
        CASE
            WHEN "RiskPublicAccessExposure" THEN 10
            ELSE 0
        END AS "LivePublicExposurePoints",
    ((((
        CASE "EffectiveUrgency"
            WHEN 'Critical'::text THEN 100
            WHEN 'High'::text THEN 75
            WHEN 'Medium'::text THEN 50
            WHEN 'Low'::text THEN 25
            ELSE 0
        END +
        CASE
            WHEN ("RecurrenceCount" >= recurrence_threshold) THEN 15
            ELSE 0
        END) +
        CASE
            WHEN ("VerificationCount" >= verification_threshold) THEN 10
            ELSE 0
        END) +
        CASE
            WHEN (age_days > (7)::numeric) THEN 20
            WHEN (age_days > (3)::numeric) THEN 10
            ELSE 0
        END) +
        CASE
            WHEN "RiskPublicAccessExposure" THEN 10
            ELSE 0
        END) AS "LivePriorityScore"
   FROM base b;


--
-- Name: v_MaintenanceReviewQueue; Type: VIEW; Schema: dbo; Owner: -
--

CREATE VIEW dbo."v_MaintenanceReviewQueue" AS
 SELECT p."Id" AS "ReportId",
    p."ReportNo",
    p."EffectiveCategory",
    p."EffectiveUrgency",
    p."LivePriorityScore",
    p."AiSummary",
    p."Building",
    p."Floor",
    p."RoomOrArea",
    p."CreatedAt",
    mrq."Id" AS "MaintenanceRequestId",
    mrq."RequestNo",
    rev."Id" AS "MaintenanceReviewId",
    rev."Status" AS "ReviewStatus"
   FROM ((dbo."v_ReportPriorityLive" p
     LEFT JOIN dbo."MaintenanceRequests" mrq ON ((mrq."ReportId" = p."Id")))
     LEFT JOIN dbo."MaintenanceReviews" rev ON ((rev."ReportId" = p."Id")))
  WHERE (((p."Status")::text = 'PENDING_REVIEW'::text) AND ((rev."Id" IS NULL) OR ((rev."Status")::text = 'PENDING'::text)));


--
-- Name: VIEW "v_MaintenanceReviewQueue"; Type: COMMENT; Schema: dbo; Owner: -
--

COMMENT ON VIEW dbo."v_MaintenanceReviewQueue" IS 'Primary triage queue for the Maintenance Department, ordered by dbo.v_ReportPriorityLive in application queries.';


--
-- Name: v_MaintenanceActionCenter; Type: VIEW; Schema: dbo; Owner: -
--

CREATE VIEW dbo."v_MaintenanceActionCenter" AS
 SELECT 'REPORT'::character varying AS "EntityType",
    q."ReportId" AS "EntityId",
    'REVIEW_REPORT'::character varying AS "ActionType",
    'MAINTENANCE_STAFF'::character varying AS "AssignedRole",
    q."LivePriorityScore" AS "PriorityScore",
    q."CreatedAt" AS "ActionCreatedAt",
    q."ReportNo" AS "ReferenceNo",
    ('Review prioritized maintenance report: '::text || COALESCE(q."AiSummary", (q."EffectiveCategory")::text, 'Unclassified issue'::text)) AS "Summary"
   FROM dbo."v_MaintenanceReviewQueue" q
UNION ALL
 SELECT 'WORK_ORDER'::character varying AS "EntityType",
    wo."Id" AS "EntityId",
    'ASSIGN_WORK_ORDER'::character varying AS "ActionType",
    'MAINTENANCE_STAFF'::character varying AS "AssignedRole",
    COALESCE(p."LivePriorityScore", 0) AS "PriorityScore",
    wo."CreatedAt" AS "ActionCreatedAt",
    wo."WorkOrderNo" AS "ReferenceNo",
    'Work Order is waiting for assignment.'::text AS "Summary"
   FROM (dbo."WorkOrders" wo
     LEFT JOIN dbo."v_ReportPriorityLive" p ON ((p."Id" = wo."ReportId")))
  WHERE ((wo."Status")::text = 'PENDING_ASSIGNMENT'::text)
UNION ALL
 SELECT 'PROCUREMENT_CLARIFICATION'::character varying AS "EntityType",
    pc."Id" AS "EntityId",
    'RESPOND_PROCUREMENT_CLARIFICATION'::character varying AS "ActionType",
    'MAINTENANCE_SUPERVISOR'::character varying AS "AssignedRole",
    COALESCE(p."LivePriorityScore", 0) AS "PriorityScore",
    pc."AskedAt" AS "ActionCreatedAt",
    ph."HandoffNo" AS "ReferenceNo",
    'Procurement clarification requires a human maintenance response.'::text AS "Summary"
   FROM (((dbo."ProcurementClarifications" pc
     JOIN dbo."ProcurementHandoffs" ph ON ((ph."Id" = pc."ProcurementHandoffId")))
     JOIN dbo."MaintenanceRequests" mr ON ((mr."Id" = ph."MaintenanceRequestId")))
     LEFT JOIN dbo."v_ReportPriorityLive" p ON ((p."Id" = mr."ReportId")))
  WHERE ((pc."Status")::text = 'OPEN'::text)
UNION ALL
 SELECT 'WORK_ORDER'::character varying AS "EntityType",
    wo."Id" AS "EntityId",
    'REVIEW_COMPLETION'::character varying AS "ActionType",
    'MAINTENANCE_SUPERVISOR'::character varying AS "AssignedRole",
    COALESCE(p."LivePriorityScore", 0) AS "PriorityScore",
    wo."CompletionSubmittedAt" AS "ActionCreatedAt",
    wo."WorkOrderNo" AS "ReferenceNo",
    'Completion was submitted and requires Maintenance Supervisor review.'::text AS "Summary"
   FROM (dbo."WorkOrders" wo
     LEFT JOIN dbo."v_ReportPriorityLive" p ON ((p."Id" = wo."ReportId")))
  WHERE ((wo."Status")::text = 'COMPLETION_SUBMITTED'::text);


--
-- Name: VIEW "v_MaintenanceActionCenter"; Type: COMMENT; Schema: dbo; Owner: -
--

COMMENT ON VIEW dbo."v_MaintenanceActionCenter" IS 'Action center for Maintenance Staff/Supervisor: report review, work assignment, procurement clarifications, and completion review.';


--
-- Name: v_PendingAgentReports; Type: VIEW; Schema: dbo; Owner: -
--

CREATE VIEW dbo."v_PendingAgentReports" AS
 SELECT "Id",
    "ReportNo",
    "ReporterId",
    "CreatedAt",
    "AgentStatus",
    "AgentAttemptCount",
    "AgentNextRetryAt"
   FROM dbo."Reports" r
  WHERE ((("AgentStatus")::text = 'PENDING'::text) AND (("AgentNextRetryAt" IS NULL) OR ("AgentNextRetryAt" <= now())));


--
-- Name: v_ProcurementInbox; Type: VIEW; Schema: dbo; Owner: -
--

CREATE VIEW dbo."v_ProcurementInbox" AS
 SELECT ph."Id" AS "HandoffId",
    ph."HandoffNo",
    ph."Status",
    ph."SubmittedAt",
    ph."AcknowledgedAt",
    ph."ExpectedResponseAt",
    ph."NextFollowUpAt",
    ph."ExternalSystemReference",
    mr."Id" AS "MaintenanceRequestId",
    mr."RequestNo",
    mr."EffectiveCategory",
    mr."EffectiveUrgency",
    mr."RequiredService",
    mr."ScopeOfWork",
    r."Id" AS "ReportId",
    r."ReportNo",
    p."LivePriorityScore"
   FROM (((dbo."ProcurementHandoffs" ph
     JOIN dbo."MaintenanceRequests" mr ON ((mr."Id" = ph."MaintenanceRequestId")))
     JOIN dbo."Reports" r ON ((r."Id" = mr."ReportId")))
     LEFT JOIN dbo."v_ReportPriorityLive" p ON ((p."Id" = r."Id")))
  WHERE ((ph."Status")::text <> ALL (ARRAY[('COMPLETED'::character varying)::text, ('CANCELLED'::character varying)::text]));


--
-- Name: v_ReportEffectiveClassification; Type: VIEW; Schema: dbo; Owner: -
--

CREATE VIEW dbo."v_ReportEffectiveClassification" AS
 SELECT "Id",
    "ReportNo",
    COALESCE("FinalCategory", "AiCategory") AS "EffectiveCategory",
    COALESCE("FinalUrgency", "AiRecommendedUrgency") AS "EffectiveUrgency",
    "AiCategory",
    "AiRecommendedUrgency",
    "FinalCategory",
    "FinalUrgency",
    "ReviewedBy",
    "ReviewedAt"
   FROM dbo."Reports" r;


--
-- Name: v_ReportTimeline; Type: VIEW; Schema: dbo; Owner: -
--

CREATE VIEW dbo."v_ReportTimeline" AS
 SELECT "ReportId",
    "CreatedAt",
    "StatusType",
    "OldStatus",
    "NewStatus",
    "ChangedBy",
    "Reason"
   FROM dbo."ReportStatusHistory" rsh;


--
-- Name: v_WorkerInbox; Type: VIEW; Schema: dbo; Owner: -
--

CREATE VIEW dbo."v_WorkerInbox" AS
 SELECT wo."Id" AS "WorkOrderId",
    wo."WorkOrderNo",
    wo."ResponsibleLeadUserId",
    wo."ResponsibleLeadName",
    wo."AssignedPartyName",
    wo."RouteType",
    wo."Status",
    wo."PlannedStartAt",
    wo."Deadline",
    wo."Instructions",
    wo."SafetyRequirements",
    r."ReportNo",
    mr."RequestNo",
    p."EffectiveCategory",
    p."EffectiveUrgency",
    p."LivePriorityScore"
   FROM (((dbo."WorkOrders" wo
     JOIN dbo."Reports" r ON ((r."Id" = wo."ReportId")))
     JOIN dbo."MaintenanceRequests" mr ON ((mr."Id" = wo."MaintenanceRequestId")))
     LEFT JOIN dbo."v_ReportPriorityLive" p ON ((p."Id" = r."Id")))
  WHERE ((wo."Status")::text = ANY (ARRAY[('ASSIGNED'::character varying)::text, ('IN_PROGRESS'::character varying)::text, ('PENDING_PARTS'::character varying)::text, ('ON_HOLD'::character varying)::text, ('REWORK_REQUIRED'::character varying)::text]));


--
-- Name: AuditLogs AuditLogs_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."AuditLogs"
    ADD CONSTRAINT "AuditLogs_pkey" PRIMARY KEY ("Id");


--
-- Name: Buildings Buildings_Code_key; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."Buildings"
    ADD CONSTRAINT "Buildings_Code_key" UNIQUE ("Code");


--
-- Name: Buildings Buildings_Name_key; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."Buildings"
    ADD CONSTRAINT "Buildings_Name_key" UNIQUE ("Name");


--
-- Name: Buildings Buildings_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."Buildings"
    ADD CONSTRAINT "Buildings_pkey" PRIMARY KEY ("Id");


--
-- Name: CategoryMaterialReferences CategoryMaterialReferences_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."CategoryMaterialReferences"
    ADD CONSTRAINT "CategoryMaterialReferences_pkey" PRIMARY KEY ("Id");


--
-- Name: CategorySkillRequirements CategorySkillRequirements_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."CategorySkillRequirements"
    ADD CONSTRAINT "CategorySkillRequirements_pkey" PRIMARY KEY ("Id");


--
-- Name: DamageCategories DamageCategories_Code_key; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."DamageCategories"
    ADD CONSTRAINT "DamageCategories_Code_key" UNIQUE ("Code");


--
-- Name: DamageCategories DamageCategories_Name_key; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."DamageCategories"
    ADD CONSTRAINT "DamageCategories_Name_key" UNIQUE ("Name");


--
-- Name: DamageCategories DamageCategories_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."DamageCategories"
    ADD CONSTRAINT "DamageCategories_pkey" PRIMARY KEY ("Id");


--
-- Name: FacilityLocations FacilityLocations_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."FacilityLocations"
    ADD CONSTRAINT "FacilityLocations_pkey" PRIMARY KEY ("Id");


--
-- Name: MaintenanceRequestMaterials MaintenanceRequestMaterials_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."MaintenanceRequestMaterials"
    ADD CONSTRAINT "MaintenanceRequestMaterials_pkey" PRIMARY KEY ("Id");


--
-- Name: MaintenanceRequestRevisions MaintenanceRequestRevisions_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."MaintenanceRequestRevisions"
    ADD CONSTRAINT "MaintenanceRequestRevisions_pkey" PRIMARY KEY ("Id");


--
-- Name: MaintenanceRequestSkills MaintenanceRequestSkills_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."MaintenanceRequestSkills"
    ADD CONSTRAINT "MaintenanceRequestSkills_pkey" PRIMARY KEY ("Id");


--
-- Name: MaintenanceRequestStatusHistory MaintenanceRequestStatusHistory_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."MaintenanceRequestStatusHistory"
    ADD CONSTRAINT "MaintenanceRequestStatusHistory_pkey" PRIMARY KEY ("Id");


--
-- Name: MaintenanceRequests MaintenanceRequests_ReportId_key; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."MaintenanceRequests"
    ADD CONSTRAINT "MaintenanceRequests_ReportId_key" UNIQUE ("ReportId");


--
-- Name: MaintenanceRequests MaintenanceRequests_RequestNo_key; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."MaintenanceRequests"
    ADD CONSTRAINT "MaintenanceRequests_RequestNo_key" UNIQUE ("RequestNo");


--
-- Name: MaintenanceRequests MaintenanceRequests_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."MaintenanceRequests"
    ADD CONSTRAINT "MaintenanceRequests_pkey" PRIMARY KEY ("Id");


--
-- Name: MaintenanceReviewStatusHistory MaintenanceReviewStatusHistory_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."MaintenanceReviewStatusHistory"
    ADD CONSTRAINT "MaintenanceReviewStatusHistory_pkey" PRIMARY KEY ("Id");


--
-- Name: MaintenanceReviews MaintenanceReviews_MaintenanceRequestId_key; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."MaintenanceReviews"
    ADD CONSTRAINT "MaintenanceReviews_MaintenanceRequestId_key" UNIQUE ("MaintenanceRequestId");


--
-- Name: MaintenanceReviews MaintenanceReviews_ReportId_key; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."MaintenanceReviews"
    ADD CONSTRAINT "MaintenanceReviews_ReportId_key" UNIQUE ("ReportId");


--
-- Name: MaintenanceReviews MaintenanceReviews_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."MaintenanceReviews"
    ADD CONSTRAINT "MaintenanceReviews_pkey" PRIMARY KEY ("Id");


--
-- Name: Materials Materials_Code_key; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."Materials"
    ADD CONSTRAINT "Materials_Code_key" UNIQUE ("Code");


--
-- Name: Materials Materials_Name_key; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."Materials"
    ADD CONSTRAINT "Materials_Name_key" UNIQUE ("Name");


--
-- Name: Materials Materials_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."Materials"
    ADD CONSTRAINT "Materials_pkey" PRIMARY KEY ("Id");


--
-- Name: Notifications Notifications_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."Notifications"
    ADD CONSTRAINT "Notifications_pkey" PRIMARY KEY ("Id");


--
-- Name: OutboxEvents OutboxEvents_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."OutboxEvents"
    ADD CONSTRAINT "OutboxEvents_pkey" PRIMARY KEY ("Id");


--
-- Name: ProcurementClarifications ProcurementClarifications_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ProcurementClarifications"
    ADD CONSTRAINT "ProcurementClarifications_pkey" PRIMARY KEY ("Id");


--
-- Name: ProcurementDocuments ProcurementDocuments_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ProcurementDocuments"
    ADD CONSTRAINT "ProcurementDocuments_pkey" PRIMARY KEY ("Id");


--
-- Name: ProcurementHandoffStatusHistory ProcurementHandoffStatusHistory_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ProcurementHandoffStatusHistory"
    ADD CONSTRAINT "ProcurementHandoffStatusHistory_pkey" PRIMARY KEY ("Id");


--
-- Name: ProcurementHandoffs ProcurementHandoffs_HandoffNo_key; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ProcurementHandoffs"
    ADD CONSTRAINT "ProcurementHandoffs_HandoffNo_key" UNIQUE ("HandoffNo");


--
-- Name: ProcurementHandoffs ProcurementHandoffs_MaintenanceRequestId_key; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ProcurementHandoffs"
    ADD CONSTRAINT "ProcurementHandoffs_MaintenanceRequestId_key" UNIQUE ("MaintenanceRequestId");


--
-- Name: ProcurementHandoffs ProcurementHandoffs_MaintenanceReviewId_key; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ProcurementHandoffs"
    ADD CONSTRAINT "ProcurementHandoffs_MaintenanceReviewId_key" UNIQUE ("MaintenanceReviewId");


--
-- Name: ProcurementHandoffs ProcurementHandoffs_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ProcurementHandoffs"
    ADD CONSTRAINT "ProcurementHandoffs_pkey" PRIMARY KEY ("Id");


--
-- Name: ProcurementOutcomes ProcurementOutcomes_MaintenanceRequestId_key; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ProcurementOutcomes"
    ADD CONSTRAINT "ProcurementOutcomes_MaintenanceRequestId_key" UNIQUE ("MaintenanceRequestId");


--
-- Name: ProcurementOutcomes ProcurementOutcomes_ProcurementHandoffId_key; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ProcurementOutcomes"
    ADD CONSTRAINT "ProcurementOutcomes_ProcurementHandoffId_key" UNIQUE ("ProcurementHandoffId");


--
-- Name: ProcurementOutcomes ProcurementOutcomes_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ProcurementOutcomes"
    ADD CONSTRAINT "ProcurementOutcomes_pkey" PRIMARY KEY ("Id");


--
-- Name: ReportAssessmentHistory ReportAssessmentHistory_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ReportAssessmentHistory"
    ADD CONSTRAINT "ReportAssessmentHistory_pkey" PRIMARY KEY ("Id");


--
-- Name: ReportDuplicateCandidates ReportDuplicateCandidates_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ReportDuplicateCandidates"
    ADD CONSTRAINT "ReportDuplicateCandidates_pkey" PRIMARY KEY ("Id");


--
-- Name: ReportImages ReportImages_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ReportImages"
    ADD CONSTRAINT "ReportImages_pkey" PRIMARY KEY ("Id");


--
-- Name: ReportStatusHistory ReportStatusHistory_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ReportStatusHistory"
    ADD CONSTRAINT "ReportStatusHistory_pkey" PRIMARY KEY ("Id");


--
-- Name: ReportVerifications ReportVerifications_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ReportVerifications"
    ADD CONSTRAINT "ReportVerifications_pkey" PRIMARY KEY ("Id");


--
-- Name: Reports Reports_ReportNo_key; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."Reports"
    ADD CONSTRAINT "Reports_ReportNo_key" UNIQUE ("ReportNo");


--
-- Name: Reports Reports_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."Reports"
    ADD CONSTRAINT "Reports_pkey" PRIMARY KEY ("Id");


--
-- Name: Skills Skills_Code_key; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."Skills"
    ADD CONSTRAINT "Skills_Code_key" UNIQUE ("Code");


--
-- Name: Skills Skills_Name_key; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."Skills"
    ADD CONSTRAINT "Skills_Name_key" UNIQUE ("Name");


--
-- Name: Skills Skills_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."Skills"
    ADD CONSTRAINT "Skills_pkey" PRIMARY KEY ("Id");


--
-- Name: SystemSettings SystemSettings_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."SystemSettings"
    ADD CONSTRAINT "SystemSettings_pkey" PRIMARY KEY ("Key");


--
-- Name: CategoryMaterialReferences UQ_CategoryMaterialReferences; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."CategoryMaterialReferences"
    ADD CONSTRAINT "UQ_CategoryMaterialReferences" UNIQUE ("CategoryId", "MaterialId");


--
-- Name: CategorySkillRequirements UQ_CategorySkillRequirements; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."CategorySkillRequirements"
    ADD CONSTRAINT "UQ_CategorySkillRequirements" UNIQUE ("CategoryId", "SkillId");


--
-- Name: FacilityLocations UQ_FacilityLocations_Name; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."FacilityLocations"
    ADD CONSTRAINT "UQ_FacilityLocations_Name" UNIQUE ("BuildingId", "Floor", "RoomOrArea");


--
-- Name: MaintenanceRequestRevisions UQ_MaintenanceRequestRevisions; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."MaintenanceRequestRevisions"
    ADD CONSTRAINT "UQ_MaintenanceRequestRevisions" UNIQUE ("MaintenanceRequestId", "RevisionNo");


--
-- Name: MaintenanceRequestSkills UQ_MaintenanceRequestSkills; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."MaintenanceRequestSkills"
    ADD CONSTRAINT "UQ_MaintenanceRequestSkills" UNIQUE ("MaintenanceRequestId", "SkillName");


--
-- Name: ReportAssessmentHistory UQ_ReportAssessmentHistory_Attempt; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ReportAssessmentHistory"
    ADD CONSTRAINT "UQ_ReportAssessmentHistory_Attempt" UNIQUE ("ReportId", "AgentAttemptCount");


--
-- Name: ReportDuplicateCandidates UQ_ReportDuplicateCandidates; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ReportDuplicateCandidates"
    ADD CONSTRAINT "UQ_ReportDuplicateCandidates" UNIQUE ("SourceReportId", "CandidateReportId");


--
-- Name: ReportVerifications UQ_ReportVerifications_User; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ReportVerifications"
    ADD CONSTRAINT "UQ_ReportVerifications_User" UNIQUE ("ReportId", "UserId");


--
-- Name: UserAuthChallenges UserAuthChallenges_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."UserAuthChallenges"
    ADD CONSTRAINT "UserAuthChallenges_pkey" PRIMARY KEY ("Id");


--
-- Name: Users Users_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."Users"
    ADD CONSTRAINT "Users_pkey" PRIMARY KEY ("Id");


--
-- Name: WorkOrderAssignments WorkOrderAssignments_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkOrderAssignments"
    ADD CONSTRAINT "WorkOrderAssignments_pkey" PRIMARY KEY ("Id");


--
-- Name: WorkOrderImages WorkOrderImages_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkOrderImages"
    ADD CONSTRAINT "WorkOrderImages_pkey" PRIMARY KEY ("Id");


--
-- Name: WorkOrderMaterials WorkOrderMaterials_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkOrderMaterials"
    ADD CONSTRAINT "WorkOrderMaterials_pkey" PRIMARY KEY ("Id");


--
-- Name: WorkOrderPeople WorkOrderPeople_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkOrderPeople"
    ADD CONSTRAINT "WorkOrderPeople_pkey" PRIMARY KEY ("Id");


--
-- Name: WorkOrderStatusHistory WorkOrderStatusHistory_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkOrderStatusHistory"
    ADD CONSTRAINT "WorkOrderStatusHistory_pkey" PRIMARY KEY ("Id");


--
-- Name: WorkOrderUpdates WorkOrderUpdates_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkOrderUpdates"
    ADD CONSTRAINT "WorkOrderUpdates_pkey" PRIMARY KEY ("Id");


--
-- Name: WorkOrders WorkOrders_MaintenanceRequestId_key; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkOrders"
    ADD CONSTRAINT "WorkOrders_MaintenanceRequestId_key" UNIQUE ("MaintenanceRequestId");


--
-- Name: WorkOrders WorkOrders_MaintenanceReviewId_key; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkOrders"
    ADD CONSTRAINT "WorkOrders_MaintenanceReviewId_key" UNIQUE ("MaintenanceReviewId");


--
-- Name: WorkOrders WorkOrders_ProcurementOutcomeId_key; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkOrders"
    ADD CONSTRAINT "WorkOrders_ProcurementOutcomeId_key" UNIQUE ("ProcurementOutcomeId");


--
-- Name: WorkOrders WorkOrders_WorkOrderNo_key; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkOrders"
    ADD CONSTRAINT "WorkOrders_WorkOrderNo_key" UNIQUE ("WorkOrderNo");


--
-- Name: WorkOrders WorkOrders_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkOrders"
    ADD CONSTRAINT "WorkOrders_pkey" PRIMARY KEY ("Id");


--
-- Name: WorkflowActionItems WorkflowActionItems_pkey; Type: CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkflowActionItems"
    ADD CONSTRAINT "WorkflowActionItems_pkey" PRIMARY KEY ("Id");


--
-- Name: IX_AuditLogs_Actor; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_AuditLogs_Actor" ON dbo."AuditLogs" USING btree ("ActorUserId", "CreatedAt" DESC);


--
-- Name: IX_AuditLogs_Entity; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_AuditLogs_Entity" ON dbo."AuditLogs" USING btree ("EntityType", "EntityId", "CreatedAt" DESC);


--
-- Name: IX_FacilityLocations_Building_Active; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_FacilityLocations_Building_Active" ON dbo."FacilityLocations" USING btree ("BuildingId", "IsActive", "RoomOrArea");


--
-- Name: IX_MaintenanceRequestMaterials_Request; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_MaintenanceRequestMaterials_Request" ON dbo."MaintenanceRequestMaterials" USING btree ("MaintenanceRequestId");


--
-- Name: IX_MaintenanceRequestSkills_Request; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_MaintenanceRequestSkills_Request" ON dbo."MaintenanceRequestSkills" USING btree ("MaintenanceRequestId");


--
-- Name: IX_MaintenanceRequestStatusHistory_Request; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_MaintenanceRequestStatusHistory_Request" ON dbo."MaintenanceRequestStatusHistory" USING btree ("MaintenanceRequestId", "CreatedAt");


--
-- Name: IX_MaintenanceRequests_Status; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_MaintenanceRequests_Status" ON dbo."MaintenanceRequests" USING btree ("Status", "UpdatedAt");


--
-- Name: IX_MaintenanceReviewStatusHistory_Review; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_MaintenanceReviewStatusHistory_Review" ON dbo."MaintenanceReviewStatusHistory" USING btree ("MaintenanceReviewId", "CreatedAt");


--
-- Name: IX_MaintenanceReviews_Decision; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_MaintenanceReviews_Decision" ON dbo."MaintenanceReviews" USING btree ("Decision", "ReviewedAt");


--
-- Name: IX_MaintenanceReviews_Status; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_MaintenanceReviews_Status" ON dbo."MaintenanceReviews" USING btree ("Status", "CreatedAt");


--
-- Name: IX_Notifications_User_Read; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_Notifications_User_Read" ON dbo."Notifications" USING btree ("UserId", "IsRead", "CreatedAt" DESC);


--
-- Name: IX_OutboxEvents_Queue; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_OutboxEvents_Queue" ON dbo."OutboxEvents" USING btree ("Status", "NextAttemptAt", "CreatedAt");


--
-- Name: IX_ProcurementClarifications_Handoff; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_ProcurementClarifications_Handoff" ON dbo."ProcurementClarifications" USING btree ("ProcurementHandoffId", "Status", "AskedAt");


--
-- Name: IX_ProcurementDocuments_Handoff; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_ProcurementDocuments_Handoff" ON dbo."ProcurementDocuments" USING btree ("ProcurementHandoffId", "CreatedAt");


--
-- Name: IX_ProcurementHandoffStatusHistory_Handoff; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_ProcurementHandoffStatusHistory_Handoff" ON dbo."ProcurementHandoffStatusHistory" USING btree ("ProcurementHandoffId", "CreatedAt");


--
-- Name: IX_ProcurementHandoffs_Followup; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_ProcurementHandoffs_Followup" ON dbo."ProcurementHandoffs" USING btree ("Status", "NextFollowUpAt");


--
-- Name: IX_ProcurementHandoffs_Status; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_ProcurementHandoffs_Status" ON dbo."ProcurementHandoffs" USING btree ("Status", "SubmittedAt");


--
-- Name: IX_ProcurementOutcomes_Recorded; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_ProcurementOutcomes_Recorded" ON dbo."ProcurementOutcomes" USING btree ("RecordedAt" DESC);


--
-- Name: IX_ReportAssessmentHistory_Report; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_ReportAssessmentHistory_Report" ON dbo."ReportAssessmentHistory" USING btree ("ReportId", "CreatedAt" DESC);


--
-- Name: IX_ReportImages_Report; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_ReportImages_Report" ON dbo."ReportImages" USING btree ("ReportId", "CreatedAt");


--
-- Name: IX_ReportStatusHistory_Report; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_ReportStatusHistory_Report" ON dbo."ReportStatusHistory" USING btree ("ReportId", "CreatedAt");


--
-- Name: IX_Reports_AgentQueue; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_Reports_AgentQueue" ON dbo."Reports" USING btree ("AgentStatus", "AgentNextRetryAt", "CreatedAt");


--
-- Name: IX_Reports_FinalCategory; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_Reports_FinalCategory" ON dbo."Reports" USING btree ("FinalCategory", "CreatedAt" DESC);


--
-- Name: IX_Reports_Location; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_Reports_Location" ON dbo."Reports" USING btree ("LocationId", "CreatedAt" DESC);


--
-- Name: IX_Reports_Reporter_Created; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_Reports_Reporter_Created" ON dbo."Reports" USING btree ("ReporterId", "CreatedAt" DESC);


--
-- Name: IX_Reports_Status_Created; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_Reports_Status_Created" ON dbo."Reports" USING btree ("Status", "CreatedAt");


--
-- Name: IX_UserAuthChallenges_Cleanup; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_UserAuthChallenges_Cleanup" ON dbo."UserAuthChallenges" USING btree ("ExpiresAt");


--
-- Name: IX_UserAuthChallenges_UserPurpose; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_UserAuthChallenges_UserPurpose" ON dbo."UserAuthChallenges" USING btree ("UserId", "Purpose", "CreatedAt" DESC);


--
-- Name: IX_Users_Role_Active; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_Users_Role_Active" ON dbo."Users" USING btree ("Role", "IsActive");


--
-- Name: IX_WorkOrderAssignments_WorkOrder; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_WorkOrderAssignments_WorkOrder" ON dbo."WorkOrderAssignments" USING btree ("WorkOrderId", "AssignedAt" DESC);


--
-- Name: IX_WorkOrderImages_WorkOrder; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_WorkOrderImages_WorkOrder" ON dbo."WorkOrderImages" USING btree ("WorkOrderId", "ImageType", "CreatedAt");


--
-- Name: IX_WorkOrderMaterials_WorkOrder; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_WorkOrderMaterials_WorkOrder" ON dbo."WorkOrderMaterials" USING btree ("WorkOrderId", "Stage", "CreatedAt");


--
-- Name: IX_WorkOrderPeople_WorkOrder; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_WorkOrderPeople_WorkOrder" ON dbo."WorkOrderPeople" USING btree ("WorkOrderId", "IsLead" DESC, "CreatedAt");


--
-- Name: IX_WorkOrderStatusHistory_WorkOrder; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_WorkOrderStatusHistory_WorkOrder" ON dbo."WorkOrderStatusHistory" USING btree ("WorkOrderId", "CreatedAt");


--
-- Name: IX_WorkOrderUpdates_WorkOrder; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_WorkOrderUpdates_WorkOrder" ON dbo."WorkOrderUpdates" USING btree ("WorkOrderId", "CreatedAt" DESC);


--
-- Name: IX_WorkOrders_Lead_Status; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_WorkOrders_Lead_Status" ON dbo."WorkOrders" USING btree ("ResponsibleLeadUserId", "Status", "Deadline");


--
-- Name: IX_WorkOrders_Report; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_WorkOrders_Report" ON dbo."WorkOrders" USING btree ("ReportId");


--
-- Name: IX_WorkOrders_Route; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_WorkOrders_Route" ON dbo."WorkOrders" USING btree ("RouteType", "CreatedAt");


--
-- Name: IX_WorkOrders_Status; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_WorkOrders_Status" ON dbo."WorkOrders" USING btree ("Status", "CreatedAt");


--
-- Name: IX_WorkflowActionItems_Open; Type: INDEX; Schema: dbo; Owner: -
--

CREATE INDEX "IX_WorkflowActionItems_Open" ON dbo."WorkflowActionItems" USING btree ("Status", "AssignedRole", "AssignedUserId", "Priority", "DueAt");


--
-- Name: UX_FacilityLocations_Code; Type: INDEX; Schema: dbo; Owner: -
--

CREATE UNIQUE INDEX "UX_FacilityLocations_Code" ON dbo."FacilityLocations" USING btree ("Code") WHERE ("Code" IS NOT NULL);


--
-- Name: UX_Notifications_Dedupe; Type: INDEX; Schema: dbo; Owner: -
--

CREATE UNIQUE INDEX "UX_Notifications_Dedupe" ON dbo."Notifications" USING btree ("UserId", (("Payload" ->> 'deduplicationKey'::text))) WHERE (("Payload" ->> 'deduplicationKey'::text) IS NOT NULL);


--
-- Name: UX_OutboxEvents_Dedupe; Type: INDEX; Schema: dbo; Owner: -
--

CREATE UNIQUE INDEX "UX_OutboxEvents_Dedupe" ON dbo."OutboxEvents" USING btree ("DeduplicationKey") WHERE ("DeduplicationKey" IS NOT NULL);


--
-- Name: UX_ReportImages_OnePrimary; Type: INDEX; Schema: dbo; Owner: -
--

CREATE UNIQUE INDEX "UX_ReportImages_OnePrimary" ON dbo."ReportImages" USING btree ("ReportId") WHERE ("IsPrimary" = true);


--
-- Name: UX_Reports_OneActivePerReporter; Type: INDEX; Schema: dbo; Owner: -
--

CREATE UNIQUE INDEX "UX_Reports_OneActivePerReporter" ON dbo."Reports" USING btree ("ReporterId") WHERE (("Status")::text <> ALL (ARRAY[('RESOLVED'::character varying)::text, ('CANCELLED'::character varying)::text, ('NO_ACTION'::character varying)::text, ('DUPLICATE'::character varying)::text]));


--
-- Name: UX_Users_Email_CI; Type: INDEX; Schema: dbo; Owner: -
--

CREATE UNIQUE INDEX "UX_Users_Email_CI" ON dbo."Users" USING btree (lower(("Email")::text));


--
-- Name: UX_Users_InstitutionalId; Type: INDEX; Schema: dbo; Owner: -
--

CREATE UNIQUE INDEX "UX_Users_InstitutionalId" ON dbo."Users" USING btree ("InstitutionalId") WHERE ("InstitutionalId" IS NOT NULL);


--
-- Name: UX_Users_Username_CI; Type: INDEX; Schema: dbo; Owner: -
--

CREATE UNIQUE INDEX "UX_Users_Username_CI" ON dbo."Users" USING btree (lower(("Username")::text)) WHERE ("Username" IS NOT NULL);


--
-- Name: UX_WorkflowActionItems_OpenAction; Type: INDEX; Schema: dbo; Owner: -
--

CREATE UNIQUE INDEX "UX_WorkflowActionItems_OpenAction" ON dbo."WorkflowActionItems" USING btree ("EntityType", "EntityId", "ActionType") WHERE (("Status")::text = 'OPEN'::text);


--
-- Name: ProcurementHandoffs CT_ProcurementHandoffs_Route; Type: TRIGGER; Schema: dbo; Owner: -
--

CREATE CONSTRAINT TRIGGER "CT_ProcurementHandoffs_Route" AFTER INSERT OR UPDATE ON dbo."ProcurementHandoffs" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dbo."EnsureProcurementHandoffRoute"();


--
-- Name: ProcurementOutcomes CT_ProcurementOutcomes_Consistency; Type: TRIGGER; Schema: dbo; Owner: -
--

CREATE CONSTRAINT TRIGGER "CT_ProcurementOutcomes_Consistency" AFTER INSERT OR UPDATE ON dbo."ProcurementOutcomes" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dbo."EnsureProcurementOutcomeConsistency"();


--
-- Name: ReportImages CT_ReportImages_RequireImage; Type: TRIGGER; Schema: dbo; Owner: -
--

CREATE CONSTRAINT TRIGGER "CT_ReportImages_RequireImage" AFTER INSERT OR DELETE OR UPDATE ON dbo."ReportImages" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dbo."EnsureReportHasImageFromImage"();


--
-- Name: Reports CT_Reports_RequireImage; Type: TRIGGER; Schema: dbo; Owner: -
--

CREATE CONSTRAINT TRIGGER "CT_Reports_RequireImage" AFTER INSERT OR UPDATE ON dbo."Reports" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dbo."EnsureReportHasImageFromReport"();


--
-- Name: WorkOrderImages CT_WorkOrderImages_RequireCompletionEvidence; Type: TRIGGER; Schema: dbo; Owner: -
--

CREATE CONSTRAINT TRIGGER "CT_WorkOrderImages_RequireCompletionEvidence" AFTER INSERT OR DELETE OR UPDATE ON dbo."WorkOrderImages" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dbo."EnsureWorkOrderHasCompletionEvidenceFromImage"();


--
-- Name: WorkOrders CT_WorkOrders_RequireCompletionEvidence; Type: TRIGGER; Schema: dbo; Owner: -
--

CREATE CONSTRAINT TRIGGER "CT_WorkOrders_RequireCompletionEvidence" AFTER INSERT OR UPDATE ON dbo."WorkOrders" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dbo."EnsureWorkOrderHasCompletionEvidenceFromWorkOrder"();


--
-- Name: WorkOrders CT_WorkOrders_RouteConsistency; Type: TRIGGER; Schema: dbo; Owner: -
--

CREATE CONSTRAINT TRIGGER "CT_WorkOrders_RouteConsistency" AFTER INSERT OR UPDATE ON dbo."WorkOrders" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dbo."EnsureWorkOrderRouteConsistency"();


--
-- Name: Buildings TR_Buildings_UpdatedAt; Type: TRIGGER; Schema: dbo; Owner: -
--

CREATE TRIGGER "TR_Buildings_UpdatedAt" BEFORE UPDATE ON dbo."Buildings" FOR EACH ROW EXECUTE FUNCTION dbo."SetUpdatedAt"();


--
-- Name: DamageCategories TR_DamageCategories_UpdatedAt; Type: TRIGGER; Schema: dbo; Owner: -
--

CREATE TRIGGER "TR_DamageCategories_UpdatedAt" BEFORE UPDATE ON dbo."DamageCategories" FOR EACH ROW EXECUTE FUNCTION dbo."SetUpdatedAt"();


--
-- Name: FacilityLocations TR_FacilityLocations_UpdatedAt; Type: TRIGGER; Schema: dbo; Owner: -
--

CREATE TRIGGER "TR_FacilityLocations_UpdatedAt" BEFORE UPDATE ON dbo."FacilityLocations" FOR EACH ROW EXECUTE FUNCTION dbo."SetUpdatedAt"();


--
-- Name: MaintenanceRequests TR_MaintenanceRequests_GuardLateDraft; Type: TRIGGER; Schema: dbo; Owner: -
--

CREATE TRIGGER "TR_MaintenanceRequests_GuardLateDraft" BEFORE INSERT OR UPDATE ON dbo."MaintenanceRequests" FOR EACH ROW EXECUTE FUNCTION dbo."GuardLateMaintenanceDraft"();


--
-- Name: MaintenanceRequests TR_MaintenanceRequests_LogStatusHistory; Type: TRIGGER; Schema: dbo; Owner: -
--

CREATE TRIGGER "TR_MaintenanceRequests_LogStatusHistory" AFTER INSERT OR UPDATE ON dbo."MaintenanceRequests" FOR EACH ROW EXECUTE FUNCTION dbo."LogMaintenanceRequestStatusHistory"();


--
-- Name: MaintenanceRequests TR_MaintenanceRequests_UpdatedAt; Type: TRIGGER; Schema: dbo; Owner: -
--

CREATE TRIGGER "TR_MaintenanceRequests_UpdatedAt" BEFORE UPDATE ON dbo."MaintenanceRequests" FOR EACH ROW EXECUTE FUNCTION dbo."SetUpdatedAt"();


--
-- Name: MaintenanceReviews TR_MaintenanceReviews_ApplyCompleted; Type: TRIGGER; Schema: dbo; Owner: -
--

CREATE TRIGGER "TR_MaintenanceReviews_ApplyCompleted" AFTER INSERT OR UPDATE ON dbo."MaintenanceReviews" FOR EACH ROW WHEN (((new."Status")::text = 'COMPLETED'::text)) EXECUTE FUNCTION dbo."ApplyCompletedMaintenanceReview"();


--
-- Name: MaintenanceReviews TR_MaintenanceReviews_LogStatusHistory; Type: TRIGGER; Schema: dbo; Owner: -
--

CREATE TRIGGER "TR_MaintenanceReviews_LogStatusHistory" AFTER INSERT OR UPDATE ON dbo."MaintenanceReviews" FOR EACH ROW EXECUTE FUNCTION dbo."LogMaintenanceReviewStatusHistory"();


--
-- Name: MaintenanceReviews TR_MaintenanceReviews_UpdatedAt; Type: TRIGGER; Schema: dbo; Owner: -
--

CREATE TRIGGER "TR_MaintenanceReviews_UpdatedAt" BEFORE UPDATE ON dbo."MaintenanceReviews" FOR EACH ROW EXECUTE FUNCTION dbo."SetUpdatedAt"();


--
-- Name: Materials TR_Materials_UpdatedAt; Type: TRIGGER; Schema: dbo; Owner: -
--

CREATE TRIGGER "TR_Materials_UpdatedAt" BEFORE UPDATE ON dbo."Materials" FOR EACH ROW EXECUTE FUNCTION dbo."SetUpdatedAt"();


--
-- Name: Notifications TR_Notifications_UpdatedAt; Type: TRIGGER; Schema: dbo; Owner: -
--

CREATE TRIGGER "TR_Notifications_UpdatedAt" BEFORE UPDATE ON dbo."Notifications" FOR EACH ROW EXECUTE FUNCTION dbo."SetUpdatedAt"();


--
-- Name: ProcurementClarifications TR_ProcurementClarifications_UpdatedAt; Type: TRIGGER; Schema: dbo; Owner: -
--

CREATE TRIGGER "TR_ProcurementClarifications_UpdatedAt" BEFORE UPDATE ON dbo."ProcurementClarifications" FOR EACH ROW EXECUTE FUNCTION dbo."SetUpdatedAt"();


--
-- Name: ProcurementHandoffs TR_ProcurementHandoffs_LogStatusHistory; Type: TRIGGER; Schema: dbo; Owner: -
--

CREATE TRIGGER "TR_ProcurementHandoffs_LogStatusHistory" AFTER INSERT OR UPDATE ON dbo."ProcurementHandoffs" FOR EACH ROW EXECUTE FUNCTION dbo."LogProcurementHandoffStatusHistory"();


--
-- Name: ProcurementHandoffs TR_ProcurementHandoffs_SyncState; Type: TRIGGER; Schema: dbo; Owner: -
--

CREATE TRIGGER "TR_ProcurementHandoffs_SyncState" AFTER INSERT OR UPDATE OF "Status" ON dbo."ProcurementHandoffs" FOR EACH ROW EXECUTE FUNCTION dbo."SyncProcurementHandoffState"();


--
-- Name: ProcurementHandoffs TR_ProcurementHandoffs_UpdatedAt; Type: TRIGGER; Schema: dbo; Owner: -
--

CREATE TRIGGER "TR_ProcurementHandoffs_UpdatedAt" BEFORE UPDATE ON dbo."ProcurementHandoffs" FOR EACH ROW EXECUTE FUNCTION dbo."SetUpdatedAt"();


--
-- Name: ProcurementOutcomes TR_ProcurementOutcomes_UpdatedAt; Type: TRIGGER; Schema: dbo; Owner: -
--

CREATE TRIGGER "TR_ProcurementOutcomes_UpdatedAt" BEFORE UPDATE ON dbo."ProcurementOutcomes" FOR EACH ROW EXECUTE FUNCTION dbo."SetUpdatedAt"();


--
-- Name: ReportVerifications TR_ReportVerifications_RefreshCount; Type: TRIGGER; Schema: dbo; Owner: -
--

CREATE TRIGGER "TR_ReportVerifications_RefreshCount" AFTER INSERT OR DELETE OR UPDATE ON dbo."ReportVerifications" FOR EACH ROW EXECUTE FUNCTION dbo."RefreshReportVerificationCount"();


--
-- Name: Reports TR_Reports_AdvanceAfterAgent; Type: TRIGGER; Schema: dbo; Owner: -
--

CREATE TRIGGER "TR_Reports_AdvanceAfterAgent" BEFORE UPDATE ON dbo."Reports" FOR EACH ROW EXECUTE FUNCTION dbo."AdvanceReportAfterAgentAssessment"();


--
-- Name: Reports TR_Reports_GuardCancelledMutation; Type: TRIGGER; Schema: dbo; Owner: -
--

CREATE TRIGGER "TR_Reports_GuardCancelledMutation" BEFORE UPDATE ON dbo."Reports" FOR EACH ROW EXECUTE FUNCTION dbo."GuardCancelledReportMutation"();


--
-- Name: Reports TR_Reports_LogStatusHistory; Type: TRIGGER; Schema: dbo; Owner: -
--

CREATE TRIGGER "TR_Reports_LogStatusHistory" AFTER INSERT OR UPDATE ON dbo."Reports" FOR EACH ROW EXECUTE FUNCTION dbo."LogReportStatusHistory"();


--
-- Name: Reports TR_Reports_UpdatedAt; Type: TRIGGER; Schema: dbo; Owner: -
--

CREATE TRIGGER "TR_Reports_UpdatedAt" BEFORE UPDATE ON dbo."Reports" FOR EACH ROW EXECUTE FUNCTION dbo."SetUpdatedAt"();


--
-- Name: Skills TR_Skills_UpdatedAt; Type: TRIGGER; Schema: dbo; Owner: -
--

CREATE TRIGGER "TR_Skills_UpdatedAt" BEFORE UPDATE ON dbo."Skills" FOR EACH ROW EXECUTE FUNCTION dbo."SetUpdatedAt"();


--
-- Name: Users TR_Users_UpdatedAt; Type: TRIGGER; Schema: dbo; Owner: -
--

CREATE TRIGGER "TR_Users_UpdatedAt" BEFORE UPDATE ON dbo."Users" FOR EACH ROW EXECUTE FUNCTION dbo."SetUpdatedAt"();


--
-- Name: WorkOrders TR_WorkOrders_LogAssignment; Type: TRIGGER; Schema: dbo; Owner: -
--

CREATE TRIGGER "TR_WorkOrders_LogAssignment" AFTER INSERT OR UPDATE ON dbo."WorkOrders" FOR EACH ROW EXECUTE FUNCTION dbo."LogWorkOrderAssignment"();


--
-- Name: WorkOrders TR_WorkOrders_LogStatusHistory; Type: TRIGGER; Schema: dbo; Owner: -
--

CREATE TRIGGER "TR_WorkOrders_LogStatusHistory" AFTER INSERT OR UPDATE ON dbo."WorkOrders" FOR EACH ROW EXECUTE FUNCTION dbo."LogWorkOrderStatusHistory"();


--
-- Name: WorkOrders TR_WorkOrders_SyncReportRequest; Type: TRIGGER; Schema: dbo; Owner: -
--

CREATE TRIGGER "TR_WorkOrders_SyncReportRequest" AFTER INSERT OR UPDATE OF "Status" ON dbo."WorkOrders" FOR EACH ROW EXECUTE FUNCTION dbo."SyncReportAndRequestFromWorkOrder"();


--
-- Name: WorkOrders TR_WorkOrders_UpdatedAt; Type: TRIGGER; Schema: dbo; Owner: -
--

CREATE TRIGGER "TR_WorkOrders_UpdatedAt" BEFORE UPDATE ON dbo."WorkOrders" FOR EACH ROW EXECUTE FUNCTION dbo."SetUpdatedAt"();


--
-- Name: WorkflowActionItems TR_WorkflowActionItems_UpdatedAt; Type: TRIGGER; Schema: dbo; Owner: -
--

CREATE TRIGGER "TR_WorkflowActionItems_UpdatedAt" BEFORE UPDATE ON dbo."WorkflowActionItems" FOR EACH ROW EXECUTE FUNCTION dbo."SetUpdatedAt"();


--
-- Name: AuditLogs AuditLogs_ActorUserId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."AuditLogs"
    ADD CONSTRAINT "AuditLogs_ActorUserId_fkey" FOREIGN KEY ("ActorUserId") REFERENCES dbo."Users"("Id") ON DELETE SET NULL;


--
-- Name: CategoryMaterialReferences CategoryMaterialReferences_CategoryId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."CategoryMaterialReferences"
    ADD CONSTRAINT "CategoryMaterialReferences_CategoryId_fkey" FOREIGN KEY ("CategoryId") REFERENCES dbo."DamageCategories"("Id") ON DELETE CASCADE;


--
-- Name: CategoryMaterialReferences CategoryMaterialReferences_MaterialId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."CategoryMaterialReferences"
    ADD CONSTRAINT "CategoryMaterialReferences_MaterialId_fkey" FOREIGN KEY ("MaterialId") REFERENCES dbo."Materials"("Id") ON DELETE RESTRICT;


--
-- Name: CategorySkillRequirements CategorySkillRequirements_CategoryId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."CategorySkillRequirements"
    ADD CONSTRAINT "CategorySkillRequirements_CategoryId_fkey" FOREIGN KEY ("CategoryId") REFERENCES dbo."DamageCategories"("Id") ON DELETE CASCADE;


--
-- Name: CategorySkillRequirements CategorySkillRequirements_SkillId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."CategorySkillRequirements"
    ADD CONSTRAINT "CategorySkillRequirements_SkillId_fkey" FOREIGN KEY ("SkillId") REFERENCES dbo."Skills"("Id") ON DELETE RESTRICT;


--
-- Name: FacilityLocations FacilityLocations_BuildingId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."FacilityLocations"
    ADD CONSTRAINT "FacilityLocations_BuildingId_fkey" FOREIGN KEY ("BuildingId") REFERENCES dbo."Buildings"("Id") ON DELETE RESTRICT;


--
-- Name: MaintenanceRequestMaterials MaintenanceRequestMaterials_MaintenanceRequestId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."MaintenanceRequestMaterials"
    ADD CONSTRAINT "MaintenanceRequestMaterials_MaintenanceRequestId_fkey" FOREIGN KEY ("MaintenanceRequestId") REFERENCES dbo."MaintenanceRequests"("Id") ON DELETE CASCADE;


--
-- Name: MaintenanceRequestMaterials MaintenanceRequestMaterials_MaterialId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."MaintenanceRequestMaterials"
    ADD CONSTRAINT "MaintenanceRequestMaterials_MaterialId_fkey" FOREIGN KEY ("MaterialId") REFERENCES dbo."Materials"("Id") ON DELETE SET NULL;


--
-- Name: MaintenanceRequestRevisions MaintenanceRequestRevisions_CreatedBy_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."MaintenanceRequestRevisions"
    ADD CONSTRAINT "MaintenanceRequestRevisions_CreatedBy_fkey" FOREIGN KEY ("CreatedBy") REFERENCES dbo."Users"("Id") ON DELETE SET NULL;


--
-- Name: MaintenanceRequestRevisions MaintenanceRequestRevisions_MaintenanceRequestId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."MaintenanceRequestRevisions"
    ADD CONSTRAINT "MaintenanceRequestRevisions_MaintenanceRequestId_fkey" FOREIGN KEY ("MaintenanceRequestId") REFERENCES dbo."MaintenanceRequests"("Id") ON DELETE CASCADE;


--
-- Name: MaintenanceRequestSkills MaintenanceRequestSkills_MaintenanceRequestId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."MaintenanceRequestSkills"
    ADD CONSTRAINT "MaintenanceRequestSkills_MaintenanceRequestId_fkey" FOREIGN KEY ("MaintenanceRequestId") REFERENCES dbo."MaintenanceRequests"("Id") ON DELETE CASCADE;


--
-- Name: MaintenanceRequestSkills MaintenanceRequestSkills_SkillId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."MaintenanceRequestSkills"
    ADD CONSTRAINT "MaintenanceRequestSkills_SkillId_fkey" FOREIGN KEY ("SkillId") REFERENCES dbo."Skills"("Id") ON DELETE SET NULL;


--
-- Name: MaintenanceRequestStatusHistory MaintenanceRequestStatusHistory_ChangedBy_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."MaintenanceRequestStatusHistory"
    ADD CONSTRAINT "MaintenanceRequestStatusHistory_ChangedBy_fkey" FOREIGN KEY ("ChangedBy") REFERENCES dbo."Users"("Id") ON DELETE SET NULL;


--
-- Name: MaintenanceRequestStatusHistory MaintenanceRequestStatusHistory_MaintenanceRequestId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."MaintenanceRequestStatusHistory"
    ADD CONSTRAINT "MaintenanceRequestStatusHistory_MaintenanceRequestId_fkey" FOREIGN KEY ("MaintenanceRequestId") REFERENCES dbo."MaintenanceRequests"("Id") ON DELETE CASCADE;


--
-- Name: MaintenanceRequests MaintenanceRequests_AuthorizedBy_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."MaintenanceRequests"
    ADD CONSTRAINT "MaintenanceRequests_AuthorizedBy_fkey" FOREIGN KEY ("AuthorizedBy") REFERENCES dbo."Users"("Id") ON DELETE SET NULL;


--
-- Name: MaintenanceRequests MaintenanceRequests_CreatedBy_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."MaintenanceRequests"
    ADD CONSTRAINT "MaintenanceRequests_CreatedBy_fkey" FOREIGN KEY ("CreatedBy") REFERENCES dbo."Users"("Id") ON DELETE SET NULL;


--
-- Name: MaintenanceRequests MaintenanceRequests_EffectiveCategory_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."MaintenanceRequests"
    ADD CONSTRAINT "MaintenanceRequests_EffectiveCategory_fkey" FOREIGN KEY ("EffectiveCategory") REFERENCES dbo."DamageCategories"("Name") ON UPDATE CASCADE;


--
-- Name: MaintenanceRequests MaintenanceRequests_ReportId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."MaintenanceRequests"
    ADD CONSTRAINT "MaintenanceRequests_ReportId_fkey" FOREIGN KEY ("ReportId") REFERENCES dbo."Reports"("Id") ON DELETE RESTRICT;


--
-- Name: MaintenanceReviewStatusHistory MaintenanceReviewStatusHistory_ChangedBy_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."MaintenanceReviewStatusHistory"
    ADD CONSTRAINT "MaintenanceReviewStatusHistory_ChangedBy_fkey" FOREIGN KEY ("ChangedBy") REFERENCES dbo."Users"("Id") ON DELETE SET NULL;


--
-- Name: MaintenanceReviewStatusHistory MaintenanceReviewStatusHistory_MaintenanceReviewId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."MaintenanceReviewStatusHistory"
    ADD CONSTRAINT "MaintenanceReviewStatusHistory_MaintenanceReviewId_fkey" FOREIGN KEY ("MaintenanceReviewId") REFERENCES dbo."MaintenanceReviews"("Id") ON DELETE CASCADE;


--
-- Name: MaintenanceReviews MaintenanceReviews_FinalCategory_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."MaintenanceReviews"
    ADD CONSTRAINT "MaintenanceReviews_FinalCategory_fkey" FOREIGN KEY ("FinalCategory") REFERENCES dbo."DamageCategories"("Name") ON UPDATE CASCADE;


--
-- Name: MaintenanceReviews MaintenanceReviews_MaintenanceRequestId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."MaintenanceReviews"
    ADD CONSTRAINT "MaintenanceReviews_MaintenanceRequestId_fkey" FOREIGN KEY ("MaintenanceRequestId") REFERENCES dbo."MaintenanceRequests"("Id") ON DELETE RESTRICT;


--
-- Name: MaintenanceReviews MaintenanceReviews_ReportId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."MaintenanceReviews"
    ADD CONSTRAINT "MaintenanceReviews_ReportId_fkey" FOREIGN KEY ("ReportId") REFERENCES dbo."Reports"("Id") ON DELETE RESTRICT;


--
-- Name: MaintenanceReviews MaintenanceReviews_ReviewedBy_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."MaintenanceReviews"
    ADD CONSTRAINT "MaintenanceReviews_ReviewedBy_fkey" FOREIGN KEY ("ReviewedBy") REFERENCES dbo."Users"("Id") ON DELETE SET NULL;


--
-- Name: Notifications Notifications_UserId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."Notifications"
    ADD CONSTRAINT "Notifications_UserId_fkey" FOREIGN KEY ("UserId") REFERENCES dbo."Users"("Id") ON DELETE CASCADE;


--
-- Name: OutboxEvents OutboxEvents_RecipientUserId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."OutboxEvents"
    ADD CONSTRAINT "OutboxEvents_RecipientUserId_fkey" FOREIGN KEY ("RecipientUserId") REFERENCES dbo."Users"("Id") ON DELETE SET NULL;


--
-- Name: ProcurementClarifications ProcurementClarifications_AnsweredBy_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ProcurementClarifications"
    ADD CONSTRAINT "ProcurementClarifications_AnsweredBy_fkey" FOREIGN KEY ("AnsweredBy") REFERENCES dbo."Users"("Id") ON DELETE SET NULL;


--
-- Name: ProcurementClarifications ProcurementClarifications_AskedByUserId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ProcurementClarifications"
    ADD CONSTRAINT "ProcurementClarifications_AskedByUserId_fkey" FOREIGN KEY ("AskedByUserId") REFERENCES dbo."Users"("Id") ON DELETE SET NULL;


--
-- Name: ProcurementClarifications ProcurementClarifications_ProcurementHandoffId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ProcurementClarifications"
    ADD CONSTRAINT "ProcurementClarifications_ProcurementHandoffId_fkey" FOREIGN KEY ("ProcurementHandoffId") REFERENCES dbo."ProcurementHandoffs"("Id") ON DELETE CASCADE;


--
-- Name: ProcurementDocuments ProcurementDocuments_ClarificationId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ProcurementDocuments"
    ADD CONSTRAINT "ProcurementDocuments_ClarificationId_fkey" FOREIGN KEY ("ClarificationId") REFERENCES dbo."ProcurementClarifications"("Id") ON DELETE SET NULL;


--
-- Name: ProcurementDocuments ProcurementDocuments_ProcurementHandoffId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ProcurementDocuments"
    ADD CONSTRAINT "ProcurementDocuments_ProcurementHandoffId_fkey" FOREIGN KEY ("ProcurementHandoffId") REFERENCES dbo."ProcurementHandoffs"("Id") ON DELETE CASCADE;


--
-- Name: ProcurementDocuments ProcurementDocuments_UploadedBy_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ProcurementDocuments"
    ADD CONSTRAINT "ProcurementDocuments_UploadedBy_fkey" FOREIGN KEY ("UploadedBy") REFERENCES dbo."Users"("Id") ON DELETE SET NULL;


--
-- Name: ProcurementHandoffStatusHistory ProcurementHandoffStatusHistory_ChangedBy_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ProcurementHandoffStatusHistory"
    ADD CONSTRAINT "ProcurementHandoffStatusHistory_ChangedBy_fkey" FOREIGN KEY ("ChangedBy") REFERENCES dbo."Users"("Id") ON DELETE SET NULL;


--
-- Name: ProcurementHandoffStatusHistory ProcurementHandoffStatusHistory_ProcurementHandoffId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ProcurementHandoffStatusHistory"
    ADD CONSTRAINT "ProcurementHandoffStatusHistory_ProcurementHandoffId_fkey" FOREIGN KEY ("ProcurementHandoffId") REFERENCES dbo."ProcurementHandoffs"("Id") ON DELETE CASCADE;


--
-- Name: ProcurementHandoffs ProcurementHandoffs_AcknowledgedBy_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ProcurementHandoffs"
    ADD CONSTRAINT "ProcurementHandoffs_AcknowledgedBy_fkey" FOREIGN KEY ("AcknowledgedBy") REFERENCES dbo."Users"("Id") ON DELETE SET NULL;


--
-- Name: ProcurementHandoffs ProcurementHandoffs_CompletedBy_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ProcurementHandoffs"
    ADD CONSTRAINT "ProcurementHandoffs_CompletedBy_fkey" FOREIGN KEY ("CompletedBy") REFERENCES dbo."Users"("Id") ON DELETE SET NULL;


--
-- Name: ProcurementHandoffs ProcurementHandoffs_MaintenanceRequestId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ProcurementHandoffs"
    ADD CONSTRAINT "ProcurementHandoffs_MaintenanceRequestId_fkey" FOREIGN KEY ("MaintenanceRequestId") REFERENCES dbo."MaintenanceRequests"("Id") ON DELETE RESTRICT;


--
-- Name: ProcurementHandoffs ProcurementHandoffs_MaintenanceReviewId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ProcurementHandoffs"
    ADD CONSTRAINT "ProcurementHandoffs_MaintenanceReviewId_fkey" FOREIGN KEY ("MaintenanceReviewId") REFERENCES dbo."MaintenanceReviews"("Id") ON DELETE RESTRICT;


--
-- Name: ProcurementHandoffs ProcurementHandoffs_SubmittedBy_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ProcurementHandoffs"
    ADD CONSTRAINT "ProcurementHandoffs_SubmittedBy_fkey" FOREIGN KEY ("SubmittedBy") REFERENCES dbo."Users"("Id") ON DELETE SET NULL;


--
-- Name: ProcurementHandoffs ProcurementHandoffs_SubmittedRevisionId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ProcurementHandoffs"
    ADD CONSTRAINT "ProcurementHandoffs_SubmittedRevisionId_fkey" FOREIGN KEY ("SubmittedRevisionId") REFERENCES dbo."MaintenanceRequestRevisions"("Id") ON DELETE SET NULL;


--
-- Name: ProcurementOutcomes ProcurementOutcomes_MaintenanceRequestId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ProcurementOutcomes"
    ADD CONSTRAINT "ProcurementOutcomes_MaintenanceRequestId_fkey" FOREIGN KEY ("MaintenanceRequestId") REFERENCES dbo."MaintenanceRequests"("Id") ON DELETE RESTRICT;


--
-- Name: ProcurementOutcomes ProcurementOutcomes_ProcurementHandoffId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ProcurementOutcomes"
    ADD CONSTRAINT "ProcurementOutcomes_ProcurementHandoffId_fkey" FOREIGN KEY ("ProcurementHandoffId") REFERENCES dbo."ProcurementHandoffs"("Id") ON DELETE RESTRICT;


--
-- Name: ProcurementOutcomes ProcurementOutcomes_RecordedBy_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ProcurementOutcomes"
    ADD CONSTRAINT "ProcurementOutcomes_RecordedBy_fkey" FOREIGN KEY ("RecordedBy") REFERENCES dbo."Users"("Id") ON DELETE RESTRICT;


--
-- Name: ProcurementOutcomes ProcurementOutcomes_ReferenceDocumentId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ProcurementOutcomes"
    ADD CONSTRAINT "ProcurementOutcomes_ReferenceDocumentId_fkey" FOREIGN KEY ("ReferenceDocumentId") REFERENCES dbo."ProcurementDocuments"("Id") ON DELETE SET NULL;


--
-- Name: ProcurementOutcomes ProcurementOutcomes_ResponsibleLeadUserId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ProcurementOutcomes"
    ADD CONSTRAINT "ProcurementOutcomes_ResponsibleLeadUserId_fkey" FOREIGN KEY ("ResponsibleLeadUserId") REFERENCES dbo."Users"("Id") ON DELETE SET NULL;


--
-- Name: ReportAssessmentHistory ReportAssessmentHistory_ReportId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ReportAssessmentHistory"
    ADD CONSTRAINT "ReportAssessmentHistory_ReportId_fkey" FOREIGN KEY ("ReportId") REFERENCES dbo."Reports"("Id") ON DELETE CASCADE;


--
-- Name: ReportDuplicateCandidates ReportDuplicateCandidates_CandidateReportId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ReportDuplicateCandidates"
    ADD CONSTRAINT "ReportDuplicateCandidates_CandidateReportId_fkey" FOREIGN KEY ("CandidateReportId") REFERENCES dbo."Reports"("Id") ON DELETE CASCADE;


--
-- Name: ReportDuplicateCandidates ReportDuplicateCandidates_ReviewedBy_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ReportDuplicateCandidates"
    ADD CONSTRAINT "ReportDuplicateCandidates_ReviewedBy_fkey" FOREIGN KEY ("ReviewedBy") REFERENCES dbo."Users"("Id") ON DELETE SET NULL;


--
-- Name: ReportDuplicateCandidates ReportDuplicateCandidates_SourceReportId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ReportDuplicateCandidates"
    ADD CONSTRAINT "ReportDuplicateCandidates_SourceReportId_fkey" FOREIGN KEY ("SourceReportId") REFERENCES dbo."Reports"("Id") ON DELETE CASCADE;


--
-- Name: ReportImages ReportImages_ReportId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ReportImages"
    ADD CONSTRAINT "ReportImages_ReportId_fkey" FOREIGN KEY ("ReportId") REFERENCES dbo."Reports"("Id") ON DELETE CASCADE;


--
-- Name: ReportStatusHistory ReportStatusHistory_ChangedBy_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ReportStatusHistory"
    ADD CONSTRAINT "ReportStatusHistory_ChangedBy_fkey" FOREIGN KEY ("ChangedBy") REFERENCES dbo."Users"("Id") ON DELETE SET NULL;


--
-- Name: ReportStatusHistory ReportStatusHistory_ReportId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ReportStatusHistory"
    ADD CONSTRAINT "ReportStatusHistory_ReportId_fkey" FOREIGN KEY ("ReportId") REFERENCES dbo."Reports"("Id") ON DELETE CASCADE;


--
-- Name: ReportVerifications ReportVerifications_ReportId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ReportVerifications"
    ADD CONSTRAINT "ReportVerifications_ReportId_fkey" FOREIGN KEY ("ReportId") REFERENCES dbo."Reports"("Id") ON DELETE CASCADE;


--
-- Name: ReportVerifications ReportVerifications_UserId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."ReportVerifications"
    ADD CONSTRAINT "ReportVerifications_UserId_fkey" FOREIGN KEY ("UserId") REFERENCES dbo."Users"("Id") ON DELETE CASCADE;


--
-- Name: Reports Reports_LocationId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."Reports"
    ADD CONSTRAINT "Reports_LocationId_fkey" FOREIGN KEY ("LocationId") REFERENCES dbo."FacilityLocations"("Id") ON DELETE SET NULL;


--
-- Name: Reports Reports_ParentReportId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."Reports"
    ADD CONSTRAINT "Reports_ParentReportId_fkey" FOREIGN KEY ("ParentReportId") REFERENCES dbo."Reports"("Id") ON DELETE SET NULL;


--
-- Name: Reports Reports_ReporterId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."Reports"
    ADD CONSTRAINT "Reports_ReporterId_fkey" FOREIGN KEY ("ReporterId") REFERENCES dbo."Users"("Id") ON DELETE RESTRICT;


--
-- Name: Reports Reports_ReviewedBy_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."Reports"
    ADD CONSTRAINT "Reports_ReviewedBy_fkey" FOREIGN KEY ("ReviewedBy") REFERENCES dbo."Users"("Id") ON DELETE SET NULL;


--
-- Name: SystemSettings SystemSettings_UpdatedBy_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."SystemSettings"
    ADD CONSTRAINT "SystemSettings_UpdatedBy_fkey" FOREIGN KEY ("UpdatedBy") REFERENCES dbo."Users"("Id") ON DELETE SET NULL;


--
-- Name: UserAuthChallenges UserAuthChallenges_UserId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."UserAuthChallenges"
    ADD CONSTRAINT "UserAuthChallenges_UserId_fkey" FOREIGN KEY ("UserId") REFERENCES dbo."Users"("Id") ON DELETE CASCADE;


--
-- Name: WorkOrderAssignments WorkOrderAssignments_AssignedBy_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkOrderAssignments"
    ADD CONSTRAINT "WorkOrderAssignments_AssignedBy_fkey" FOREIGN KEY ("AssignedBy") REFERENCES dbo."Users"("Id") ON DELETE SET NULL;


--
-- Name: WorkOrderAssignments WorkOrderAssignments_ResponsibleLeadUserId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkOrderAssignments"
    ADD CONSTRAINT "WorkOrderAssignments_ResponsibleLeadUserId_fkey" FOREIGN KEY ("ResponsibleLeadUserId") REFERENCES dbo."Users"("Id") ON DELETE SET NULL;


--
-- Name: WorkOrderAssignments WorkOrderAssignments_WorkOrderId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkOrderAssignments"
    ADD CONSTRAINT "WorkOrderAssignments_WorkOrderId_fkey" FOREIGN KEY ("WorkOrderId") REFERENCES dbo."WorkOrders"("Id") ON DELETE CASCADE;


--
-- Name: WorkOrderImages WorkOrderImages_CreatedBy_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkOrderImages"
    ADD CONSTRAINT "WorkOrderImages_CreatedBy_fkey" FOREIGN KEY ("CreatedBy") REFERENCES dbo."Users"("Id") ON DELETE SET NULL;


--
-- Name: WorkOrderImages WorkOrderImages_WorkOrderId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkOrderImages"
    ADD CONSTRAINT "WorkOrderImages_WorkOrderId_fkey" FOREIGN KEY ("WorkOrderId") REFERENCES dbo."WorkOrders"("Id") ON DELETE CASCADE;


--
-- Name: WorkOrderMaterials WorkOrderMaterials_MaterialId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkOrderMaterials"
    ADD CONSTRAINT "WorkOrderMaterials_MaterialId_fkey" FOREIGN KEY ("MaterialId") REFERENCES dbo."Materials"("Id") ON DELETE SET NULL;


--
-- Name: WorkOrderMaterials WorkOrderMaterials_RecordedBy_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkOrderMaterials"
    ADD CONSTRAINT "WorkOrderMaterials_RecordedBy_fkey" FOREIGN KEY ("RecordedBy") REFERENCES dbo."Users"("Id") ON DELETE SET NULL;


--
-- Name: WorkOrderMaterials WorkOrderMaterials_WorkOrderId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkOrderMaterials"
    ADD CONSTRAINT "WorkOrderMaterials_WorkOrderId_fkey" FOREIGN KEY ("WorkOrderId") REFERENCES dbo."WorkOrders"("Id") ON DELETE CASCADE;


--
-- Name: WorkOrderPeople WorkOrderPeople_UserId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkOrderPeople"
    ADD CONSTRAINT "WorkOrderPeople_UserId_fkey" FOREIGN KEY ("UserId") REFERENCES dbo."Users"("Id") ON DELETE SET NULL;


--
-- Name: WorkOrderPeople WorkOrderPeople_WorkOrderId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkOrderPeople"
    ADD CONSTRAINT "WorkOrderPeople_WorkOrderId_fkey" FOREIGN KEY ("WorkOrderId") REFERENCES dbo."WorkOrders"("Id") ON DELETE CASCADE;


--
-- Name: WorkOrderStatusHistory WorkOrderStatusHistory_ChangedBy_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkOrderStatusHistory"
    ADD CONSTRAINT "WorkOrderStatusHistory_ChangedBy_fkey" FOREIGN KEY ("ChangedBy") REFERENCES dbo."Users"("Id") ON DELETE SET NULL;


--
-- Name: WorkOrderStatusHistory WorkOrderStatusHistory_WorkOrderId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkOrderStatusHistory"
    ADD CONSTRAINT "WorkOrderStatusHistory_WorkOrderId_fkey" FOREIGN KEY ("WorkOrderId") REFERENCES dbo."WorkOrders"("Id") ON DELETE CASCADE;


--
-- Name: WorkOrderUpdates WorkOrderUpdates_CreatedBy_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkOrderUpdates"
    ADD CONSTRAINT "WorkOrderUpdates_CreatedBy_fkey" FOREIGN KEY ("CreatedBy") REFERENCES dbo."Users"("Id") ON DELETE SET NULL;


--
-- Name: WorkOrderUpdates WorkOrderUpdates_WorkOrderId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkOrderUpdates"
    ADD CONSTRAINT "WorkOrderUpdates_WorkOrderId_fkey" FOREIGN KEY ("WorkOrderId") REFERENCES dbo."WorkOrders"("Id") ON DELETE CASCADE;


--
-- Name: WorkOrders WorkOrders_AssignedBy_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkOrders"
    ADD CONSTRAINT "WorkOrders_AssignedBy_fkey" FOREIGN KEY ("AssignedBy") REFERENCES dbo."Users"("Id") ON DELETE SET NULL;


--
-- Name: WorkOrders WorkOrders_CompletedBy_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkOrders"
    ADD CONSTRAINT "WorkOrders_CompletedBy_fkey" FOREIGN KEY ("CompletedBy") REFERENCES dbo."Users"("Id") ON DELETE SET NULL;


--
-- Name: WorkOrders WorkOrders_CompletionSubmittedBy_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkOrders"
    ADD CONSTRAINT "WorkOrders_CompletionSubmittedBy_fkey" FOREIGN KEY ("CompletionSubmittedBy") REFERENCES dbo."Users"("Id") ON DELETE SET NULL;


--
-- Name: WorkOrders WorkOrders_CreatedBy_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkOrders"
    ADD CONSTRAINT "WorkOrders_CreatedBy_fkey" FOREIGN KEY ("CreatedBy") REFERENCES dbo."Users"("Id") ON DELETE SET NULL;


--
-- Name: WorkOrders WorkOrders_MaintenanceRequestId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkOrders"
    ADD CONSTRAINT "WorkOrders_MaintenanceRequestId_fkey" FOREIGN KEY ("MaintenanceRequestId") REFERENCES dbo."MaintenanceRequests"("Id") ON DELETE RESTRICT;


--
-- Name: WorkOrders WorkOrders_MaintenanceReviewId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkOrders"
    ADD CONSTRAINT "WorkOrders_MaintenanceReviewId_fkey" FOREIGN KEY ("MaintenanceReviewId") REFERENCES dbo."MaintenanceReviews"("Id") ON DELETE RESTRICT;


--
-- Name: WorkOrders WorkOrders_ProcurementOutcomeId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkOrders"
    ADD CONSTRAINT "WorkOrders_ProcurementOutcomeId_fkey" FOREIGN KEY ("ProcurementOutcomeId") REFERENCES dbo."ProcurementOutcomes"("Id") ON DELETE RESTRICT;


--
-- Name: WorkOrders WorkOrders_ReportId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkOrders"
    ADD CONSTRAINT "WorkOrders_ReportId_fkey" FOREIGN KEY ("ReportId") REFERENCES dbo."Reports"("Id") ON DELETE RESTRICT;


--
-- Name: WorkOrders WorkOrders_ResponsibleLeadUserId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkOrders"
    ADD CONSTRAINT "WorkOrders_ResponsibleLeadUserId_fkey" FOREIGN KEY ("ResponsibleLeadUserId") REFERENCES dbo."Users"("Id") ON DELETE SET NULL;


--
-- Name: WorkOrders WorkOrders_StartedBy_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkOrders"
    ADD CONSTRAINT "WorkOrders_StartedBy_fkey" FOREIGN KEY ("StartedBy") REFERENCES dbo."Users"("Id") ON DELETE SET NULL;


--
-- Name: WorkflowActionItems WorkflowActionItems_AssignedUserId_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkflowActionItems"
    ADD CONSTRAINT "WorkflowActionItems_AssignedUserId_fkey" FOREIGN KEY ("AssignedUserId") REFERENCES dbo."Users"("Id") ON DELETE SET NULL;


--
-- Name: WorkflowActionItems WorkflowActionItems_CompletedBy_fkey; Type: FK CONSTRAINT; Schema: dbo; Owner: -
--

ALTER TABLE ONLY dbo."WorkflowActionItems"
    ADD CONSTRAINT "WorkflowActionItems_CompletedBy_fkey" FOREIGN KEY ("CompletedBy") REFERENCES dbo."Users"("Id") ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--


--
-- Reference / setup data
--

INSERT INTO dbo."Buildings" ("Id", "Code", "Name", "Description", "IsActive", "SortOrder", "CreatedAt", "UpdatedAt") VALUES ('a26b8114-6890-422d-95e5-81a86813e217', 'OLD_BUILDING', 'Old Building', NULL, true, 10, '2026-10-08 07:04:48.021142+08', '2026-10-08 07:04:48.021142+08');
INSERT INTO dbo."Buildings" ("Id", "Code", "Name", "Description", "IsActive", "SortOrder", "CreatedAt", "UpdatedAt") VALUES ('85375805-ae76-4532-a935-ece8fa970e67', 'ANNEX_1', 'Annex 1 Building', NULL, true, 20, '2026-10-08 07:04:48.021142+08', '2026-10-08 07:04:48.021142+08');
INSERT INTO dbo."Buildings" ("Id", "Code", "Name", "Description", "IsActive", "SortOrder", "CreatedAt", "UpdatedAt") VALUES ('ffa75162-450d-4a09-884b-959b25d5c8ec', 'ANNEX_2', 'Annex 2 Building', NULL, true, 30, '2026-10-08 07:04:48.021142+08', '2026-10-08 07:04:48.021142+08');
INSERT INTO dbo."Buildings" ("Id", "Code", "Name", "Description", "IsActive", "SortOrder", "CreatedAt", "UpdatedAt") VALUES ('3bd3112b-8e00-4524-a2cb-33a877ecc7fd', 'BASIC_EDUCATION', 'Basic Education Building', NULL, true, 40, '2026-10-08 07:04:48.021142+08', '2026-10-08 07:04:48.021142+08');
INSERT INTO dbo."Buildings" ("Id", "Code", "Name", "Description", "IsActive", "SortOrder", "CreatedAt", "UpdatedAt") VALUES ('e2ee4a42-a638-408d-a134-8203a7769cd6', 'MARITIME', 'Maritime Building', NULL, true, 50, '2026-10-08 07:04:48.021142+08', '2026-10-08 07:04:48.021142+08');
INSERT INTO dbo."Buildings" ("Id", "Code", "Name", "Description", "IsActive", "SortOrder", "CreatedAt", "UpdatedAt") VALUES ('efdf2631-ca6f-4f4e-b37f-6d6cc552cb23', 'NSA', 'NSA Building', NULL, true, 60, '2026-10-08 07:04:48.021142+08', '2026-10-08 07:04:48.021142+08');
INSERT INTO dbo."Buildings" ("Id", "Code", "Name", "Description", "IsActive", "SortOrder", "CreatedAt", "UpdatedAt") VALUES ('e62b60fc-d31d-4e4e-b98c-ffea5bba3a15', 'CBE', 'CBE Building', NULL, true, 70, '2026-10-08 07:04:48.021142+08', '2026-10-08 07:04:48.021142+08');
INSERT INTO dbo."Buildings" ("Id", "Code", "Name", "Description", "IsActive", "SortOrder", "CreatedAt", "UpdatedAt") VALUES ('ae6c0d21-125c-450d-b095-a8d5da141a6e', 'MACHINE_SHOP_ME', 'Machine Shop and ME Rooms', NULL, true, 80, '2026-10-08 07:04:48.021142+08', '2026-10-08 07:04:48.021142+08');
INSERT INTO dbo."DamageCategories" ("Id", "Code", "Name", "Description", "DefaultUrgency", "UrgencyGuidance", "DefaultMinHours", "DefaultMaxHours", "DefaultRequiredService", "DefaultRequiredCapability", "SafetyGuidance", "PreferredTrade", "RequiresMaintenanceReview", "IsActive", "SortOrder", "CreatedAt", "UpdatedAt") VALUES ('78423ad1-cf82-479c-88e7-a13cb1469d65', 'ELECTRICAL_FIRE', 'Electrical and Fire Safety', NULL, 'High', 'High; Critical when immediate danger is indicated.', NULL, NULL, NULL, NULL, NULL, NULL, true, true, 10, '2026-10-08 07:04:48.021142+08', '2026-10-08 07:04:48.021142+08');
INSERT INTO dbo."DamageCategories" ("Id", "Code", "Name", "Description", "DefaultUrgency", "UrgencyGuidance", "DefaultMinHours", "DefaultMaxHours", "DefaultRequiredService", "DefaultRequiredCapability", "SafetyGuidance", "PreferredTrade", "RequiresMaintenanceReview", "IsActive", "SortOrder", "CreatedAt", "UpdatedAt") VALUES ('8b73bd73-7bff-4936-840f-658b15159202', 'PLUMBING_WATER', 'Plumbing and Water Damage', NULL, 'Medium', 'Medium; High when active flooding or electrical exposure exists.', NULL, NULL, NULL, NULL, NULL, NULL, true, true, 30, '2026-10-08 07:04:48.021142+08', '2026-10-08 07:04:48.021142+08');
INSERT INTO dbo."DamageCategories" ("Id", "Code", "Name", "Description", "DefaultUrgency", "UrgencyGuidance", "DefaultMinHours", "DefaultMaxHours", "DefaultRequiredService", "DefaultRequiredCapability", "SafetyGuidance", "PreferredTrade", "RequiresMaintenanceReview", "IsActive", "SortOrder", "CreatedAt", "UpdatedAt") VALUES ('7d381fd4-659d-4800-9ba9-dd7cb4b1e822', 'ACCESS_SAFETY', 'Access and Safety Hazards', NULL, 'High', 'High.', NULL, NULL, NULL, NULL, NULL, NULL, true, true, 40, '2026-10-08 07:04:48.021142+08', '2026-10-08 07:04:48.021142+08');
INSERT INTO dbo."DamageCategories" ("Id", "Code", "Name", "Description", "DefaultUrgency", "UrgencyGuidance", "DefaultMinHours", "DefaultMaxHours", "DefaultRequiredService", "DefaultRequiredCapability", "SafetyGuidance", "PreferredTrade", "RequiresMaintenanceReview", "IsActive", "SortOrder", "CreatedAt", "UpdatedAt") VALUES ('d0dde2de-0fd6-4358-8af9-4582b080d2bf', 'FIXTURES_EQUIPMENT', 'Building Fixtures and Equipment', NULL, 'Medium', 'Medium.', NULL, NULL, NULL, NULL, NULL, NULL, true, true, 50, '2026-10-08 07:04:48.021142+08', '2026-10-08 07:04:48.021142+08');
INSERT INTO dbo."DamageCategories" ("Id", "Code", "Name", "Description", "DefaultUrgency", "UrgencyGuidance", "DefaultMinHours", "DefaultMaxHours", "DefaultRequiredService", "DefaultRequiredCapability", "SafetyGuidance", "PreferredTrade", "RequiresMaintenanceReview", "IsActive", "SortOrder", "CreatedAt", "UpdatedAt") VALUES ('ff372768-736b-46a1-8aeb-b272ecfaadac', 'SANITATION_ENVIRONMENTAL', 'Sanitation and Environmental', NULL, 'Medium', 'Medium; escalate according to exposure and affected area.', NULL, NULL, NULL, NULL, NULL, NULL, true, true, 60, '2026-10-08 07:04:48.021142+08', '2026-10-08 07:04:48.021142+08');
INSERT INTO dbo."DamageCategories" ("Id", "Code", "Name", "Description", "DefaultUrgency", "UrgencyGuidance", "DefaultMinHours", "DefaultMaxHours", "DefaultRequiredService", "DefaultRequiredCapability", "SafetyGuidance", "PreferredTrade", "RequiresMaintenanceReview", "IsActive", "SortOrder", "CreatedAt", "UpdatedAt") VALUES ('3a509b1e-0b90-48d8-ba47-d6d563eddc44', 'ROADS_GROUNDS', 'Roads, Walkways and Grounds', NULL, 'Medium', 'Medium; High when access or safety is affected.', NULL, NULL, NULL, NULL, NULL, NULL, true, true, 70, '2026-10-08 07:04:48.021142+08', '2026-10-08 07:04:48.021142+08');
INSERT INTO dbo."DamageCategories" ("Id", "Code", "Name", "Description", "DefaultUrgency", "UrgencyGuidance", "DefaultMinHours", "DefaultMaxHours", "DefaultRequiredService", "DefaultRequiredCapability", "SafetyGuidance", "PreferredTrade", "RequiresMaintenanceReview", "IsActive", "SortOrder", "CreatedAt", "UpdatedAt") VALUES ('a0fba727-3e05-4322-9117-b4622ac51262', 'OTHER_UNCERTAIN', 'Other or Uncertain', NULL, NULL, 'Human maintenance review is required.', NULL, NULL, NULL, NULL, NULL, NULL, true, true, 80, '2026-10-08 07:04:48.021142+08', '2026-10-08 07:04:48.021142+08');
INSERT INTO dbo."DamageCategories" ("Id", "Code", "Name", "Description", "DefaultUrgency", "UrgencyGuidance", "DefaultMinHours", "DefaultMaxHours", "DefaultRequiredService", "DefaultRequiredCapability", "SafetyGuidance", "PreferredTrade", "RequiresMaintenanceReview", "IsActive", "SortOrder", "CreatedAt", "UpdatedAt") VALUES ('e116c95e-610d-4cd2-a37b-670b7aafddff', 'STRUCTURAL_SURFACE', 'Structural and Surface Damage', NULL, 'Medium', 'Medium; escalate according to visible severity and instability indicators.', NULL, NULL, NULL, NULL, NULL, NULL, true, true, 20, '2026-10-08 07:04:48.021142+08', '2026-10-13 05:24:18.73217+08');
INSERT INTO dbo."SystemSettings" ("Key", "Value", "Description", "UpdatedBy", "UpdatedAt") VALUES ('AgentRecurrenceThreshold', '2', 'recurrenceCount >= this value contributes recurrence priority points.', NULL, '2026-10-08 07:04:48.021142+08');
INSERT INTO dbo."SystemSettings" ("Key", "Value", "Description", "UpdatedBy", "UpdatedAt") VALUES ('AgentVerificationThreshold', '2', 'verificationCount >= this value contributes verification priority points.', NULL, '2026-10-08 07:04:48.021142+08');
INSERT INTO dbo."SystemSettings" ("Key", "Value", "Description", "UpdatedBy", "UpdatedAt") VALUES ('AgentRecurrenceLookbackDays', '365', 'Historical report lookback used by recurrence queries.', NULL, '2026-10-08 07:04:48.021142+08');
INSERT INTO dbo."SystemSettings" ("Key", "Value", "Description", "UpdatedBy", "UpdatedAt") VALUES ('AgentDuplicateLookbackDays', '30', 'Duplicate-candidate lookback window.', NULL, '2026-10-08 07:04:48.021142+08');
INSERT INTO dbo."SystemSettings" ("Key", "Value", "Description", "UpdatedBy", "UpdatedAt") VALUES ('ProcurementExpectedDays', '3', 'Operational follow-up target for Procurement; not a legal deadline.', NULL, '2026-10-08 07:04:48.021142+08');
INSERT INTO dbo."SystemSettings" ("Key", "Value", "Description", "UpdatedBy", "UpdatedAt") VALUES ('ProcurementFollowupHours', '24', 'Default Procurement follow-up cadence.', NULL, '2026-10-08 07:04:48.021142+08');
INSERT INTO dbo."SystemSettings" ("Key", "Value", "Description", "UpdatedBy", "UpdatedAt") VALUES ('AutoCreateInternalWorkOrderAfterReview', 'true', 'When true, an INTERNAL maintenance decision may immediately create a Work Order.', NULL, '2026-10-08 07:04:48.021142+08');
INSERT INTO dbo."SystemSettings" ("Key", "Value", "Description", "UpdatedBy", "UpdatedAt") VALUES ('AutoCreateProcurementHandoffAfterReview', 'true', 'When true, a PROCUREMENT maintenance decision may immediately create a Procurement handoff.', NULL, '2026-10-08 07:04:48.021142+08');
INSERT INTO dbo."SystemSettings" ("Key", "Value", "Description", "UpdatedBy", "UpdatedAt") VALUES ('RequireMaintenanceSupervisorCompletionApproval', 'true', 'Completion remains a human maintenance-supervisor responsibility gate.', NULL, '2026-10-08 07:04:48.021142+08');
