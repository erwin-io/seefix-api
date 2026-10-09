import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function read(relative) {
  return fs.readFileSync(
    new URL(`../${relative}`, import.meta.url),
    "utf8",
  );
}

const agent = read(
  "src/agent-client.js",
);

const app = read(
  "src/app.js",
);

const maintenance = read(
  "src/routes/maintenance.js",
);

const procurement = read(
  "src/routes/procurement.js",
);

const work = read(
  "src/routes/work-orders.js",
);


test(
  "old raw image analyze endpoint and static UI are removed",
  () => {
    assert.equal(
      agent.includes("/api/analyze"),
      false,
    );

    assert.equal(
      app.includes("express.static"),
      false,
    );
  },
);


test(
  "agent report contract uses persisted report id",
  () => {
    assert.match(
      agent,
      /\/api\/reports\/\$\{reportId\}\/process/,
    );

    assert.match(
      agent,
      /maintenance-request\/generate/,
    );
  },
);


test(
  "API mounts Maintenance and reference routes and no PPO route",
  () => {
    assert.match(
      app,
      /app\.use\("\/api\/maintenance",\s*maintenanceRoutes\)/,
    );

    assert.match(
      app,
      /app\.use\("\/api\/reference",\s*referenceRoutes\)/,
    );

    assert.equal(
      app.includes("/api/ppo"),
      false,
    );
  },
);


test(
  "Maintenance Review is the human routing authority",
  () => {
    assert.match(
      maintenance,
      /MaintenanceReviews/,
    );

    assert.match(
      maintenance,
      /"ReviewedBy"/,
    );

    assert.match(
      maintenance,
      /"INTERNAL"/,
    );

    assert.match(
      maintenance,
      /"PROCUREMENT"/,
    );

    assert.match(
      maintenance,
      /"NO_ACTION"/,
    );

    assert.match(
      maintenance,
      /"DUPLICATE"/,
    );

    assert.match(
      maintenance,
      /ensureInternalWorkOrder/,
    );

    assert.match(
      maintenance,
      /ensureProcurementHandoff/,
    );
  },
);


test(
  "Procurement records outcome but contains no bidder ranking",
  () => {
    assert.match(
      procurement,
      /ProcurementOutcomes/,
    );

    assert.equal(
      /bidder|vendor ranking|quotation comparison/i.test(
        procurement,
      ),
      false,
    );
  },
);


test(
  "Work Orders use assignment dispatch instead of a second confirmation gate",
  () => {
    assert.match(
      work,
      /PENDING_ASSIGNMENT/,
    );

    assert.match(
      work,
      /WorkOrderAssignments/,
    );

    assert.match(
      work,
      /\/\:id\/assign/,
    );

    assert.equal(
      work.includes(
        "PENDING_CONFIRMATION",
      ),
      false,
    );

    assert.equal(
      work.includes("CONFIRMED"),
      false,
    );
  },
);


test(
  "completion remains human closed by Maintenance Supervisor and Agent is assistance",
  () => {
    assert.match(
      work,
      /COMPLETION_SUBMITTED/,
    );

    assert.match(
      maintenance,
      /\/work-orders\/\:id\/complete/,
    );

    assert.match(
      maintenance,
      /SUPERVISOR_ONLY/,
    );

    assert.match(
      maintenance,
      /"CompletedBy"/,
    );

    assert.match(
      agent,
      /completion\/process/,
    );
  },
);