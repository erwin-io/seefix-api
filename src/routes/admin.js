import { Router } from "express";
import bcrypt from "bcryptjs";
import { config } from "../config.js";
import { query } from "../database.js";
import { ApiError } from "../errors.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";
import { optionalUsername, requireEmail, requirePassword, publicUser } from '../services/account-validation.js';
import { issueChallenge, deliverChallenge } from '../services/account-challenges.js';
import { withTransaction } from '../database.js';

const router = Router();
router.use(requireAuth, requireRoles("ADMIN"));

const VALID_ROLES = new Set([
  "REPORTER",
  "MAINTENANCE_STAFF",
  "MAINTENANCE_SUPERVISOR",
  "PROCUREMENT",
  "WORKER",
  "ADMIN",
]);

router.get("/users", async (_req, res, next) => {
  try {
    const result = await query(
      `SELECT
         "Id" AS id,
         "InstitutionalId" AS "institutionalId",
         "FullName" AS "fullName",
         "Username" AS username,
         "Email" AS email,
         "Role" AS role,
         "JobTitle" AS "jobTitle",
         "DepartmentOrTrade" AS "departmentOrTrade",
         "Phone" AS phone,
         "IsActive" AS "isActive",
         "EmailVerifiedAt" AS "emailVerifiedAt",
         "EmailVerificationRequired" AS "emailVerificationRequired",
         "LastLoginAt" AS "lastLoginAt",
         "CreatedAt" AS "createdAt",
         "UpdatedAt" AS "updatedAt"
       FROM "dbo"."Users"
       ORDER BY "CreatedAt" DESC`,
    );

    res.json({ items: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post('/users', async (req, res, next) => {
  try {
    const fullName = String(req.body?.fullName || '').trim();
    const email = requireEmail(req.body?.email);
    const role = String(req.body?.role || '').trim().toUpperCase();
    const username = optionalUsername(req.body?.username) ?? null;
    const password = requirePassword(req.body?.password);
    if (fullName.length < 2 || fullName.length > 200) throw new ApiError(400, 'Full name is required (max 200).', 'VALIDATION_ERROR');
    if (!VALID_ROLES.has(role)) throw new ApiError(400, 'role is invalid.', 'INVALID_ROLE');
    const hash = await bcrypt.hash(password, config.bcryptRounds);
    const result = await withTransaction(req.user.id, async client => {
      const r = await client.query(
        `INSERT INTO "dbo"."Users"
         ("InstitutionalId","FullName","Email","Username","PasswordHash","Role",
          "JobTitle","DepartmentOrTrade","Phone","EmailVerificationRequired")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [req.body?.institutionalId || null, fullName, email, username, hash, role,
         req.body?.jobTitle || null, req.body?.departmentOrTrade || null,
         req.body?.phone || null, role === 'REPORTER'],
      );
      const user = r.rows[0];
      const challenge = role === 'REPORTER'
        ? await issueChallenge(client, { userId: user.Id, purpose: 'EMAIL_VERIFY', email })
        : null;
      return { user, challenge };
    });
    if (result.challenge) await deliverChallenge(result.challenge);
    res.status(201).json({ user: publicUser(result.user), emailVerificationRequired: role === 'REPORTER' });
  } catch (err) { next(err); }
});

export default router;
