import { Router } from "express";
import { query, withTransaction } from "../database.js";
import { ApiError } from "../errors.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";
import { cachedGet } from "../cache/response-cache.js";
import { effectiveLocation, validatePerimeter } from "../services/geo.js";

/** Admin building settings (seefix-api#20): GET/POST/PATCH /api/admin/buildings. */
export const adminBuildings = Router();
adminBuildings.use(requireAuth, requireRoles("ADMIN"));

const BUILDING_COLUMNS = `
  b."Id" AS id, b."Code" AS code, b."Name" AS name, b."Description" AS description, b."IsActive" AS "isActive",
  b."SortOrder" AS "sortOrder", b."DefaultLat" AS "defaultLat", b."DefaultLng" AS "defaultLng", b."Perimeter" AS perimeter,
  b."ToleranceMeters" AS "toleranceMeters", b."GeometryRevision" AS "geometryRevision",
  b."GeometryUpdatedAt" AS "geometryUpdatedAt", b."UpdatedAt" AS "updatedAt"`;

function present(row) {
  return {
    ...row,
    defaultLat: row.defaultLat === null ? null : Number(row.defaultLat),
    defaultLng: row.defaultLng === null ? null : Number(row.defaultLng),
  };
}

function text(value, label, max, { required = false } = {}) {
  if (value === undefined) return undefined;
  const v = value === null ? "" : String(value).trim();
  if (required && !v) throw new ApiError(400, `${label} is required.`, "VALIDATION_ERROR");
  if (v.length > max) throw new ApiError(400, `${label} must be at most ${max} characters.`, "VALIDATION_ERROR");
  return v || null;
}

/** Validated geometry fields present in the body (undefined = not supplied). */
function geometry(body) {
  const out = {};
  const hasLat = Object.prototype.hasOwnProperty.call(body, "defaultLat");
  const hasLng = Object.prototype.hasOwnProperty.call(body, "defaultLng");
  if (hasLat !== hasLng) throw new ApiError(400, "defaultLat and defaultLng go together.", "INVALID_GEOMETRY");
  if (hasLat) {
    const { defaultLat: lat, defaultLng: lng } = body;
    if ((lat === null) !== (lng === null)) throw new ApiError(400, "defaultLat and defaultLng go together.", "INVALID_GEOMETRY");
    if (lat !== null && (typeof lat !== "number" || typeof lng !== "number" || Math.abs(lat) > 90 || Math.abs(lng) > 180)) {
      throw new ApiError(400, "Default pin must be valid latitude/longitude numbers.", "INVALID_GEOMETRY");
    }
    out.defaultLat = lat;
    out.defaultLng = lng;
  }
  if (Object.prototype.hasOwnProperty.call(body, "perimeter")) out.perimeter = validatePerimeter(body.perimeter);
  if (Object.prototype.hasOwnProperty.call(body, "toleranceMeters")) {
    const t = body.toleranceMeters;
    if (!Number.isInteger(t) || t < 0 || t > 1000) throw new ApiError(400, "toleranceMeters must be an integer from 0 to 1000.", "INVALID_GEOMETRY");
    out.toleranceMeters = t;
  }
  return out;
}

adminBuildings.get("/", cachedGet({ domains: ["reference"] }), async (_req, res, next) => {
  try {
    const r = await query(`SELECT ${BUILDING_COLUMNS} FROM "dbo"."Buildings" b ORDER BY b."SortOrder", b."Name", b."Id"`);
    res.json({ items: r.rows.map(present) });
  } catch (error) {
    next(error);
  }
});

