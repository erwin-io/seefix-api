import "dotenv/config";

import {
  pool,
  query,
} from "../src/database.js";


/*
 * Read-only verification of the canonical
 * SEEFIX 2026-10-08 v2 database.
 *
 * This script never mutates the database.
 * It verifies the relations, Agent queue
 * functions, and critical columns required
 * by seefix-api.
 */


const REQUIRED_TABLES = [
  "Users",
  "SystemSettings",

  "Buildings",
  "FacilityLocations",

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

  "MaintenanceReviews",
  "MaintenanceReviewStatusHistory",

  "ProcurementHandoffs",
  "ProcurementClarifications",
  "ProcurementDocuments",
  "ProcurementOutcomes",
  "ProcurementHandoffStatusHistory",

  "WorkOrders",
  "WorkOrderAssignments",
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
  "v_ReportEffectiveClassification",
  "v_ReportPriorityLive",
  "v_PendingAgentReports",

  "v_MaintenanceReviewQueue",
  "v_MaintenanceActionCenter",

  "v_ProcurementInbox",
  "v_WorkerInbox",

  "v_CompletedWorkOrderKnowledge",
  "v_ReportTimeline",
];


const REQUIRED_FUNCTIONS = [
  "ClaimReportForAgent",
  "ClaimNextPendingReport",
  "RequeueStaleAgentReports",

  "ClaimNextPendingCompletionWorkOrder",
  "RequeueStaleCompletionAgentWorkOrders",
];


const CRITICAL_COLUMNS = {
  Buildings: [
    "Code",
    "Name",
    "Description",
    "IsActive",
  ],

  FacilityLocations: [
    "BuildingId",
    "Floor",
    "RoomOrArea",
    "LocationType",
    "Code",
    "IsActive",
    "Notes",
  ],

  DamageCategories: [
    "RequiresMaintenanceReview",
  ],

  Reports: [
    "LocationId",
    "Status",
    "AgentStatus",
    "FinalCategory",
    "FinalUrgency",
    "PriorityScore",
  ],

  MaintenanceRequests: [
    "ReportId",
    "Status",

    "EffectiveCategory",
    "EffectiveUrgency",

    "RequiredService",
    "RequiredCapability",

    "AuthorizedBy",
    "AuthorizedAt",
  ],

  MaintenanceReviews: [
    "ReportId",
    "MaintenanceRequestId",

    "Status",
    "Decision",

    "FinalCategory",
    "FinalUrgency",

    "ReviewedBy",
    "ReviewedAt",
  ],

  ProcurementHandoffs: [
    "MaintenanceRequestId",
    "MaintenanceReviewId",
    "Status",
  ],

  WorkOrders: [
    "ReportId",
    "MaintenanceRequestId",
    "MaintenanceReviewId",

    "ProcurementOutcomeId",

    "RouteType",
    "Status",
    "ExecutionType",

    "AssignedPartyName",
    "ResponsibleLeadUserId",

    "AssignedBy",
    "AssignedAt",

    "CompletionAgentStatus",
  ],

  WorkOrderAssignments: [
    "WorkOrderId",

    "AssignedPartyName",
    "ResponsibleLeadUserId",

    "AssignedBy",
    "AssignedAt",
  ],
};


async function relationExists(
  name,
) {
  const qualifiedName =
    `dbo."${name}"`;

  const result = await query(
    `
      SELECT
        to_regclass($1)
          AS "ObjectName"
    `,
    [
      qualifiedName,
    ],
  );

  return Boolean(
    result.rows[0]
      ?.ObjectName,
  );
}


async function functionExists(
  name,
) {
  const result = await query(
    `
      SELECT EXISTS
      (
        SELECT 1
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n
          ON n.oid =
             p.pronamespace
        WHERE n.nspname = $1
          AND p.proname = $2
      ) AS "Exists"
    `,
    [
      "dbo",
      name,
    ],
  );

  return Boolean(
    result.rows[0]
      ?.Exists,
  );
}


