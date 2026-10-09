import { Router } from "express";
import { query } from "../database.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

router.get("/buildings", async (_req, res, next) => {
  try {
    const result = await query(
      `SELECT
         "Id" AS id,
         "Code" AS code,
         "Name" AS name,
         "IsActive" AS "isActive",
         "Description" AS description,
         "CreatedAt" AS "createdAt",
         "UpdatedAt" AS "updatedAt"
       FROM "dbo"."Buildings"
       WHERE "IsActive"=TRUE
       ORDER BY "Name"`,
    );

    res.json({ items: result.rows });
  } catch (error) {
    next(error);
  }
});

router.get("/locations", async (req, res, next) => {
  try {
    const buildingId = req.query.buildingId
      ? String(req.query.buildingId)
      : null;

    const result = await query(
      `SELECT
         fl."Id" AS id,
         fl."BuildingId" AS "buildingId",
         b."Code" AS "buildingCode",
         b."Name" AS "buildingName",
         fl."Floor" AS floor,
         fl."RoomOrArea" AS "roomOrArea",
         fl."LocationType" AS "locationType",
         fl."Code" AS code,
         fl."Notes" AS notes
       FROM "dbo"."FacilityLocations" fl
       JOIN "dbo"."Buildings" b ON b."Id"=fl."BuildingId"
       WHERE fl."IsActive"=TRUE
         AND b."IsActive"=TRUE
         AND ($1::uuid IS NULL OR fl."BuildingId"=$1)
       ORDER BY b."Name",fl."Floor" NULLS FIRST,fl."RoomOrArea"`,
      [buildingId],
    );

    res.json({ items: result.rows });
  } catch (error) {
    next(error);
  }
});

// Active categories for Maintenance Review overrides (review validates finalCategory by Name).
router.get("/categories", async (_req, res, next) => {
  try {
    const result = await query(
      `SELECT "Code" AS code,"Name" AS name,"DefaultUrgency" AS "defaultUrgency"
       FROM "dbo"."DamageCategories"
       WHERE "IsActive"=TRUE
       ORDER BY "SortOrder","Name"`,
    );
    res.json({ items: result.rows });
  } catch (error) {
    next(error);
  }
});

export default router;
