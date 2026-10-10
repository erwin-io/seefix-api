/**
 * Opt-in live ACL parity (SEEFIX_INTEGRATION_DB=1). Read-only: for one active user per role
 * and real report / work-order / handoff ids, POST /api/realtime/auth must allow exactly the
 * users that the matching REST GET allows. Prints a redacted matrix as acceptance evidence.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const live = process.env.SEEFIX_INTEGRATION_DB === "1";
const ROLES = ["ADMIN", "MAINTENANCE_SUPERVISOR", "MAINTENANCE_STAFF", "PROCUREMENT", "WORKER", "REPORTER"];

test("live: realtime channel auth matches REST read access", { skip: !live && "set SEEFIX_INTEGRATION_DB=1" }, async () => {
  const { app } = await import("../src/app.js");
  const { pool, query } = await import("../src/database.js");
  const { signAccessToken } = await import("../src/middleware/auth.js");
  const { clientRealtimeEnabled } = await import("../src/realtime/pusher-client.js");
  assert.ok(clientRealtimeEnabled, "run with PUSHER_* and REALTIME_CLIENTS_ENABLED=on (see docs/REALTIME_ROLLOUT.md)");
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

      // Nonexistent records: REST 404, realtime must deny too.
      ["report", randomUUID(), null],
      ["work-order", randomUUID(), null],
      ["handoff", randomUUID(), null],
    ].map(([type, id, path]) => [type, id, path ?? `/api/${{ report: "reports", "work-order": "work-orders", handoff: "procurement/handoffs" }[type]}/${id}`]);
    const missingRoles = ROLES.filter((role) => !users.some((u) => u.Role === role));
    assert.deepEqual(missingRoles, [], `needs one active user per role; missing: ${missingRoles.join(", ")}`);

    // The Pusher secret never leaves the server: not in /config, not in an /auth signature response.
    const { config } = await import("../src/config.js");
    const u0 = users[0];
    const h0 = { Authorization: `Bearer ${signAccessToken({ id: u0.Id, role: u0.Role, email: u0.Email }, u0.CredentialsVersion)}` };
    const cfgText = await (await fetch(base + "/api/realtime/config", { headers: h0 })).text();
    const authText = await (await fetch(base + "/api/realtime/auth", { method: "POST", headers: { ...h0, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ socket_id: "1.2", channel_name: `private-user-${u0.Id}` }) })).text();
    assert.ok(config.pusherSecret.length > 0, "live run needs PUSHER_SECRET");
    for (const text of [cfgText, authText]) assert.ok(!text.includes(config.pusherSecret), "secret must not be returned");
    assert.deepEqual(Object.keys(JSON.parse(cfgText)).sort(), ["cluster", "enabled", "key", "userChannel"]);
    assert.deepEqual(Object.keys(JSON.parse(authText)), ["auth"]);
    assert.match(JSON.parse(authText).auth, /^[^:]+:[0-9a-f]{64}$/, "auth is key:HMAC only");
    console.log("Secret check: /config keys [cluster,enabled,key,userChannel], /auth keys [auth]; secret absent from both.");

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
    // Scoped roles must show both an allowed and a denied record, or the parity check proves nothing for them.
    const unproven = ["WORKER", "REPORTER", "PROCUREMENT"].filter((role) => {
      const r = rows.filter((x) => x.role === role && x.type !== "user");
      return !r.some((x) => x.realtime === 200) || !r.some((x) => x.realtime !== 200);
    });
    assert.deepEqual(unproven, [], `scoped roles need positive and negative examples; missing for: ${unproven.join(", ")}`);
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
