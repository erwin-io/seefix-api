import { Router } from "express";
import { withTransaction, query } from "../database.js";
import { ApiError } from "../errors.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth, requireRoles("ADMIN"));

const URGENCIES = new Set(["Low", "Medium", "High", "Critical"]);

function cleanText(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

function cleanNumber(value, { min = null, integer = false } = {}) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new ApiError(400, "A numeric value is invalid.", "VALIDATION_ERROR");
  if (integer && !Number.isInteger(number)) throw new ApiError(400, "An integer value is required.", "VALIDATION_ERROR");
  if (min !== null && number < min) throw new ApiError(400, `Numeric values must be >= ${min}.`, "VALIDATION_ERROR");
  return number;
}

async function requireCategory(client, code) {
  const result = await client.query(
    `SELECT "Id", "Code", "Name"
       FROM "dbo"."DamageCategories"
      WHERE "Code" = $1`,
    [String(code || "").trim().toUpperCase()]
  );
  if (!result.rows[0]) throw new ApiError(404, "Damage category was not found.", "CATEGORY_NOT_FOUND");
  return result.rows[0];
}

async function audit(client, userId, action, entityType, entityId, newData) {
  await client.query(
    `INSERT INTO "dbo"."AuditLogs"
       ("ActorUserId","ActorType","Action","EntityType","EntityId","NewData")
     VALUES ($1,'USER',$2,$3,$4,$5::jsonb)`,
    [userId, action, entityType, entityId, JSON.stringify(newData ?? {})]
  );
}

router.get("/categories", async (_req, res, next) => {
  try {
    const result = await query(
      `SELECT
         "Id" AS id,
         "Code" AS code,
         "Name" AS name,
         "Description" AS description,
         "DefaultUrgency" AS "defaultUrgency",
         "UrgencyGuidance" AS "urgencyGuidance",
         "DefaultMinHours" AS "defaultMinHours",
         "DefaultMaxHours" AS "defaultMaxHours",
         "DefaultRequiredService" AS "defaultRequiredService",
         "DefaultRequiredCapability" AS "defaultRequiredCapability",
         "SafetyGuidance" AS "safetyGuidance",
         "PreferredTrade" AS "preferredTrade",
         "RequiresMaintenanceReview" AS "requiresMaintenanceReview",
         "IsActive" AS "isActive",
         "SortOrder" AS "sortOrder",
         "UpdatedAt" AS "updatedAt"
       FROM "dbo"."DamageCategories"
       ORDER BY "SortOrder", "Name"`
    );
    res.json({ items: result.rows });
  } catch (error) { next(error); }
});

