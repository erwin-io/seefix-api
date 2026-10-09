const baseUrl = (
  process.env
    .SEEFIX_RBAC_BASE_URL ||
  "http://127.0.0.1:3000"
).replace(
  /\/$/,
  "",
);


const commonPassword =
  process.env
    .SEEFIX_RBAC_PASSWORD ||
  "";


const accounts = {
  REPORTER: {
    email:
      process.env
        .SEEFIX_RBAC_REPORTER_EMAIL ||
      "reporter@seefix.local",

    password:
      process.env
        .SEEFIX_RBAC_REPORTER_PASSWORD ||
      commonPassword,
  },


  MAINTENANCE_STAFF: {
    email:
      process.env
        .SEEFIX_RBAC_MAINTENANCE_STAFF_EMAIL ||
      "maintenance.staff@seefix.local",

    password:
      process.env
        .SEEFIX_RBAC_MAINTENANCE_STAFF_PASSWORD ||
      commonPassword,
  },


  MAINTENANCE_SUPERVISOR: {
    email:
      process.env
        .SEEFIX_RBAC_MAINTENANCE_SUPERVISOR_EMAIL ||
      "maintenance.supervisor@seefix.local",

    password:
      process.env
        .SEEFIX_RBAC_MAINTENANCE_SUPERVISOR_PASSWORD ||
      commonPassword,
  },


  PROCUREMENT: {
    email:
      process.env
        .SEEFIX_RBAC_PROCUREMENT_EMAIL ||
      "procurement@seefix.local",

    password:
      process.env
        .SEEFIX_RBAC_PROCUREMENT_PASSWORD ||
      commonPassword,
  },


  WORKER: {
    email:
      process.env
        .SEEFIX_RBAC_WORKER_EMAIL ||
      "worker@seefix.local",

    password:
      process.env
        .SEEFIX_RBAC_WORKER_PASSWORD ||
      commonPassword,
  },


  ADMIN: {
    email:
      process.env
        .SEEFIX_RBAC_ADMIN_EMAIL ||
      "admin.test@seefix.local",

    password:
      process.env
        .SEEFIX_RBAC_ADMIN_PASSWORD ||
      commonPassword,
  },
};


function requiredCredentials() {
  const missing =
    Object.entries(
      accounts,
    )
      .filter(
        ([, value]) =>
          !value.password,
      )
      .map(
        ([role]) =>
          role,
      );


  if (
    missing.length
  ) {
    throw new Error(
      (
        `Missing test password(s) for ` +
        `${missing.join(", ")}. ` +
        "Set SEEFIX_RBAC_PASSWORD " +
        "for a shared password or " +
        "role-specific " +
        "SEEFIX_RBAC_<ROLE>_PASSWORD " +
        "variables."
      ),
    );
  }
}


async function request(
  path,
  {
    token,
    method = "GET",
    body,
  } = {},
) {
  const headers = {
    Accept:
      "application/json",
  };


  if (token) {
    headers.Authorization =
      `Bearer ${token}`;
  }


  if (
    body !== undefined
  ) {
    headers[
      "Content-Type"
    ] =
      "application/json";
  }


  const response =
    await fetch(
      `${baseUrl}${path}`,
      {
        method,
        headers,

        body:
          body === undefined
            ? undefined
            : JSON.stringify(
                body,
              ),
      },
    );


  const text =
    await response.text();


  let json = null;


  try {
    json =
      text
        ? JSON.parse(text)
        : null;
  } catch {
    json = {
      raw: text,
    };
  }


  return {
    status:
      response.status,

    json,
  };
}


async function login(
  expectedRole,
) {
  const account =
    accounts[
      expectedRole
    ];


  const result =
    await request(
      "/api/auth/login",
      {
        method:
          "POST",

        body: {
          email:
            account.email,

          password:
            account.password,
        },
      },
    );


  if (
    result.status !== 200
  ) {
    throw new Error(
      (
        `${expectedRole} ` +
        `login failed ` +
        `(${result.status}): ` +
        JSON.stringify(
          result.json,
        )
      ),
    );
  }


  if (
    result.json
      ?.user
      ?.role !==
    expectedRole
  ) {
    throw new Error(
      (
        `${account.email} ` +
        `returned role ` +
        `${result.json?.user?.role}; ` +
        `expected ${expectedRole}.`
      ),
    );
  }


  return (
    result.json
      .accessToken
  );
}


function pass(
  message,
) {
  console.log(
    `PASS  ${message}`,
  );
}


