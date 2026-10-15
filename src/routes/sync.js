import { Router } from "express";
import { requireAuth, requireRoles } from "../middleware/auth.js";
import { readVersions } from "../cache/versions.js";

const router = Router();

/** Domains each role may watch: only ones behind routes the role can read (no activity hints about the rest). */
export const DOMAINS_BY_ROLE = {
  ADMIN: ["reports", "work_orders", "procurement", "action_items", "users", "reference"],
  MAINTENANCE_SUPERVISOR: ["reports", "work_orders", "procurement", "action_items", "users", "reference"],
  MAINTENANCE_STAFF: ["reports", "work_orders", "procurement", "action_items", "users", "reference"],
  PROCUREMENT: ["procurement", "reports", "reference"],
  WORKER: ["work_orders", "reports", "reference"],
};

/**
 * GET /api/sync/versions → { available, versions: { reports: 41, ... } }. Never cached. Clients poll it (even while
 * Pusher is connected, since a publisher can be down behind a healthy socket) and refetch a dataset when one of its
 * domains moved. `available: false` before the migration is applied: clients fall back to time-based refresh.
 */
router.get("/versions", requireAuth, requireRoles(...Object.keys(DOMAINS_BY_ROLE)), async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    const versions = await readVersions();
    if (!versions) return res.json({ available: false, versions: {} });
    const allowed = DOMAINS_BY_ROLE[req.user.role];
    res.json({ available: true, versions: Object.fromEntries(allowed.map((d) => [d, versions[d] ?? 0])) });
  } catch (error) {
    next(error);
  }
});

export default router;