router.patch("/categories/:code", async (req, res, next) => {
  try {
    const result = await withTransaction(req.user.id, async (client) => {
      const category = await requireCategory(client, req.params.code);

      const allowed = {
        description: ["Description", cleanText(req.body?.description)],
        defaultUrgency: ["DefaultUrgency", cleanText(req.body?.defaultUrgency)],
        urgencyGuidance: ["UrgencyGuidance", cleanText(req.body?.urgencyGuidance)],
        defaultMinHours: ["DefaultMinHours", cleanNumber(req.body?.defaultMinHours, { min: 0.01 })],
        defaultMaxHours: ["DefaultMaxHours", cleanNumber(req.body?.defaultMaxHours, { min: 0.01 })],
        defaultRequiredService: ["DefaultRequiredService", cleanText(req.body?.defaultRequiredService)],
        defaultRequiredCapability: ["DefaultRequiredCapability", cleanText(req.body?.defaultRequiredCapability)],
        safetyGuidance: ["SafetyGuidance", cleanText(req.body?.safetyGuidance)],
        preferredTrade: ["PreferredTrade", cleanText(req.body?.preferredTrade)],
        requiresMaintenanceReview: ["RequiresMaintenanceReview", req.body?.requiresMaintenanceReview],
        isActive: ["IsActive", req.body?.isActive],
        sortOrder: ["SortOrder", cleanNumber(req.body?.sortOrder, { min: 0, integer: true })],
      };

      if (allowed.defaultUrgency[1] !== undefined && allowed.defaultUrgency[1] !== null && !URGENCIES.has(allowed.defaultUrgency[1])) {
        throw new ApiError(400, "defaultUrgency must be Low, Medium, High, Critical, or null.", "VALIDATION_ERROR");
      }
      if (allowed.requiresMaintenanceReview[1] !== undefined && typeof allowed.requiresMaintenanceReview[1] !== "boolean") {
        throw new ApiError(400, "requiresMaintenanceReview must be boolean.", "VALIDATION_ERROR");
      }
      if (allowed.isActive[1] !== undefined && typeof allowed.isActive[1] !== "boolean") {
        throw new ApiError(400, "isActive must be boolean.", "VALIDATION_ERROR");
      }

      const updates = [];
      const params = [];
      for (const [bodyKey, [column, value]] of Object.entries(allowed)) {
        if (!Object.prototype.hasOwnProperty.call(req.body || {}, bodyKey)) continue;
        params.push(value);
        updates.push(`"${column}" = $${params.length}`);
      }
      if (!updates.length) throw new ApiError(400, "No supported category fields were supplied.", "VALIDATION_ERROR");

      params.push(category.Id);
      const updated = await client.query(
        `UPDATE "dbo"."DamageCategories"
            SET ${updates.join(", ")}
          WHERE "Id" = $${params.length}
        RETURNING *`,
        params
      );

      await audit(client, req.user.id, "KNOWLEDGE_CATEGORY_UPDATED", "DAMAGE_CATEGORY", category.Id, updated.rows[0]);
      return updated.rows[0];
    });
    res.json({ category: result });
  } catch (error) { next(error); }
});

router.get("/skills", async (_req, res, next) => {
  try {
    const result = await query(
      `SELECT
         "Id" AS id,
         "Code" AS code,
         "Name" AS name,
         "Description" AS description,
         "IsActive" AS "isActive",
         "CreatedAt" AS "createdAt",
         "UpdatedAt" AS "updatedAt"
       FROM "dbo"."Skills"
       ORDER BY "Name"`
    );
    res.json({ items: result.rows });
  } catch (error) { next(error); }
});

router.get("/categories/:code/skills", async (req, res, next) => {
  try {
    const result = await query(
      `SELECT
         dc."Code" AS "categoryCode",
         dc."Name" AS "categoryName",
         s."Id" AS "skillId",
         s."Code" AS "code",
         s."Name" AS "name",
         s."Description" AS "description",
         s."IsActive" AS "isActive",
         csr."MinimumProficiencyLevel" AS "minimumProficiencyLevel",
         csr."IsRequired" AS "isRequired",
         csr."IsLeadSkill" AS "isLeadSkill",
         csr."Notes" AS "notes"
       FROM "dbo"."DamageCategories" dc
       JOIN "dbo"."CategorySkillRequirements" csr ON csr."CategoryId" = dc."Id"
       JOIN "dbo"."Skills" s ON s."Id" = csr."SkillId"
       WHERE dc."Code" = $1
       ORDER BY csr."IsLeadSkill" DESC, s."Name"`,
      [String(req.params.code || "").trim().toUpperCase()]
    );
    res.json({ items: result.rows });
  } catch (error) { next(error); }
});

