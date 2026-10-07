import { Router } from "express";
import bcrypt from "bcryptjs";
import { config } from "../config.js";
import { query } from "../database.js";
import { ApiError } from "../errors.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";
const router = Router();
router.use(requireAuth, requireRoles("ADMIN"));
router.get("/users", async (_req, res, next) => {
  try {
    const r = await query(
      `SELECT "Id" AS id,"InstitutionalId" AS "institutionalId","FullName" AS "fullName","Email" AS email,"Role" AS role,"DepartmentOrTrade" AS "departmentOrTrade","Phone" AS phone,"IsActive" AS "isActive","LastLoginAt" AS "lastLoginAt","CreatedAt" AS "createdAt" FROM "dbo"."Users" ORDER BY "CreatedAt" DESC`,
    );
    res.json({ items: r.rows });
  } catch (e) {
    next(e);
  }
});
router.post("/users", async (req, res, next) => {
  try {
    const role = String(req.body?.role || "").toUpperCase();
    if (
      ![
        "REPORTER",
        "PPO_STAFF",
        "PPO_HEAD",
        "PROCUREMENT",
        "STAFF",
        "ADMIN",
      ].includes(role)
    )
      throw new ApiError(400, "role is invalid.", "INVALID_ROLE");
    const password = String(req.body?.password || "");
    if (password.length < 8)
      throw new ApiError(
        400,
        "Password must contain at least 8 characters.",
        "VALIDATION_ERROR",
      );
    const hash = await bcrypt.hash(password, config.bcryptRounds);
    const r = await query(
      `INSERT INTO "dbo"."Users" ("InstitutionalId","FullName","Email","PasswordHash","Role","DepartmentOrTrade","Phone") VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING "Id" AS id,"FullName" AS "fullName","Email" AS email,"Role" AS role`,
      [
        req.body?.institutionalId || null,
        req.body?.fullName,
        String(req.body?.email || "").toLowerCase(),
        hash,
        role,
        req.body?.departmentOrTrade || null,
        req.body?.phone || null,
      ],
    );
    res.status(201).json({ user: r.rows[0] });
  } catch (e) {
    next(e);
  }
});
export default router;
