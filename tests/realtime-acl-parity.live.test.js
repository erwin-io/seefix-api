/**
 * Opt-in live ACL parity (SEEFIX_INTEGRATION_DB=1). Read-only: for one active user per role
 * and real report / work-order / handoff ids, POST /api/realtime/auth must allow exactly the
 * users that the matching REST GET allows. Prints a redacted matrix as acceptance evidence.
 */
import test from "node:test";
import assert from "node:assert/strict";

const live = process.env.SEEFIX_INTEGRATION_DB === "1";
const ROLES = ["ADMIN", "MAINTENANCE_SUPERVISOR", "MAINTENANCE_STAFF", "PROCUREMENT", "WORKER", "REPORTER"];

test("live: realtime channel auth matches REST read access", { skip: !live && "set SEEFIX_INTEGRATION_DB=1" }, async () => {
  const { app } = await import("../src/app.js");
  const { pool, query } = await import("../src/database.js");
  const { signAccessToken } = await import("../src/middleware/auth.js");
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const users = [];
    for (const role of ROLES) {
      // Prefer users that own/lead records so positive cases exist, not only denials.
      const r = await query(
        `SELECT u."Id",u."Role",u."Email",u."CredentialsVersion" FROM "dbo"."Users" u WHERE u."IsActive" AND u."Role"=$1
          ORDER BY (EXISTS(SELECT 1 FROM "dbo"."WorkOrders" w WHERE w."ResponsibleLeadUserId"=u."Id")
                 OR EXISTS(SELECT 1 FROM "dbo"."Reports" r WHERE r."ReporterId"=u."Id")) DESC LIMIT 1`,
        [role],
      );
      if (r.rows[0]) users.push(r.rows[0]);
    }
    const ids = async (sql) => (await query(sql)).rows.map((x) => x.Id);
    const cases = [
      ...(await ids(`SELECT DISTINCT r."Id" FROM "dbo"."Reports" r LEFT JOIN "dbo"."WorkOrders" w ON w."ReportId"=r."Id" ORDER BY r."Id" LIMIT 8`)).map((id) => ["report", id, `/api/reports/${id}`]),
      ...(await ids(`SELECT r."Id" FROM "dbo"."Reports" r JOIN "dbo"."MaintenanceRequests" mr ON mr."ReportId"=r."Id" JOIN "dbo"."ProcurementHandoffs" ph ON ph."MaintenanceRequestId"=mr."Id" LIMIT 3`)).map((id) => ["report", id, `/api/reports/${id}`]),
      ...(await ids(`SELECT r."Id" FROM "dbo"."Reports" r JOIN "dbo"."WorkOrders" w ON w."ReportId"=r."Id" LIMIT 3`)).map((id) => ["report", id, `/api/reports/${id}`]),
      ...(await ids(`SELECT "Id" FROM "dbo"."WorkOrders" ORDER BY "CreatedAt" DESC LIMIT 6`)).map((id) => ["work-order", id, `/api/work-orders/${id}`]),
      ...(await ids(`SELECT "Id" FROM "dbo"."ProcurementHandoffs" ORDER BY "CreatedAt" DESC LIMIT 4`)).map((id) => ["handoff", id, `/api/procurement/handoffs/${id}`]),
    ];
    assert.ok(users.length >= 5 && cases.length > 0, "needs seeded users and records");

    const rows = [];
    const mismatches = [];
    for (const u of users) {
      const auth = { Authorization: `Bearer ${signAccessToken({ id: u.Id, role: u.Role, email: u.Email }, u.CredentialsVersion)}` };
      for (const [type, id, path] of cases) {
        const rest = (await fetch(base + path, { headers: auth })).status;
        const rt = (
          await fetch(base + "/api/realtime/auth", {
            method: "POST",
            headers: { ...auth, "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ socket_id: "123.456", channel_name: `private-${type}-${id}` }),
          })
        ).status;
        const row = { role: u.Role, type, id: `${id.slice(0, 8)}…`, rest, realtime: rt };
        rows.push(row);
        if ((rest === 200) !== (rt === 200)) mismatches.push(row);
      }
      // Own vs another user's private-user channel.
      const own = await fetch(base + "/api/realtime/auth", { method: "POST", headers: { ...auth, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ socket_id: "1.2", channel_name: `private-user-${u.Id}` }) });
      const other = users.find((x) => x.Id !== u.Id);
      const foreign = await fetch(base + "/api/realtime/auth", { method: "POST", headers: { ...auth, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ socket_id: "1.2", channel_name: `private-user-${other.Id}` }) });
      rows.push({ role: u.Role, type: "user", id: "own/other", rest: "-", realtime: `${own.status}/${foreign.status}` });
      if (own.status !== 200 || foreign.status !== 403) mismatches.push(rows.at(-1));
    }
    const summary = {};
    for (const r of rows) {
      const k = `${r.role} ${r.type}`;
      summary[k] ??= { allowed: 0, denied: 0 };
      if (r.type === "user") summary[k] = r.realtime;
      else summary[k][r.realtime === 200 ? "allowed" : "denied"] += 1;
    }
    console.log(`ACL parity: ${users.length} roles x ${cases.length} records; mismatches=${mismatches.length}`);
    console.table(summary);
    assert.deepEqual(mismatches, [], "realtime auth must equal REST read access");
  } finally {
    server.close();
    await pool.end();
  }
});