async function recordGeometry(client, row, userId, reason) {
  await client.query(
    `INSERT INTO "dbo"."BuildingGeometryHistory"
       ("BuildingId","Revision","DefaultLat","DefaultLng","Perimeter","ToleranceMeters","Reason","ChangedBy")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [row.Id, row.GeometryRevision, row.DefaultLat, row.DefaultLng, row.Perimeter === null ? null : JSON.stringify(row.Perimeter), row.ToleranceMeters, reason, userId],
  );
}

adminBuildings.post("/", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const code = text(body.code, "Code", 60, { required: true });
    const name = text(body.name, "Name", 200, { required: true });
    const description = text(body.description, "Description", 2000) ?? null;
    const sortOrder = body.sortOrder === undefined ? 0 : body.sortOrder;
    if (!Number.isInteger(sortOrder)) throw new ApiError(400, "sortOrder must be an integer.", "VALIDATION_ERROR");
    const g = geometry(body);
    const row = await withTransaction(req.user.id, async (client) => {
      const r = await client.query(
        `INSERT INTO "dbo"."Buildings" ("Code","Name","Description","SortOrder","DefaultLat","DefaultLng","Perimeter","ToleranceMeters",
                                       "GeometryRevision","GeometryUpdatedAt","GeometryUpdatedBy")
         VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,25),1,now(),$9) RETURNING *`,
        [code, name, description, sortOrder, g.defaultLat ?? null, g.defaultLng ?? null,
          g.perimeter ? JSON.stringify(g.perimeter) : null, g.toleranceMeters ?? null, req.user.id],
      );
      await recordGeometry(client, r.rows[0], req.user.id, text(body.reason, "Reason", 500) ?? "Created");
      return r.rows[0];
    });
    const out = await query(`SELECT ${BUILDING_COLUMNS} FROM "dbo"."Buildings" b WHERE b."Id"=$1`, [row.Id]);
    res.status(201).json({ building: present(out.rows[0]) });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/admin/buildings/:id. Geometry edits (defaultLat/defaultLng, perimeter, toleranceMeters) bump
 * GeometryRevision and add a history row; send `geometryRevision` to reject the edit (409) if someone else changed
 * the geometry since you loaded it. Renaming never touches reports (they keep their own building text and GPS).
 */
adminBuildings.patch("/:id", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const name = text(body.name, "Name", 200, { required: body.name !== undefined });
    const description = text(body.description, "Description", 2000);
    if (body.isActive !== undefined && typeof body.isActive !== "boolean") throw new ApiError(400, "isActive must be boolean.", "VALIDATION_ERROR");
    if (body.sortOrder !== undefined && !Number.isInteger(body.sortOrder)) throw new ApiError(400, "sortOrder must be an integer.", "VALIDATION_ERROR");
    const g = geometry(body);
    const geometryChanged = Object.keys(g).length > 0;

    await withTransaction(req.user.id, async (client) => {
      const current = (await client.query(`SELECT * FROM "dbo"."Buildings" WHERE "Id"=$1 FOR UPDATE`, [req.params.id])).rows[0];
      if (!current) throw new ApiError(404, "Building not found.", "BUILDING_NOT_FOUND");
      if (geometryChanged && body.geometryRevision !== undefined && body.geometryRevision !== current.GeometryRevision) {
        throw new ApiError(409, "The building's location was changed by someone else. Reload and try again.", "GEOMETRY_CONFLICT");
      }
      const sets = [];
      const params = [req.params.id];
      const set = (column, value) => {
        params.push(value);
        sets.push(`"${column}"=$${params.length}`);
      };
      if (name !== undefined) set("Name", name);
      if (description !== undefined) set("Description", description);
      if (body.isActive !== undefined) set("IsActive", body.isActive);
      if (body.sortOrder !== undefined) set("SortOrder", body.sortOrder);
      if ("defaultLat" in g) {
        set("DefaultLat", g.defaultLat);
        set("DefaultLng", g.defaultLng);
      }
      if ("perimeter" in g) set("Perimeter", g.perimeter ? JSON.stringify(g.perimeter) : null);
      if ("toleranceMeters" in g) set("ToleranceMeters", g.toleranceMeters);
      if (geometryChanged) {
        sets.push(`"GeometryRevision"="GeometryRevision"+1`, `"GeometryUpdatedAt"=now()`);
        set("GeometryUpdatedBy", req.user.id);
      }
      if (!sets.length) throw new ApiError(400, "No building fields were supplied.", "VALIDATION_ERROR");
      const updated = (await client.query(`UPDATE "dbo"."Buildings" SET ${sets.join(",")} WHERE "Id"=$1 RETURNING *`, params)).rows[0];
      if (geometryChanged) await recordGeometry(client, updated, req.user.id, text(body.reason, "Reason", 500) ?? null);
    });
    const out = await query(`SELECT ${BUILDING_COLUMNS} FROM "dbo"."Buildings" b WHERE b."Id"=$1`, [req.params.id]);
    res.json({ building: present(out.rows[0]) });
  } catch (error) {
    next(error);
  }
});

adminBuildings.get("/:id/geometry-history", async (req, res, next) => {
  try {
    const r = await query(
      `SELECT h."Revision" AS revision, h."DefaultLat" AS "defaultLat", h."DefaultLng" AS "defaultLng", h."Perimeter" AS perimeter,
              h."ToleranceMeters" AS "toleranceMeters", h."Reason" AS reason, h."ChangedAt" AS "changedAt", u."FullName" AS "changedBy"
         FROM "dbo"."BuildingGeometryHistory" h LEFT JOIN "dbo"."Users" u ON u."Id"=h."ChangedBy"
        WHERE h."BuildingId"=$1 ORDER BY h."Revision" DESC`,
      [req.params.id],
    );
    res.json({ items: r.rows.map(present) });
  } catch (error) {
    next(error);
  }
});

/** Campus map (seefix-api#20): GET /api/map. */
export const mapRoutes = Router();
const MAP_ROLES = ["ADMIN", "MAINTENANCE_SUPERVISOR", "MAINTENANCE_STAFF", "WORKER"];
const ACTIVE_REPORT = `r."Status" NOT IN ('RESOLVED','NO_ACTION','DUPLICATE','CANCELLED')`;
const ACTIVE_WO = `wo."Status" NOT IN ('COMPLETED','CANCELLED')`;

/**
 * Active reports and work orders with a derived display location (see services/geo.js effectiveLocation), plus each
 * building's geometry and counts. WORKER: only work orders they lead (and no report markers of their own).
 * Raw GPS is returned unchanged as location.rawGps; the building link is never rewritten.
 */
mapRoutes.get(
  "/",
  requireAuth,
  requireRoles(...MAP_ROLES),
  cachedGet({ domains: ["reports", "work_orders", "reference"], scope: "user" }),
  async (req, res, next) => {
    try {
      const worker = req.user.role === "WORKER";
      // Building link: the configured location's building, else an exact (case-insensitive) name/code match.
      const buildingOf = `COALESCE(fl."BuildingId",
          (SELECT b."Id" FROM "dbo"."Buildings" b WHERE lower(b."Name")=lower(r."Building") OR lower(b."Code")=lower(r."Building") LIMIT 1))`;
      const [buildings, reports, workOrders] = await Promise.all([
        query(`SELECT ${BUILDING_COLUMNS} FROM "dbo"."Buildings" b WHERE b."IsActive" ORDER BY b."SortOrder", b."Name"`),
        worker
          ? { rows: [] }
          : query(`
              SELECT r."Id" AS id, r."ReportNo" AS no, r."Status" AS status, p."EffectiveCategory" AS category,
                     p."EffectiveUrgency" AS urgency, r."GpsLat" AS "gpsLat", r."GpsLng" AS "gpsLng",
                     r."Building" AS "buildingText", ${buildingOf} AS "buildingId",
                     CASE WHEN fl."BuildingId" IS NOT NULL THEN 'LOCATION' WHEN r."Building" IS NOT NULL THEN 'NAME' ELSE 'NONE' END AS "buildingMatch"
                FROM "dbo"."Reports" r
                LEFT JOIN "dbo"."FacilityLocations" fl ON fl."Id"=r."LocationId"
                LEFT JOIN "dbo"."v_ReportPriorityLive" p ON p."Id"=r."Id"
               WHERE ${ACTIVE_REPORT}`),
        query(`
          SELECT wo."Id" AS id, wo."WorkOrderNo" AS no, wo."Status" AS status, p."EffectiveCategory" AS category,
                 p."EffectiveUrgency" AS urgency, r."GpsLat" AS "gpsLat", r."GpsLng" AS "gpsLng",
                 r."Building" AS "buildingText", ${buildingOf} AS "buildingId",
                 CASE WHEN fl."BuildingId" IS NOT NULL THEN 'LOCATION' WHEN r."Building" IS NOT NULL THEN 'NAME' ELSE 'NONE' END AS "buildingMatch"
            FROM "dbo"."WorkOrders" wo
            JOIN "dbo"."Reports" r ON r."Id"=wo."ReportId"
            LEFT JOIN "dbo"."FacilityLocations" fl ON fl."Id"=r."LocationId"
            LEFT JOIN "dbo"."v_ReportPriorityLive" p ON p."Id"=r."Id"
           WHERE ${ACTIVE_WO} ${worker ? `AND wo."ResponsibleLeadUserId"=$1` : ""}`, worker ? [req.user.id] : []),
      ]);
      const byId = new Map(buildings.rows.map((b) => [String(b.id), present(b)]));
      const counts = new Map();
      const marker = (kind, route) => (row) => {
        const building = row.buildingId ? byId.get(String(row.buildingId)) ?? null : null;
        if (building) {
          const c = counts.get(building.id) ?? { reports: 0, workOrders: 0 };
          c[kind === "REPORT" ? "reports" : "workOrders"] += 1;
          counts.set(building.id, c);
        }
        return {
          kind, id: row.id, no: row.no, status: row.status, category: row.category, urgency: row.urgency,
          buildingId: building?.id ?? null, buildingName: building?.name ?? row.buildingText ?? null, buildingMatch: row.buildingMatch,
          location: effectiveLocation(row, building),
          route: `${route}${row.id}`,
        };
      };
      const markers = [...reports.rows.map(marker("REPORT", "/reports/")), ...workOrders.rows.map(marker("WORK_ORDER", "/work-orders/"))];
      res.json({
        buildings: [...byId.values()].map((b) => ({ ...b, counts: counts.get(b.id) ?? { reports: 0, workOrders: 0 } })),
        markers,
      });
    } catch (error) {
      next(error);
    }
  },
);
