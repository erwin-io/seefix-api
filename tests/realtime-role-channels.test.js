import test from "node:test";
import assert from "node:assert/strict";
import { canSubscribeRole, roleChannel } from "../src/realtime/role-channels.js";
import { parseChannel } from "../src/realtime/channels.js";
import { DOMAINS_BY_ROLE } from "../src/routes/sync.js";

const U = "22222222-2222-4222-8222-222222222222";
const ROLES = ["ADMIN", "MAINTENANCE_SUPERVISOR", "MAINTENANCE_STAFF", "PROCUREMENT", "WORKER", "REPORTER"];

test("roleChannel: one channel per role that may read /api/sync/versions; none for REPORTER or unknown roles", () => {
  for (const role of Object.keys(DOMAINS_BY_ROLE)) assert.equal(roleChannel(role), `private-role-${role}`);
  for (const role of ["REPORTER", "GUEST", "", undefined, "__proto__", "constructor", "toString"]) assert.equal(roleChannel(role), null, String(role));
});

test("canSubscribeRole: exactly the caller's own current role, nothing else", () => {
  for (const mine of ROLES) {
    for (const target of ROLES) {
      const allowed = canSubscribeRole({ id: U, role: mine }, `private-role-${target}`);
      assert.equal(allowed, mine === target && mine !== "REPORTER", `${mine} -> ${target}`);
    }
  }
});

test("canSubscribeRole refuses malformed, case-variant and wildcard names and anonymous users", () => {
  const admin = { id: U, role: "ADMIN" };
  for (const bad of ["private-role-admin", "private-role-ADMIN ", " private-role-ADMIN", "private-role-ADMIN-x", "private-role-*", "private-role-", "role-ADMIN",
    "presence-role-ADMIN", "private-role-ADMIN\n", `private-user-${U}`, "", null, undefined]) {
    assert.equal(canSubscribeRole(admin, bad), false, JSON.stringify(bad));
  }
  assert.equal(canSubscribeRole(null, "private-role-ADMIN"), false);
  assert.equal(canSubscribeRole({ role: "ADMIN" }, "private-role-ADMIN"), false, "no user id");
});

test("role channels stay outside the record-channel model (channels.js unchanged, verbatim in seefix-worker)", () => {
  assert.equal(parseChannel("private-role-ADMIN"), null);
});
