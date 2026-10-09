import "dotenv/config";

import bcrypt from "bcrypt";

import {
  pool,
  query,
} from "../src/database.js";

import {
  config,
} from "../src/config.js";


const password = String(
  process.env
    .SEEFIX_RBAC_PASSWORD ||
    "",
).trim();


if (
  password.length < 8
) {
  console.error(
    (
      "SEEFIX_RBAC_PASSWORD must be " +
      "set and contain at least 8 characters."
    ),
  );

  process.exitCode = 1;

  await pool.end();

  process.exit();
}


const users = [
  {
    institutionalId:
      "SEEFIX-TEST-REPORTER",

    fullName:
      "SEEFIX Test Reporter",

    email:
      "reporter@seefix.local",

    role:
      "REPORTER",

    jobTitle:
      "Reporter",

    departmentOrTrade:
      null,
  },

  {
    institutionalId:
      "SEEFIX-TEST-MAINT-STAFF",

    fullName:
      "SEEFIX Maintenance Staff",

    email:
      "maintenance.staff@seefix.local",

    role:
      "MAINTENANCE_STAFF",

    jobTitle:
      "Maintenance Staff",

    departmentOrTrade:
      "Building Maintenance",
  },

  {
    institutionalId:
      "SEEFIX-TEST-MAINT-SUP",

    fullName:
      "SEEFIX Maintenance Supervisor",

    email:
      "maintenance.supervisor@seefix.local",

    role:
      "MAINTENANCE_SUPERVISOR",

    jobTitle:
      "Building Maintenance Supervisor",

    departmentOrTrade:
      "Building Maintenance",
  },

  {
    institutionalId:
      "SEEFIX-TEST-PROC",

    fullName:
      "SEEFIX Procurement User",

    email:
      "procurement@seefix.local",

    role:
      "PROCUREMENT",

    jobTitle:
      "Procurement Staff",

    departmentOrTrade:
      "Procurement",
  },

  {
    institutionalId:
      "SEEFIX-TEST-WORKER",

    fullName:
      "SEEFIX Maintenance Worker",

    email:
      "worker@seefix.local",

    role:
      "WORKER",

    jobTitle:
      "Maintenance Worker",

    departmentOrTrade:
      "Building Maintenance",
  },

  {
    institutionalId:
      "SEEFIX-TEST-ADMIN",

    fullName:
      "SEEFIX Test Administrator",

    email:
      "admin.test@seefix.local",

    role:
      "ADMIN",

    jobTitle:
      "System Administrator",

    departmentOrTrade:
      "SEEFIX",
  },
];


async function upsertUser(
  item,
  passwordHash,
) {
  const existing =
    await query(
      `
        SELECT
          "Id"

        FROM
          "dbo"."Users"

        WHERE
          LOWER("Email") =
          LOWER($1)

        LIMIT 1
      `,
      [
        item.email,
      ],
    );


  if (
    existing.rows[0]
  ) {
    const updated =
      await query(
        `
          UPDATE
            "dbo"."Users"

          SET
            "InstitutionalId" = $2,
            "FullName" = $3,
            "PasswordHash" = $4,
            "Role" = $5,
            "JobTitle" = $6,
            "DepartmentOrTrade" = $7,
            "IsActive" = TRUE,
            "UpdatedAt" = NOW()

          WHERE
            "Id" = $1

          RETURNING
            "Id" AS id,
            "FullName" AS "fullName",
            "Email" AS email,
            "Role" AS role,
            "IsActive" AS "isActive"
        `,
        [
          existing.rows[0].Id,
          item.institutionalId,
          item.fullName,
          passwordHash,
          item.role,
          item.jobTitle,
          item.departmentOrTrade,
        ],
      );


    return {
      action:
        "updated",

      user:
        updated.rows[0],
    };
  }


  const inserted =
    await query(
      `
        INSERT INTO
          "dbo"."Users"
          (
            "InstitutionalId",
            "FullName",
            "Email",
            "PasswordHash",
            "Role",
            "JobTitle",
            "DepartmentOrTrade",
            "IsActive"
          )

        VALUES
          (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            TRUE
          )

        RETURNING
          "Id" AS id,
          "FullName" AS "fullName",
          "Email" AS email,
          "Role" AS role,
          "IsActive" AS "isActive"
      `,
      [
        item.institutionalId,
        item.fullName,
        item.email,
        passwordHash,
        item.role,
        item.jobTitle,
        item.departmentOrTrade,
      ],
    );


  return {
    action:
      "created",

    user:
      inserted.rows[0],
  };
}


async function main() {
  console.log(
    (
      "Seeding SEEFIX RBAC " +
      "development users..."
    ),
  );


  const passwordHash =
    await bcrypt.hash(
      password,
      config.bcryptRounds,
    );


  for (
    const item
    of users
  ) {
    const result =
      await upsertUser(
        item,
        passwordHash,
      );


    console.log(
      (
        `${result.action.toUpperCase()} ` +
        `${result.user.role} ` +
        `${result.user.email}`
      ),
    );
  }


  console.log(
    (
      "\nRBAC development users are ready."
    ),
  );
}


try {
  await main();
} catch (error) {
  console.error(
    (
      "Unable to seed RBAC users:"
    ),

    error instanceof Error
      ? error.message
      : String(error),
  );

  process.exitCode = 1;
} finally {
  await pool.end();
}