import "dotenv/config";

import {
  pool,
  query,
} from "../src/database.js";

/*
 * Read-only verification of the canonical SEEFIX 2026-09-16 database objects.
 *
 * This script does not CREATE, ALTER, UPDATE, DELETE, TRUNCATE, or DROP
 * anything. It only checks that the objects required by seefix-api exist.
 *
 * IMPORTANT:
 * The canonical SEEFIX schema uses quoted, case-sensitive PostgreSQL object
 * names such as:
 *
 *   "dbo"."Users"
 *   "dbo"."MaintenanceRequests"
 *
 * PostgreSQL folds an unquoted name such as dbo.Users to dbo.users, so the
 * quotes around the relation name below are intentional and required.
 */

const REQUIRED_TABLES = [
  "Users",
  "SystemSettings",
  "DamageCategories",
  "Skills",
  "CategorySkillRequirements",
  "Materials",
  "CategoryMaterialReferences",
  "Reports",
  "ReportImages",
  "ReportAssessmentHistory",
  "ReportDuplicateCandidates",
  "ReportVerifications",
  "ReportStatusHistory",
  "MaintenanceRequests",
  "MaintenanceRequestSkills",
  "MaintenanceRequestMaterials",
  "MaintenanceRequestRevisions",
  "MaintenanceRequestStatusHistory",
  "ProcurementHandoffs",
  "ProcurementClarifications",
  "ProcurementDocuments",
  "ProcurementOutcomes",
  "ProcurementHandoffStatusHistory",
  "WorkOrders",
  "WorkOrderPeople",
  "WorkOrderMaterials",
  "WorkOrderImages",
  "WorkOrderUpdates",
  "WorkOrderStatusHistory",
  "WorkflowActionItems",
  "Notifications",
  "OutboxEvents",
  "AuditLogs",
];

const REQUIRED_VIEWS = [
  "v_PendingAgentReports",
  "v_ReportEffectiveClassification",
  "v_ReportPriorityLive",
  "v_CompletedWorkOrderKnowledge",
  "v_ProcurementInbox",
  "v_PpoActionCenter",
];

const REQUIRED_FUNCTIONS = [
  "ClaimReportForAgent",
  "ClaimNextPendingReport",
  "RequeueStaleAgentReports",
  "ClaimNextPendingCompletionWorkOrder",
  "RequeueStaleCompletionAgentWorkOrders",
];

async function relationExists(name) {
  /*
   * Pass an explicitly quoted relation name to to_regclass().
   *
   * Correct:
   *   dbo."Users"
   *
   * Incorrect:
   *   dbo.Users
   *
   * The latter becomes dbo.users because PostgreSQL folds unquoted
   * identifiers to lowercase.
   */
  const qualifiedName = `dbo."${name}"`;

  const result = await query(
    `SELECT to_regclass($1) AS "ObjectName"`,
    [qualifiedName],
  );

  return Boolean(
    result.rows[0]?.ObjectName,
  );
}

async function functionExists(name) {
  const result = await query(
    `
      SELECT EXISTS (
        SELECT 1
        FROM pg_proc p
        INNER JOIN pg_namespace n
          ON n.oid = p.pronamespace
        WHERE n.nspname = $1
          AND p.proname = $2
      ) AS "Exists"
    `,
    ["dbo", name],
  );

  return Boolean(
    result.rows[0]?.Exists,
  );
}

async function main() {
  const missing = [];

  for (const name of REQUIRED_TABLES) {
    if (!(await relationExists(name))) {
      missing.push(
        `table dbo.${name}`,
      );
    }
  }

  for (const name of REQUIRED_VIEWS) {
    if (!(await relationExists(name))) {
      missing.push(
        `view dbo.${name}`,
      );
    }
  }

  for (const name of REQUIRED_FUNCTIONS) {
    if (!(await functionExists(name))) {
      missing.push(
        `function dbo.${name}`,
      );
    }
  }

  if (missing.length > 0) {
    console.error(
      "Canonical SEEFIX database contract is NOT fully available:",
    );

    for (const item of missing) {
      console.error(` - ${item}`);
    }

    process.exitCode = 1;
    return;
  }

  console.log(
    "Canonical SEEFIX database contract verified for seefix-api " +
    "(read-only object check).",
  );

  console.log(
    `Verified ${REQUIRED_TABLES.length} tables, ` +
    `${REQUIRED_VIEWS.length} views, and ` +
    `${REQUIRED_FUNCTIONS.length} functions.`,
  );
}

try {
  await main();
} catch (error) {
  console.error(
    "Unable to verify the SEEFIX database contract:",
    error instanceof Error
      ? error.message
      : String(error),
  );

  process.exitCode = 1;
} finally {
  await pool.end();
}
