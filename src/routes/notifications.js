import { Router } from "express";
import { withTransaction } from "../database.js";
import { ApiError } from "../errors.js";
import { requireAuth } from "../middleware/auth.js";
import { syncReporterLifecycleNotifications } from "../services/notifications.js";

const router = Router();
router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    const unread = String(req.query.unread || "false") === "true";
    const items = await withTransaction(req.user.id, async (client) => {
      if (req.user.role === "REPORTER") {
        await syncReporterLifecycleNotifications(client, req.user.id);
      }
      const r = await client.query(
        `SELECT "Id" AS id,"Type" AS type,"Title" AS title,"Message" AS message,
                "EntityType" AS "entityType","EntityId" AS "entityId","Payload" AS payload,
                "IsRead" AS "isRead","ReadAt" AS "readAt","CreatedAt" AS "createdAt"
         FROM "dbo"."Notifications"
         WHERE "UserId"=$1 AND ($2::boolean=FALSE OR "IsRead"=FALSE)
         ORDER BY "CreatedAt" DESC
         LIMIT 100`,
        [req.user.id, unread],
      );
      return r.rows;
    });
    res.json({ items });
  } catch (e) {
    next(e);
  }
});

router.post("/:id/read", async (req, res, next) => {
  try {
    const r = await withTransaction(req.user.id, (c) =>
      c.query(
        `UPDATE "dbo"."Notifications"
         SET "IsRead"=TRUE,"ReadAt"=COALESCE("ReadAt",NOW()),"UpdatedAt"=NOW()
         WHERE "Id"=$1 AND "UserId"=$2
         RETURNING "Id" AS id,"IsRead" AS "isRead","ReadAt" AS "readAt"`,
        [req.params.id, req.user.id],
      ),
    );
    if (!r.rows[0])
      throw new ApiError(
        404,
        "Notification was not found.",
        "NOTIFICATION_NOT_FOUND",
      );
    res.json(r.rows[0]);
  } catch (e) {
    next(e);
  }
});

router.post("/read-all", async (req, res, next) => {
  try {
    const r = await withTransaction(req.user.id, (c) =>
      c.query(
        `UPDATE "dbo"."Notifications"
         SET "IsRead"=TRUE,"ReadAt"=COALESCE("ReadAt",NOW()),"UpdatedAt"=NOW()
         WHERE "UserId"=$1 AND "IsRead"=FALSE`,
        [req.user.id],
      ),
    );
    res.json({ updated: r.rowCount });
  } catch (e) {
    next(e);
  }
});

export default router;
