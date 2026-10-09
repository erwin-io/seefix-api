import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// Always-on structural checks (no database needed).
test("assignable-users is registered before /:id and restricted to assigning roles", () => {
  const wo = source("src/routes/work-orders.js");
  const assignable = wo.indexOf('router.get("/assignable-users", ASSIGN_ROLES');
  const byId = wo.indexOf('router.get("/:id"');
  assert.ok(assignable > 0, "route exists with ASSIGN_ROLES guard");
  assert.ok(assignable < byId, "must precede /:id or Express treats it as an id");
  assert.match(wo, /"IsActive"=TRUE AND "Role" IN \('WORKER','MAINTENANCE_STAFF','MAINTENANCE_SUPERVISOR','ADMIN'\)/);
  assert.doesNotMatch(wo.slice(assignable, byId), /PasswordHash|CredentialsVersion/);
});

test("reference categories exposes only active code/name/defaultUrgency", () => {
  const ref = source("src/routes/reference.js");
  const block = ref.slice(ref.indexOf('router.get("/categories"'));
  assert.match(block, /WHERE "IsActive"=TRUE/);
  assert.match(block, /"Code" AS code,"Name" AS name,"DefaultUrgency" AS "defaultUrgency"/);
});

test("procurement handoff detail returns ReportId", () => {
  assert.match(source("src/routes/procurement.js"), /r\."Id" AS "ReportId"/);
});

// Opt-in live check against a populated dev database (read-only):
//   SEEFIX_INTEGRATION_DB=1 node --test tests/web-admin-contract.test.js
const live = process.env.SEEFIX_INTEGRATION_DB === "1";

test("live: RBAC and response shape of the web-admin contract endpoints", { skip: !live && "set SEEFIX_INTEGRATION_DB=1" }, async (t) => {
  const { app } = await import("../src/app.js");
  const { query, pool } = await import("../src/database.js");
  const { signAccessToken } = await import("../src/middleware/auth.js");
  const server = app.listen(0);
  t.after(async () => {
    server.close();
    await pool.end();
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const users = (await query(
    `SELECT DISTINCT ON ("Role") "Id","Role","Email","CredentialsVersion" FROM "dbo"."Users" WHERE "IsActive"=TRUE ORDER BY "Role","CreatedAt"`,
  )).rows;
  const tokenFor = (role) => {
    const u = users.find((x) => x.Role === role);
    return u ? signAccessToken({ id: u.Id, role: u.Role, email: u.Email }, u.CredentialsVersion) : null;
  };
  const get = (path, role) =>
    fetch(base + path, { headers: role ? { Authorization: `Bearer ${tokenFor(role)}` } : {} });

  for (const role of ["MAINTENANCE_STAFF", "MAINTENANCE_SUPERVISOR", "ADMIN"]) {
    if (!tokenFor(role)) continue;
    const res = await get("/api/work-orders/assignable-users", role);
    assert.equal(res.status, 200, role);
    const { items } = await res.json();
    assert.ok(items.every((u) => ["WORKER", "MAINTENANCE_STAFF", "MAINTENANCE_SUPERVISOR", "ADMIN"].includes(u.role)));
    assert.ok(items.every((u) => !("passwordHash" in u) && !("PasswordHash" in u)));
  }
  for (const role of ["WORKER", "PROCUREMENT", "REPORTER"]) {
    if (tokenFor(role)) assert.equal((await get("/api/work-orders/assignable-users", role)).status, 403, role);
  }
  assert.equal((await get("/api/work-orders/assignable-users")).status, 401);

  const active = Number((await query(`SELECT COUNT(*) n FROM "dbo"."DamageCategories" WHERE "IsActive"=TRUE`)).rows[0].n);
  const cats = await get("/api/reference/categories", "MAINTENANCE_STAFF");
  assert.equal(cats.status, 200);
  assert.equal((await cats.json()).items.length, active);
  assert.equal((await get("/api/reference/categories")).status, 401);

  const handoff = (await query(
    `SELECT ph."Id", mr."ReportId" FROM "dbo"."ProcurementHandoffs" ph JOIN "dbo"."MaintenanceRequests" mr ON mr."Id"=ph."MaintenanceRequestId" LIMIT 1`,
  )).rows[0];
  if (handoff) {
    const res = await get(`/api/procurement/handoffs/${handoff.Id}`, "PROCUREMENT");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).handoff.ReportId, handoff.ReportId);
  }
});
