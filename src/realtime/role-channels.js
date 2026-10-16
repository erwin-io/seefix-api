/**
 * Role channels for cache-change hints (docs/V2_CACHE_SYNC.md §6, seefix-worker#3).
 *
 *   private-role-{ROLE}   every user whose current role is ROLE; only roles that may read /api/sync/versions
 *
 * seefix-worker publishes `data.changed { versions: { <domain>: <n> } }` here, filtered by DOMAINS_BY_ROLE, so a
 * role only hears about domains it can already read through GET /api/sync/versions. The hint carries no record data.
 * Kept apart from channels.js so that file stays a verbatim copy in seefix-worker (see its SOURCE.md).
 */
import { DOMAINS_BY_ROLE } from "../routes/sync.js";

const ROLE_CHANNEL = /^private-role-([A-Z_]+)$/;

/** Channel name for a role, or null when the role gets no hints (REPORTER, unknown). */
export function roleChannel(role) {
  return Object.hasOwn(DOMAINS_BY_ROLE, role) ? `private-role-${role}` : null;
}

/**
 * true when `name` is a role channel `user` may subscribe to: exactly their own current role (re-read from the
 * database by requireAuth on every request). false for any other name, including other roles' channels.
 */
export function canSubscribeRole(user, name) {
  const m = ROLE_CHANNEL.exec(String(name || ""));
  return Boolean(m && user?.id && user.role === m[1] && roleChannel(m[1]));
}
