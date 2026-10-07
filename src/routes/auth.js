import { Router } from "express";
import bcrypt from "bcryptjs";
import { config } from "../config.js";
import { query, withTransaction } from "../database.js";
import { ApiError } from "../errors.js";
import { requireAuth, signAccessToken } from "../middleware/auth.js";

const router = Router();
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post("/register", async (req, res, next) => {
  try {
    const fullName = String(req.body?.fullName || "").trim();
    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase();
    const password = String(req.body?.password || "");
    if (fullName.length < 2)
      throw new ApiError(400, "Full name is required.", "VALIDATION_ERROR");
    if (!emailPattern.test(email))
      throw new ApiError(400, "A valid email is required.", "VALIDATION_ERROR");
    if (password.length < 8)
      throw new ApiError(
        400,
        "Password must contain at least 8 characters.",
        "VALIDATION_ERROR",
      );
    const hash = await bcrypt.hash(password, config.bcryptRounds);
    const result = await query(
      `INSERT INTO "dbo"."Users" ("InstitutionalId","FullName","Email","PasswordHash","Role","Phone") VALUES ($1,$2,$3,$4,'REPORTER',$5) RETURNING "Id" AS id,"FullName" AS "fullName","Email" AS email,"Role" AS role,"Phone" AS phone,"CreatedAt" AS "createdAt"`,
      [
        req.body?.institutionalId || null,
        fullName,
        email,
        hash,
        req.body?.phone || null,
      ],
    );
    const user = result.rows[0];
    res.status(201).json({ user, accessToken: signAccessToken(user) });
  } catch (e) {
    next(e);
  }
});

router.post("/login", async (req, res, next) => {
  try {
    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase();
    const password = String(req.body?.password || "");
    const result = await query(
      `SELECT "Id" AS id,"FullName" AS "fullName","Email" AS email,"PasswordHash" AS "passwordHash","Role" AS role,"DepartmentOrTrade" AS "departmentOrTrade","Phone" AS phone,"IsActive" AS "isActive" FROM "dbo"."Users" WHERE LOWER("Email")=LOWER($1)`,
      [email],
    );
    const user = result.rows[0];
    if (
      !user?.isActive ||
      !(await bcrypt.compare(password, user.passwordHash || ""))
    )
      throw new ApiError(
        401,
        "Invalid email or password.",
        "INVALID_CREDENTIALS",
      );
    await withTransaction(user.id, (client) =>
      client.query(
        `UPDATE "dbo"."Users" SET "LastLoginAt"=NOW(),"UpdatedAt"=NOW() WHERE "Id"=$1`,
        [user.id],
      ),
    );
    delete user.passwordHash;
    res.json({ user, accessToken: signAccessToken(user) });
  } catch (e) {
    next(e);
  }
});

router.get("/me", requireAuth, (req, res) => res.json({ user: req.user }));
export default router;