router.put("/categories/:code/skills", async (req, res, next) => {
  try {
    const items = req.body?.skills;
    if (!Array.isArray(items)) throw new ApiError(400, "skills must be an array.", "VALIDATION_ERROR");

    const result = await withTransaction(req.user.id, async (client) => {
      const category = await requireCategory(client, req.params.code);
      const seenCodes = new Set();
      const prepared = [];

      for (const raw of items) {
        const code = String(raw?.code || "").trim().toUpperCase();
        const name = cleanText(raw?.name);
        if (!code || !name) throw new ApiError(400, "Each skill requires code and name.", "VALIDATION_ERROR");
        if (seenCodes.has(code)) throw new ApiError(400, `Duplicate skill code in request: ${code}`, "VALIDATION_ERROR");
        seenCodes.add(code);

        const level = cleanNumber(raw?.minimumProficiencyLevel, { min: 1, integer: true });
        if (level !== undefined && level !== null && level > 5) throw new ApiError(400, "minimumProficiencyLevel must be between 1 and 5.", "VALIDATION_ERROR");

        const isRequired = raw?.isRequired ?? true;
        const isLeadSkill = raw?.isLeadSkill ?? false;
        if (typeof isRequired !== "boolean" || typeof isLeadSkill !== "boolean") {
          throw new ApiError(400, "isRequired and isLeadSkill must be boolean.", "VALIDATION_ERROR");
        }

        const skillResult = await client.query(
          `INSERT INTO "dbo"."Skills" ("Code","Name","Description","IsActive")
           VALUES ($1,$2,$3,TRUE)
           ON CONFLICT ("Code") DO UPDATE SET
             "Name" = EXCLUDED."Name",
             "Description" = EXCLUDED."Description",
             "IsActive" = TRUE
           RETURNING "Id","Code","Name","Description","IsActive"`,
          [code, name, cleanText(raw?.description)]
        );

        prepared.push({
          skill: skillResult.rows[0],
          minimumProficiencyLevel: level ?? null,
          isRequired,
          isLeadSkill,
          notes: cleanText(raw?.notes),
        });
      }

      await client.query(`DELETE FROM "dbo"."CategorySkillRequirements" WHERE "CategoryId" = $1`, [category.Id]);

      for (const item of prepared) {
        await client.query(
          `INSERT INTO "dbo"."CategorySkillRequirements"
             ("CategoryId","SkillId","MinimumProficiencyLevel","IsRequired","IsLeadSkill","Notes")
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [category.Id, item.skill.Id, item.minimumProficiencyLevel, item.isRequired, item.isLeadSkill, item.notes]
        );
      }

      const rows = await client.query(
        `SELECT
           s."Id" AS "skillId",
           s."Code" AS code,
           s."Name" AS name,
           s."Description" AS description,
           csr."MinimumProficiencyLevel" AS "minimumProficiencyLevel",
           csr."IsRequired" AS "isRequired",
           csr."IsLeadSkill" AS "isLeadSkill",
           csr."Notes" AS notes
         FROM "dbo"."CategorySkillRequirements" csr
         JOIN "dbo"."Skills" s ON s."Id" = csr."SkillId"
         WHERE csr."CategoryId" = $1
         ORDER BY csr."IsLeadSkill" DESC, s."Name"`,
        [category.Id]
      );

      await audit(client, req.user.id, "KNOWLEDGE_CATEGORY_SKILLS_REPLACED", "DAMAGE_CATEGORY", category.Id, {
        categoryCode: category.Code,
        skills: rows.rows,
      });
      return { category: { id: category.Id, code: category.Code, name: category.Name }, items: rows.rows };
    });

    res.json(result);
  } catch (error) { next(error); }
});

router.get("/materials", async (_req, res, next) => {
  try {
    const result = await query(
      `SELECT
         "Id" AS id,
         "Code" AS code,
         "Name" AS name,
         "Unit" AS unit,
         "Description" AS description,
         "IsActive" AS "isActive",
         "CreatedAt" AS "createdAt",
         "UpdatedAt" AS "updatedAt"
       FROM "dbo"."Materials"
       ORDER BY "Name"`
    );
    res.json({ items: result.rows });
  } catch (error) { next(error); }
});

router.get("/categories/:code/materials", async (req, res, next) => {
  try {
    const result = await query(
      `SELECT
         dc."Code" AS "categoryCode",
         dc."Name" AS "categoryName",
         m."Id" AS "materialId",
         m."Code" AS code,
         m."Name" AS name,
         m."Unit" AS unit,
         m."Description" AS description,
         m."IsActive" AS "isActive",
         cmr."DefaultQtyMin" AS "defaultQtyMin",
         cmr."DefaultQtyMax" AS "defaultQtyMax",
         cmr."IsCommon" AS "isCommon",
         cmr."Notes" AS notes
       FROM "dbo"."DamageCategories" dc
       JOIN "dbo"."CategoryMaterialReferences" cmr ON cmr."CategoryId" = dc."Id"
       JOIN "dbo"."Materials" m ON m."Id" = cmr."MaterialId"
       WHERE dc."Code" = $1
       ORDER BY cmr."IsCommon" DESC, m."Name"`,
      [String(req.params.code || "").trim().toUpperCase()]
    );
    res.json({ items: result.rows });
  } catch (error) { next(error); }
});

router.put("/categories/:code/materials", async (req, res, next) => {
  try {
    const items = req.body?.materials;
    if (!Array.isArray(items)) throw new ApiError(400, "materials must be an array.", "VALIDATION_ERROR");

    const result = await withTransaction(req.user.id, async (client) => {
      const category = await requireCategory(client, req.params.code);
      const seenCodes = new Set();
      const prepared = [];

      for (const raw of items) {
        const code = String(raw?.code || "").trim().toUpperCase();
        const name = cleanText(raw?.name);
        if (!code || !name) throw new ApiError(400, "Each material requires code and name.", "VALIDATION_ERROR");
        if (seenCodes.has(code)) throw new ApiError(400, `Duplicate material code in request: ${code}`, "VALIDATION_ERROR");
        seenCodes.add(code);

        const qtyMin = cleanNumber(raw?.defaultQtyMin, { min: 0 });
        const qtyMax = cleanNumber(raw?.defaultQtyMax, { min: 0 });
        if (qtyMin !== undefined && qtyMin !== null && qtyMax !== undefined && qtyMax !== null && qtyMax < qtyMin) {
          throw new ApiError(400, "defaultQtyMax cannot be lower than defaultQtyMin.", "VALIDATION_ERROR");
        }
        const isCommon = raw?.isCommon ?? true;
        if (typeof isCommon !== "boolean") throw new ApiError(400, "isCommon must be boolean.", "VALIDATION_ERROR");

        const materialResult = await client.query(
          `INSERT INTO "dbo"."Materials" ("Code","Name","Unit","Description","IsActive")
           VALUES ($1,$2,$3,$4,TRUE)
           ON CONFLICT ("Code") DO UPDATE SET
             "Name" = EXCLUDED."Name",
             "Unit" = EXCLUDED."Unit",
             "Description" = EXCLUDED."Description",
             "IsActive" = TRUE
           RETURNING "Id","Code","Name","Unit","Description","IsActive"`,
          [code, name, cleanText(raw?.unit), cleanText(raw?.description)]
        );

        prepared.push({
          material: materialResult.rows[0],
          defaultQtyMin: qtyMin ?? null,
          defaultQtyMax: qtyMax ?? null,
          isCommon,
          notes: cleanText(raw?.notes),
        });
      }

      await client.query(`DELETE FROM "dbo"."CategoryMaterialReferences" WHERE "CategoryId" = $1`, [category.Id]);

      for (const item of prepared) {
        await client.query(
          `INSERT INTO "dbo"."CategoryMaterialReferences"
             ("CategoryId","MaterialId","DefaultQtyMin","DefaultQtyMax","IsCommon","Notes")
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [category.Id, item.material.Id, item.defaultQtyMin, item.defaultQtyMax, item.isCommon, item.notes]
        );
      }

      const rows = await client.query(
        `SELECT
           m."Id" AS "materialId",
           m."Code" AS code,
           m."Name" AS name,
           m."Unit" AS unit,
           m."Description" AS description,
           cmr."DefaultQtyMin" AS "defaultQtyMin",
           cmr."DefaultQtyMax" AS "defaultQtyMax",
           cmr."IsCommon" AS "isCommon",
           cmr."Notes" AS notes
         FROM "dbo"."CategoryMaterialReferences" cmr
         JOIN "dbo"."Materials" m ON m."Id" = cmr."MaterialId"
         WHERE cmr."CategoryId" = $1
         ORDER BY cmr."IsCommon" DESC, m."Name"`,
        [category.Id]
      );

      await audit(client, req.user.id, "KNOWLEDGE_CATEGORY_MATERIALS_REPLACED", "DAMAGE_CATEGORY", category.Id, {
        categoryCode: category.Code,
        materials: rows.rows,
      });
      return { category: { id: category.Id, code: category.Code, name: category.Name }, items: rows.rows };
    });

    res.json(result);
  } catch (error) { next(error); }
});

export default router;