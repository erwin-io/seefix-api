import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeMaterialItem, parseActualMaterials } from "../src/utils/materials.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

test("completion actualMaterials parses multipart JSON into structured ACTUAL rows", () => {
  const result = parseActualMaterials(
    JSON.stringify([
      {
        materialName: "Mold remediation supplies",
        unit: "set",
        quantity: "1.5",
        notes: "Used during corrective work.",
      },
    ]),
  );
  assert.deepEqual(result, [
    {
      materialId: null,
      materialName: "Mold remediation supplies",
      unit: "set",
      quantity: 1.5,
      notes: "Used during corrective work.",
    },
  ]);
});

test("completion actualMaterials rejects negative quantities", () => {
  assert.throws(
    () =>
      parseActualMaterials(
        JSON.stringify([{ materialName: "Sealant", quantity: -1 }]),
      ),
    (error) => error?.status === 400 && error?.code === "VALIDATION_ERROR",
  );
});


test("material validation rejects malformed material UUIDs before PostgreSQL", () => {
  assert.throws(
    () => normalizeMaterialItem({ materialId: "not-a-uuid", materialName: "Sealant", quantity: 1 }),
    (error) => error?.status === 400 && error?.code === "VALIDATION_ERROR",
  );
});

test("PPO Verify & Request Maintenance is PPO_STAFF or ADMIN only", () => {
  const source = read("src/routes/ppo.js");
  assert.match(
    source,
    /\/reports\/:id\/verify-request-maintenance[\s\S]*?requireRoles\("PPO_STAFF", "ADMIN"\)/,
  );
});

test("human-only PPO Head gates remain PPO_HEAD or ADMIN", () => {
  const source = read("src/routes/ppo.js");
  assert.match(
    source,
    /\/procurement\/clarifications\/:id\/respond[\s\S]*?requireRoles\("PPO_HEAD", "ADMIN"\)/,
  );
  assert.match(
    source,
    /\/work-orders\/:id\/confirm[\s\S]*?requireRoles\("PPO_HEAD", "ADMIN"\)/,
  );
  assert.match(
    source,
    /\/work-orders\/:id\/complete[\s\S]*?requireRoles\("PPO_HEAD", "ADMIN"\)/,
  );
  assert.match(
    source,
    /\/work-orders\/:id\/rework[\s\S]*?requireRoles\("PPO_HEAD", "ADMIN"\)/,
  );
});

test("Procurement mutation gates remain PROCUREMENT or ADMIN", () => {
  const source = read("src/routes/procurement.js");
  for (const route of ["acknowledge", "start", "clarifications", "outcome"]) {
    const regex = new RegExp(
      `\\/handoffs\\/:id\\/${route}[\\s\\S]*?requireRoles\\(\"PROCUREMENT\", \"ADMIN\"\\)`,
    );
    assert.match(source, regex);
  }
});

test("reporter lifecycle notification backfill covers core milestones", () => {
  const source = read("src/services/notifications.js");
  for (const type of [
    "REPORT_ASSESSED",
    "MAINTENANCE_REQUESTED",
    "PROCUREMENT_STARTED",
    "PROCUREMENT_COMPLETED",
    "WORK_ORDER_ASSIGNED",
    "WORK_STARTED",
    "COMPLETION_SUBMITTED",
    "WORK_ORDER_REWORK_REQUIRED",
    "REPORT_RESOLVED",
  ]) {
    assert.match(source, new RegExp(type));
  }
});
