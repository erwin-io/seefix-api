import { query } from "../database.js";

/** Cache domains bumped by the dbo."CacheDomainVersions" triggers (db/migrations/2026-10-16-v2-cache-domain-versions.sql). */
export const CACHE_DOMAINS = ["reports", "work_orders", "procurement", "action_items", "users", "reference"];

/**
 * Current domain versions, e.g. { reports: 41, users: 7, ... }. Returns null when the migration has not been applied
 * yet (undefined table), so the API keeps working without caching. Any other database error is thrown: when versions
 * can't be read, nothing cached may be served.
 */
export async function readVersions(db = { query }) {
  try {
    const result = await db.query(`SELECT "Domain", "Version" FROM "dbo"."CacheDomainVersions" WHERE "Domain" <> '*'`);
    return Object.fromEntries(result.rows.map((row) => [row.Domain, Number(row.Version)]));
  } catch (error) {
    if (error?.code === "42P01") return null;
    throw error;
  }
}

/** "reports:41|users:7": the part of the version map a cached response depends on. */
export function versionStamp(versions, domains) {
  return domains.map((domain) => `${domain}:${versions[domain] ?? 0}`).join("|");
}
