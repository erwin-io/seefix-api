const baseUrl = (process.env.SEEFIX_RBAC_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const commonPassword = process.env.SEEFIX_RBAC_PASSWORD || "";

const accounts = {
  REPORTER: {
    email: process.env.SEEFIX_RBAC_REPORTER_EMAIL || "reporter@seefix.local",
    password: process.env.SEEFIX_RBAC_REPORTER_PASSWORD || commonPassword,
  },
  PPO_STAFF: {
    email: process.env.SEEFIX_RBAC_PPO_STAFF_EMAIL || "ppo.staff@seefix.local",
    password: process.env.SEEFIX_RBAC_PPO_STAFF_PASSWORD || commonPassword,
  },
  PPO_HEAD: {
    email: process.env.SEEFIX_RBAC_PPO_HEAD_EMAIL || "ppo.head@seefix.local",
    password: process.env.SEEFIX_RBAC_PPO_HEAD_PASSWORD || commonPassword,
  },
  PROCUREMENT: {
    email: process.env.SEEFIX_RBAC_PROCUREMENT_EMAIL || "procurement@seefix.local",
    password: process.env.SEEFIX_RBAC_PROCUREMENT_PASSWORD || commonPassword,
  },
  STAFF: {
    email: process.env.SEEFIX_RBAC_STAFF_EMAIL || "maintenance.staff@seefix.local",
    password: process.env.SEEFIX_RBAC_STAFF_PASSWORD || commonPassword,
  },
  ADMIN: {
    email: process.env.SEEFIX_RBAC_ADMIN_EMAIL || "admin.test@seefix.local",
    password: process.env.SEEFIX_RBAC_ADMIN_PASSWORD || commonPassword,
  },
};

function requiredCredentials() {
  const missing = Object.entries(accounts)
    .filter(([, value]) => !value.password)
    .map(([role]) => role);
  if (missing.length) {
    throw new Error(
      `Missing test password(s) for ${missing.join(", ")}. Set SEEFIX_RBAC_PASSWORD for a shared password or role-specific SEEFIX_RBAC_<ROLE>_PASSWORD variables.`,
    );
  }
}

async function request(path, { token, method = "GET", body } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: response.status, json };
}

async function login(expectedRole) {
  const account = accounts[expectedRole];
  const result = await request("/api/auth/login", {
    method: "POST",
    body: { email: account.email, password: account.password },
  });
  if (result.status !== 200) {
    throw new Error(
      `${expectedRole} login failed (${result.status}): ${JSON.stringify(result.json)}`,
    );
  }
  if (result.json?.user?.role !== expectedRole) {
    throw new Error(
      `${account.email} returned role ${result.json?.user?.role}; expected ${expectedRole}.`,
    );
  }
  return result.json.accessToken;
}

function pass(message) {
  console.log(`PASS  ${message}`);
}

function fail(message) {
  throw new Error(`FAIL  ${message}`);
}

async function expectStatus(label, token, path, expected, options = {}) {
  const result = await request(path, { token, ...options });
  const expectedStatuses = Array.isArray(expected) ? expected : [expected];
  if (!expectedStatuses.includes(result.status)) {
    fail(
      `${label}: expected ${expectedStatuses.join("/")}, got ${result.status} ${JSON.stringify(result.json)}`,
    );
  }
  pass(`${label} -> ${result.status}`);
}

async function main() {
  requiredCredentials();
  const health = await request("/health");
  if (![200, 503].includes(health.status)) {
    throw new Error(`SEEFIX API is not reachable at ${baseUrl}.`);
  }

  const tokens = {};
  for (const role of Object.keys(accounts)) {
    tokens[role] = await login(role);
    pass(`${role} login and database role match`);
  }

  // PPO action center: PPO roles + ADMIN only.
  for (const role of ["PPO_STAFF", "PPO_HEAD", "ADMIN"])
    await expectStatus(`${role} can read PPO action center`, tokens[role], "/api/ppo/action-center", 200);
  for (const role of ["REPORTER", "PROCUREMENT", "STAFF"])
    await expectStatus(`${role} cannot read PPO action center`, tokens[role], "/api/ppo/action-center", 403);

  // Procurement inbox is visible to Procurement/PPO/Admin for handoff tracking.
  for (const role of ["PROCUREMENT", "PPO_STAFF", "PPO_HEAD", "ADMIN"])
    await expectStatus(`${role} can read Procurement inbox`, tokens[role], "/api/procurement/inbox", 200);
  for (const role of ["REPORTER", "STAFF"])
    await expectStatus(`${role} cannot read Procurement inbox`, tokens[role], "/api/procurement/inbox", 403);

  // Work Order read access is PPO/STAFF/Admin, not Reporter or Procurement.
  for (const role of ["STAFF", "PPO_STAFF", "PPO_HEAD", "ADMIN"])
    await expectStatus(`${role} can read Work Orders`, tokens[role], "/api/work-orders", 200);
  for (const role of ["REPORTER", "PROCUREMENT"])
    await expectStatus(`${role} cannot read Work Orders`, tokens[role], "/api/work-orders", 403);

  // Admin directory is ADMIN only.
  await expectStatus("ADMIN can read user directory", tokens.ADMIN, "/api/admin/users", 200);
  for (const role of ["REPORTER", "PPO_STAFF", "PPO_HEAD", "PROCUREMENT", "STAFF"])
    await expectStatus(`${role} cannot read Admin user directory`, tokens[role], "/api/admin/users", 403);

  // Mutation gates use a guaranteed-missing UUID so the allowed role can reach
  // normal route validation without changing real workflow data.
  const missingId = "00000000-0000-0000-0000-000000000001";
  await expectStatus(
    "PPO_STAFF passes Verify & Request role gate",
    tokens.PPO_STAFF,
    `/api/ppo/reports/${missingId}/verify-request-maintenance`,
    404,
    { method: "POST", body: {} },
  );
  await expectStatus(
    "PPO_HEAD is blocked from PPO Staff Verify & Request gate",
    tokens.PPO_HEAD,
    `/api/ppo/reports/${missingId}/verify-request-maintenance`,
    403,
    { method: "POST", body: {} },
  );
  await expectStatus(
    "REPORTER is blocked from Verify & Request gate",
    tokens.REPORTER,
    `/api/ppo/reports/${missingId}/verify-request-maintenance`,
    403,
    { method: "POST", body: {} },
  );

  await expectStatus(
    "PROCUREMENT passes handoff acknowledge role gate",
    tokens.PROCUREMENT,
    `/api/procurement/handoffs/${missingId}/acknowledge`,
    404,
    { method: "POST" },
  );
  await expectStatus(
    "STAFF is blocked from Procurement acknowledge",
    tokens.STAFF,
    `/api/procurement/handoffs/${missingId}/acknowledge`,
    403,
    { method: "POST" },
  );

  await expectStatus(
    "STAFF passes Work Order execution role gate",
    tokens.STAFF,
    `/api/work-orders/${missingId}/start`,
    404,
    { method: "POST" },
  );
  await expectStatus(
    "PROCUREMENT is blocked from Work Order execution",
    tokens.PROCUREMENT,
    `/api/work-orders/${missingId}/start`,
    403,
    { method: "POST" },
  );

  console.log("\nRBAC acceptance test passed. No real workflow record was mutated.");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
