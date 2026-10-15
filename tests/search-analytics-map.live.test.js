/**
 * Opt-in live checks (SEEFIX_INTEGRATION_DB=1) after db/migrations/2026-10-16-v2-search-buildings.sql.
 * Needs one active user per role. Creates one test building (deleted at the end); everything else is read-only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const live = process.env.SEEFIX_INTEGRATION_DB === "1";
const ROLES = ["ADMIN", "MAINTENANCE_SUPERVISOR", "MAINTENANCE_STAFF", "PROCUREMENT", "WORKER", "REPORTER"];

test("live: search, analytics, buildings and map are role-scoped and match SQL", { skip: !live && "set SEEFIX_INTEGRATION_DB=1" }, async (t) => {
  const { app } = await import("../src/app.js");
  const { pool, query } = await import("../src/database.js");
  const { signAccessToken } = await import("../src/middleware/auth.js");
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const created = [];
  t.after(async () => {
    server.close();
    if (created.length) await query(`DELETE FROM "dbo"."Buildings" WHERE "Id" = ANY($1::uuid[])`, [created]);
    await pool.end();
  });

  const users = {};
  for (const role of ROLES) {
    // Prefer a worker who leads work orders, so the scoped results have positives.
    const u = (await query(
      `SELECT u."Id",u."Role",u."Email",u."CredentialsVersion" FROM "dbo"."Users" u WHERE u."IsActive" AND u."Role"=$1
        ORDER BY EXISTS(SELECT 1 FROM "dbo"."WorkOrders" w WHERE w."ResponsibleLeadUserId"=u."Id") DESC LIMIT 1`, [role])).rows[0];
    assert.ok(u, `needs an active ${role}`);
    users[role] = { id: u.Id, headers: { Authorization: `Bearer ${signAccessToken({ id: u.Id, role: u.Role, email: u.Email }, u.CredentialsVersion)}` } };
  }
  const get = async (role, path) => {
    const r = await fetch(base + path, { headers: users[role].headers });
    return { status: r.status, body: r.headers.get("content-type")?.includes("json") ? await r.json() : null };
  };

  // --- RBAC matrix: who can call what.
  const matrix = {
    "/api/search?q=RPT": [200, 200, 200, 200, 200, 403],
    "/api/analytics/overview": [200, 200, 200, 200, 200, 403],
    "/api/map": [200, 200, 200, 403, 200, 403],
    "/api/admin/buildings": [200, 403, 403, 403, 403, 403],
  };
  for (const [path, expected] of Object.entries(matrix)) {
    const got = [];
    for (const role of ROLES) got.push((await get(role, path)).status);
    assert.deepEqual(got, expected, `${path} by ${ROLES.join("/")}`);
  }

  // --- Search: only types the role can read, and only rows the detail route would allow.
  const groupsOf = async (role, q) => Object.fromEntries((await get(role, `/api/search?q=${encodeURIComponent(q)}&limit=20`)).body.groups.map((g) => [g.type, g.items]));
  const adminAll = await groupsOf("ADMIN", "RPT");
  assert.ok(adminAll.reports?.length, "admin finds reports");
  const procurementGroups = await groupsOf("PROCUREMENT", "RPT");
  assert.ok(!("users" in procurementGroups) && !("work_orders" in procurementGroups) && !("action_items" in procurementGroups));
  const linked = new Set((await query(`SELECT mr."ReportId" AS id FROM "dbo"."ProcurementHandoffs" ph JOIN "dbo"."MaintenanceRequests" mr ON mr."Id"=ph."MaintenanceRequestId"`)).rows.map((r) => r.id));
  for (const item of procurementGroups.reports ?? []) assert.ok(linked.has(item.id), `procurement sees only handoff-linked report ${item.title}`);
  const workerGroups = await groupsOf("WORKER", "WO");
  const own = new Set((await query(`SELECT "Id" FROM "dbo"."WorkOrders" WHERE "ResponsibleLeadUserId"=$1`, [users.WORKER.id])).rows.map((r) => r.Id));
  for (const item of workerGroups.work_orders ?? []) assert.ok(own.has(item.id), `worker sees only own work order ${item.title}`);
  assert.equal((await get("MAINTENANCE_STAFF", "/api/search?q=a")).status, 400, "1 character is rejected");
  assert.equal((await get("ADMIN", "/api/search?q=RPT&types=bogus")).status, 400);
  const injected = await get("ADMIN", `/api/search?q=${encodeURIComponent("%' OR '1'='1")}`);
  assert.equal(injected.status, 200);
  assert.deepEqual(injected.body.groups, [], "SQL text matches nothing");
  const wildcard = await get("ADMIN", `/api/search?q=${encodeURIComponent("%%")}`);
  assert.deepEqual(wildcard.body.groups, [], "% is literal, not match-all");

  // --- Analytics numbers equal direct SQL.
  const overview = (await get("ADMIN", "/api/analytics/overview?from=2026-01-01&to=2026-12-31")).body;
  const sqlCount = async (sql, params = []) => Number((await query(sql, params)).rows[0].n);
  assert.equal(overview.sections.reports.created, await sqlCount(`SELECT COUNT(*) n FROM "dbo"."Reports" WHERE "CreatedAt" >= '2026-01-01' AND "CreatedAt" < '2027-01-01'`));
  assert.equal(overview.sections.queueAging.total, await sqlCount(`SELECT COUNT(*) n FROM "dbo"."Reports" WHERE "Status"='PENDING_REVIEW'`));
  assert.equal(overview.sections.workOrders.completed, await sqlCount(`SELECT COUNT(*) n FROM "dbo"."WorkOrders" WHERE "Status"='COMPLETED' AND "ResolvedAt" >= '2026-01-01' AND "ResolvedAt" < '2027-01-01'`));
  assert.equal(overview.sections.agent.failedOpen, await sqlCount(`SELECT COUNT(*) n FROM "dbo"."Reports" WHERE "AgentStatus"='FAILED' AND "Status"='SUBMITTED'`));
  const proc = (await get("PROCUREMENT", "/api/analytics/overview")).body;
  assert.deepEqual(Object.keys(proc.sections), ["procurement"]);
  const worker = (await get("WORKER", "/api/analytics/overview")).body;
  assert.deepEqual(Object.keys(worker.sections), ["workOrders"]);
  const workerTotal = Object.values(worker.sections.workOrders.byStatus).reduce((a, b) => a + b, 0);
  assert.equal(workerTotal, own.size, "worker totals cover only their own work orders");
  assert.equal((await get("ADMIN", "/api/analytics/overview?from=2026-02-30")).status, 400);

  // --- Buildings: create, geometry revision + history, optimistic conflict, validation.
  const code = `TEST-${randomUUID().slice(0, 8)}`;
  const send = (method, path, body) => fetch(base + path, { method, headers: { ...users.ADMIN.headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const square = [[14.6, 121.0], [14.6, 121.0009], [14.6009, 121.0009], [14.6009, 121.0]];
  const create = await send("POST", "/api/admin/buildings", { code, name: `Test ${code}`, defaultLat: 14.60045, defaultLng: 121.00045, perimeter: square, toleranceMeters: 20 });
  assert.equal(create.status, 201);
  const b = (await create.json()).building;
  created.push(b.id);
  assert.equal(b.geometryRevision, 1);
  const moved = await send("PATCH", `/api/admin/buildings/${b.id}`, { toleranceMeters: 30, geometryRevision: 1, reason: "survey" });
  assert.equal((await moved.json()).building.geometryRevision, 2);
  assert.equal((await send("PATCH", `/api/admin/buildings/${b.id}`, { toleranceMeters: 40, geometryRevision: 1 })).status, 409, "stale revision rejected");
  assert.equal((await send("PATCH", `/api/admin/buildings/${b.id}`, { perimeter: [[1, 1], [2, 2]] })).status, 400);
  const renamed = await send("PATCH", `/api/admin/buildings/${b.id}`, { name: `Renamed ${code}` });
  assert.equal((await renamed.json()).building.geometryRevision, 2, "a rename is not a geometry change");
  const history = (await get("ADMIN", `/api/admin/buildings/${b.id}/geometry-history`)).body.items;
  assert.deepEqual(history.map((h) => h.revision), [2, 1]);
  assert.equal(history[0].reason, "survey");

  // --- Map: active markers only, raw GPS preserved, worker scoped to own work orders.
  const map = (await get("ADMIN", "/api/map")).body;
  assert.ok(map.buildings.some((x) => x.id === b.id));
  const activeReports = await sqlCount(`SELECT COUNT(*) n FROM "dbo"."Reports" WHERE "Status" NOT IN ('RESOLVED','NO_ACTION','DUPLICATE','CANCELLED')`);
  assert.equal(map.markers.filter((m) => m.kind === "REPORT").length, activeReports);
  for (const m of map.markers) {
    assert.ok(["GPS", "BUILDING_DEFAULT", "NONE"].includes(m.location.source));
    if (m.location.source !== "GPS") assert.ok(m.location.gpsCheck);
  }
  const workerMap = (await get("WORKER", "/api/map")).body;
  assert.equal(workerMap.markers.filter((m) => m.kind === "REPORT").length, 0);
  for (const m of workerMap.markers) assert.ok(own.has(m.id), "worker map shows only own work orders");

  // --- Index evidence: the trigram index can serve the report search predicate.
  const client = await pool.connect();
  try {
    await client.query("BEGIN; SET LOCAL enable_seqscan = off");
    const plan = (await client.query(`EXPLAIN SELECT 1 FROM "dbo"."Reports" r
      WHERE (r."ReportNo" || ' ' || coalesce(r."Description", '') || ' ' || coalesce(r."Building", '')) ILIKE '%stair%'`)).rows.map((r) => r["QUERY PLAN"]).join("\n");
    await client.query("ROLLBACK");
    assert.match(plan, /IX_Reports_Search_Trgm/, plan);
    console.log("report search plan (seqscan off):\n" + plan);
  } finally {
    client.release();
  }
});
