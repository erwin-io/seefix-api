import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  fileURLToPath,
} from "node:url";

import {
  normalizeMaterialItem,
  parseActualMaterials,
} from "../src/utils/materials.js";


const here = path.dirname(
  fileURLToPath(
    import.meta.url,
  ),
);

const root = path.resolve(
  here,
  "..",
);


function read(relative) {
  return fs.readFileSync(
    path.join(
      root,
      relative,
    ),
    "utf8",
  );
}


test(
  "completion actualMaterials parses multipart JSON into structured ACTUAL rows",
  () => {
    const result =
      parseActualMaterials(
        JSON.stringify([
          {
            materialName:
              "Mold remediation supplies",

            unit:
              "set",

            quantity:
              "1.5",

            notes:
              "Used during corrective work.",
          },
        ]),
      );

    assert.deepEqual(
      result,
      [
        {
          materialId:
            null,

          materialName:
            "Mold remediation supplies",

          unit:
            "set",

          quantity:
            1.5,

          notes:
            "Used during corrective work.",
        },
      ],
    );
  },
);


test(
  "completion actualMaterials rejects negative quantities",
  () => {
    assert.throws(
      () =>
        parseActualMaterials(
          JSON.stringify([
            {
              materialName:
                "Sealant",

              quantity:
                -1,
            },
          ]),
        ),

      (error) =>
        error?.status === 400 &&
        error?.code ===
          "VALIDATION_ERROR",
    );
  },
);


test(
  "material validation rejects malformed material UUIDs before PostgreSQL",
  () => {
    assert.throws(
      () =>
        normalizeMaterialItem(
          {
            materialId:
              "not-a-uuid",

            materialName:
              "Sealant",

            quantity:
              1,
          },
        ),

      (error) =>
        error?.status === 400 &&
        error?.code ===
          "VALIDATION_ERROR",
    );
  },
);


test(
  "Maintenance Review is limited to Maintenance roles and ADMIN",
  () => {
    const source = read(
      "src/routes/maintenance.js",
    );

    assert.match(
      source,
      /const REVIEW_ROLES = requireRoles\([\s\S]*?"MAINTENANCE_STAFF"[\s\S]*?"MAINTENANCE_SUPERVISOR"[\s\S]*?"ADMIN"[\s\S]*?\);/,
    );

    assert.match(
      source,
      /"\/reports\/:id\/review",[\s\S]*?REVIEW_ROLES/,
    );
  },
);


test(
  "human-only supervisor gates remain MAINTENANCE_SUPERVISOR or ADMIN",
  () => {
    const source = read(
      "src/routes/maintenance.js",
    );

    assert.match(
      source,
      /const SUPERVISOR_ONLY = requireRoles\([\s\S]*?"MAINTENANCE_SUPERVISOR"[\s\S]*?"ADMIN"[\s\S]*?\);/,
    );

    for (
      const route
      of [
        "/procurement/clarifications/:id/respond",
        "/work-orders/:id/complete",
        "/work-orders/:id/rework",
      ]
    ) {
      const escaped =
        route.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        );

      assert.match(
        source,
        new RegExp(
          `"${escaped}"[\\s\\S]*?SUPERVISOR_ONLY`,
        ),
      );
    }
  },
);


test(
  "Procurement mutation gates remain PROCUREMENT or ADMIN",
  () => {
    const source = read(
      "src/routes/procurement.js",
    );

    for (
      const route
      of [
        "acknowledge",
        "start",
        "clarifications",
        "outcome",
      ]
    ) {
      const regex =
        new RegExp(
          `\\/handoffs\\/:id\\/${route}[\\s\\S]*?requireRoles\\("PROCUREMENT", "ADMIN"\\)`,
        );

      assert.match(
        source,
        regex,
      );
    }
  },
);


test(
  "Work Order assignment is human-dispatched and records assignment history",
  () => {
    const source = read(
      "src/routes/work-orders.js",
    );

    assert.match(
      source,
      /const ASSIGN_ROLES = requireRoles\([\s\S]*?"MAINTENANCE_STAFF"[\s\S]*?"MAINTENANCE_SUPERVISOR"[\s\S]*?"ADMIN"[\s\S]*?\);/,
    );

    assert.match(
      source,
      /router\.post\("\/:id\/assign", ASSIGN_ROLES/,
    );

    assert.match(
      source,
      /INSERT INTO "dbo"\."WorkOrderAssignments"/,
    );
  },
);


test(
  "reporter lifecycle notification backfill covers revised core milestones",
  () => {
    const source = read(
      "src/services/notifications.js",
    );

    for (
      const type
      of [
        "REPORT_ASSESSED",
        "MAINTENANCE_REVIEW_COMPLETED",
        "PROCUREMENT_STARTED",
        "PROCUREMENT_COMPLETED",
        "WORK_ORDER_ASSIGNED",
        "WORK_STARTED",
        "COMPLETION_SUBMITTED",
        "WORK_ORDER_REWORK_REQUIRED",
        "REPORT_RESOLVED",
      ]
    ) {
      assert.match(
        source,
        new RegExp(type),
      );
    }

    /*
     * MAINTENANCE_REQUESTED belonged to the
     * previous PPO workflow and must not be
     * restored merely to satisfy an old test.
     */
    assert.equal(
      source.includes(
        "MAINTENANCE_REQUESTED",
      ),
      false,
    );
  },
);


test(
  "Outbox default transport matches canonical INTERNAL transport",
  () => {
    const source = read(
      "src/services/notifications.js",
    );

    assert.match(
      source,
      /transport = "INTERNAL"/,
    );
  },
);


test(
  "reference building query uses Description instead of removed Notes column",
  () => {
    const source = read(
      "src/routes/reference.js",
    );

    assert.match(
      source,
      /"Description" AS description/,
    );

    assert.equal(
      /"Notes" AS notes[\s\S]*?FROM "dbo"\."Buildings"/.test(
        source,
      ),
      false,
    );
  },
);