function fail(
  message,
) {
  throw new Error(
    `FAIL  ${message}`,
  );
}


async function expectStatus(
  label,
  token,
  path,
  expected,
  options = {},
) {
  const result =
    await request(
      path,
      {
        token,
        ...options,
      },
    );


  const expectedStatuses =
    Array.isArray(
      expected,
    )
      ? expected
      : [
          expected,
        ];


  if (
    !expectedStatuses
      .includes(
        result.status,
      )
  ) {
    fail(
      (
        `${label}: expected ` +
        `${expectedStatuses.join("/")}, ` +
        `got ${result.status} ` +
        JSON.stringify(
          result.json,
        )
      ),
    );
  }


  pass(
    `${label} -> ${result.status}`,
  );
}


async function main() {
  requiredCredentials();


  const health =
    await request(
      "/health",
    );


  if (
    ![
      200,
      503,
    ].includes(
      health.status,
    )
  ) {
    throw new Error(
      (
        "SEEFIX API is not " +
        `reachable at ${baseUrl}.`
      ),
    );
  }


  const tokens = {};


  for (
    const role
    of Object.keys(
      accounts,
    )
  ) {
    tokens[role] =
      await login(
        role,
      );

    pass(
      (
        `${role} login and ` +
        "database role match"
      ),
    );
  }


  /*
   * Maintenance Department views.
   */

  for (
    const role
    of [
      "MAINTENANCE_STAFF",
      "MAINTENANCE_SUPERVISOR",
      "ADMIN",
    ]
  ) {
    await expectStatus(
      (
        `${role} can read ` +
        "Maintenance action center"
      ),
      tokens[role],
      "/api/maintenance/action-center",
      200,
    );


    await expectStatus(
      (
        `${role} can read ` +
        "Maintenance review queue"
      ),
      tokens[role],
      "/api/maintenance/review-queue",
      200,
    );
  }


  for (
    const role
    of [
      "REPORTER",
      "PROCUREMENT",
      "WORKER",
    ]
  ) {
    await expectStatus(
      (
        `${role} cannot read ` +
        "Maintenance action center"
      ),
      tokens[role],
      "/api/maintenance/action-center",
      403,
    );


    await expectStatus(
      (
        `${role} cannot read ` +
        "Maintenance review queue"
      ),
      tokens[role],
      "/api/maintenance/review-queue",
      403,
    );
  }


  /*
   * Procurement inbox.
   */

  for (
    const role
    of [
      "PROCUREMENT",
      "MAINTENANCE_STAFF",
      "MAINTENANCE_SUPERVISOR",
      "ADMIN",
    ]
  ) {
    await expectStatus(
      (
        `${role} can read ` +
        "Procurement inbox"
      ),
      tokens[role],
      "/api/procurement/inbox",
      200,
    );
  }


  for (
    const role
    of [
      "REPORTER",
      "WORKER",
    ]
  ) {
    await expectStatus(
      (
        `${role} cannot read ` +
        "Procurement inbox"
      ),
      tokens[role],
      "/api/procurement/inbox",
      403,
    );
  }


  /*
   * Work Order visibility.
   */

  for (
    const role
    of [
      "WORKER",
      "MAINTENANCE_STAFF",
      "MAINTENANCE_SUPERVISOR",
      "ADMIN",
    ]
  ) {
    await expectStatus(
      (
        `${role} can read ` +
        "Work Orders"
      ),
      tokens[role],
      "/api/work-orders",
      200,
    );
  }


  for (
    const role
    of [
      "REPORTER",
      "PROCUREMENT",
    ]
  ) {
    await expectStatus(
      (
        `${role} cannot read ` +
        "Work Orders"
      ),
      tokens[role],
      "/api/work-orders",
      403,
    );
  }


  /*
   * Admin directory.
   */

  await expectStatus(
    "ADMIN can read user directory",
    tokens.ADMIN,
    "/api/admin/users",
    200,
  );


  for (
    const role
    of [
      "REPORTER",
      "MAINTENANCE_STAFF",
      "MAINTENANCE_SUPERVISOR",
      "PROCUREMENT",
      "WORKER",
    ]
  ) {
    await expectStatus(
      (
        `${role} cannot read ` +
        "Admin user directory"
      ),
      tokens[role],
      "/api/admin/users",
      403,
    );
  }


  /*
   * Guaranteed missing UUID.
   *
   * Allowed roles should pass RBAC
   * and reach normal 404 validation.
   * Blocked roles must receive 403.
   */

  const missingId =
    (
      "00000000-0000-0000-" +
      "0000-000000000001"
    );


  /*
   * Maintenance Review gate.
   */

  for (
    const role
    of [
      "MAINTENANCE_STAFF",
      "MAINTENANCE_SUPERVISOR",
      "ADMIN",
    ]
  ) {
    await expectStatus(
      (
        `${role} passes ` +
        "Maintenance Review role gate"
      ),

      tokens[role],

      (
        "/api/maintenance/reports/" +
        `${missingId}/review`
      ),

      404,

      {
        method:
          "POST",

        body: {
          decision:
            "NO_ACTION",

          decisionReason:
            "RBAC acceptance test only.",
        },
      },
    );
  }


  for (
    const role
    of [
      "REPORTER",
      "PROCUREMENT",
      "WORKER",
    ]
  ) {
    await expectStatus(
      (
        `${role} is blocked from ` +
        "Maintenance Review"
      ),

      tokens[role],

      (
        "/api/maintenance/reports/" +
        `${missingId}/review`
      ),

      403,

      {
        method:
          "POST",

        body: {
          decision:
            "NO_ACTION",

          decisionReason:
            "RBAC acceptance test only.",
        },
      },
    );
  }


  /*
   * Procurement mutation gate.
   */

  await expectStatus(
    (
      "PROCUREMENT passes handoff " +
      "acknowledge role gate"
    ),

    tokens.PROCUREMENT,

    (
      "/api/procurement/handoffs/" +
      `${missingId}/acknowledge`
    ),

    404,

    {
      method:
        "POST",
    },
  );


  await expectStatus(
    (
      "WORKER is blocked from " +
      "Procurement acknowledge"
    ),

    tokens.WORKER,

    (
      "/api/procurement/handoffs/" +
      `${missingId}/acknowledge`
    ),

    403,

    {
      method:
        "POST",
    },
  );


  /*
   * Maintenance Supervisor-only gate.
   */

  await expectStatus(
    (
      "MAINTENANCE_SUPERVISOR " +
      "passes clarification-response " +
      "role gate"
    ),

    tokens
      .MAINTENANCE_SUPERVISOR,

    (
      "/api/maintenance/" +
      "procurement/clarifications/" +
      `${missingId}/respond`
    ),

    404,

    {
      method:
        "POST",

      body: {
        response:
          "RBAC acceptance test only.",
      },
    },
  );


  await expectStatus(
    (
      "MAINTENANCE_STAFF is blocked " +
      "from supervisor " +
      "clarification-response gate"
    ),

    tokens
      .MAINTENANCE_STAFF,

    (
      "/api/maintenance/" +
      "procurement/clarifications/" +
      `${missingId}/respond`
    ),

    403,

    {
      method:
        "POST",

      body: {
        response:
          "RBAC acceptance test only.",
      },
    },
  );


  /*
   * Work Order assignment.
   */

  await expectStatus(
    (
      "MAINTENANCE_STAFF passes " +
      "Work Order assignment role gate"
    ),

    tokens
      .MAINTENANCE_STAFF,

    (
      "/api/work-orders/" +
      `${missingId}/assign`
    ),

    404,

    {
      method:
        "POST",

      body: {
        assignedPartyName:
          "RBAC Test Maintenance Team",
      },
    },
  );


  await expectStatus(
    (
      "PROCUREMENT is blocked from " +
      "Work Order assignment"
    ),

    tokens.PROCUREMENT,

    (
      "/api/work-orders/" +
      `${missingId}/assign`
    ),

    403,

    {
      method:
        "POST",

      body: {
        assignedPartyName:
          "RBAC Test Maintenance Team",
      },
    },
  );


  /*
   * Worker execution.
   */

  await expectStatus(
    (
      "WORKER passes Work Order " +
      "execution role gate"
    ),

    tokens.WORKER,

    (
      "/api/work-orders/" +
      `${missingId}/start`
    ),

    404,

    {
      method:
        "POST",
    },
  );


  await expectStatus(
    (
      "PROCUREMENT is blocked from " +
      "Work Order execution"
    ),

    tokens.PROCUREMENT,

    (
      "/api/work-orders/" +
      `${missingId}/start`
    ),

    403,

    {
      method:
        "POST",
    },
  );


  console.log(
    (
      "\nRBAC acceptance test passed. " +
      "No real workflow record was mutated."
    ),
  );
}


main().catch(
  (error) => {
    console.error(
      error.message ||
        error,
    );

    process.exitCode = 1;
  },
);