async function loadColumns() {
  const result = await query(
    `
      SELECT
        table_name
          AS "TableName",

        column_name
          AS "ColumnName",

        is_nullable
          AS "IsNullable"

      FROM
        information_schema.columns

      WHERE
        table_schema = 'dbo'
    `,
  );

  const byTable =
    new Map();

  const nullable =
    new Map();


  for (
    const row
    of result.rows
  ) {
    if (
      !byTable.has(
        row.TableName,
      )
    ) {
      byTable.set(
        row.TableName,
        new Set(),
      );
    }


    byTable
      .get(
        row.TableName,
      )
      .add(
        row.ColumnName,
      );


    nullable.set(
      (
        `${row.TableName}.` +
        `${row.ColumnName}`
      ),
      row.IsNullable,
    );
  }


  return {
    byTable,
    nullable,
  };
}


async function main() {
  const missing = [];


  /*
   * Tables
   */

  for (
    const name
    of REQUIRED_TABLES
  ) {
    if (
      !(await relationExists(name))
    ) {
      missing.push(
        `table dbo.${name}`,
      );
    }
  }


  /*
   * Views
   */

  for (
    const name
    of REQUIRED_VIEWS
  ) {
    if (
      !(await relationExists(name))
    ) {
      missing.push(
        `view dbo.${name}`,
      );
    }
  }


  /*
   * Agent queue functions
   */

  for (
    const name
    of REQUIRED_FUNCTIONS
  ) {
    if (
      !(await functionExists(name))
    ) {
      missing.push(
        `function dbo.${name}`,
      );
    }
  }


  /*
   * Reject old PPO architecture.
   */

  if (
    await relationExists(
      "v_PpoActionCenter",
    )
  ) {
    missing.push(
      (
        "legacy view " +
        "dbo.v_PpoActionCenter " +
        "should not exist in the " +
        "2026-10-08 v2 contract"
      ),
    );
  }


  /*
   * Critical column contract.
   */

  const columns =
    await loadColumns();


  for (
    const [
      tableName,
      names,
    ]
    of Object.entries(
      CRITICAL_COLUMNS,
    )
  ) {
    const actual =
      columns.byTable.get(
        tableName,
      ) ||
      new Set();


    for (
      const columnName
      of names
    ) {
      if (
        !actual.has(
          columnName,
        )
      ) {
        missing.push(
          (
            "column " +
            `dbo.${tableName}.` +
            columnName
          ),
        );
      }
    }
  }


  /*
   * INTERNAL route must allow
   * Work Order without Procurement.
   */

  if (
    columns.nullable.get(
      (
        "WorkOrders." +
        "ProcurementOutcomeId"
      ),
    ) !== "YES"
  ) {
    missing.push(
      (
        "column " +
        "dbo.WorkOrders." +
        "ProcurementOutcomeId " +
        "must be nullable"
      ),
    );
  }


  if (
    missing.length > 0
  ) {
    console.error(
      (
        "Canonical SEEFIX " +
        "2026-10-08 database " +
        "contract is NOT " +
        "fully available:"
      ),
    );


    for (
      const item
      of missing
    ) {
      console.error(
        ` - ${item}`,
      );
    }


    process.exitCode = 1;

    return;
  }


  console.log(
    (
      "Canonical SEEFIX " +
      "2026-10-08 database " +
      "contract verified for " +
      "seefix-api " +
      "(read-only object/" +
      "column check)."
    ),
  );


  console.log(
    (
      `Verified ` +
      `${REQUIRED_TABLES.length} tables, ` +
      `${REQUIRED_VIEWS.length} views, ` +
      `${REQUIRED_FUNCTIONS.length} functions, ` +
      "and critical route/review columns."
    ),
  );
}


try {
  await main();
} catch (error) {
  console.error(
    (
      "Unable to verify the " +
      "SEEFIX database contract:"
    ),

    error instanceof Error
      ? error.message
      : String(error),
  );


  process.exitCode = 1;
} finally {
  await pool.end();
}