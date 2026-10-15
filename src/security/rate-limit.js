import { createHash } from "node:crypto";
import { query } from "../database.js";
import { ApiError } from "../errors.js";

/**
 * Client IP for rate limiting. On Vercel, `x-vercel-forwarded-for` is set by Vercel's edge and overwrites anything
 * the client sent, so it can't be spoofed; plain `x-forwarded-for` can. Elsewhere `req.ip` (Express, `trust proxy` 1).
 */
export function clientIp(req) {
  if (process.env.VERCEL) {
    const edge = String(req.get("x-vercel-forwarded-for") || "").split(",")[0].trim();
    if (edge) return edge;
  }
  return req.ip || req.socket?.remoteAddress || "unknown";
}

/** Identifiers (emails, usernames) are hashed so raw personal data is never stored in counters. */
export function hashKey(value) {
  return createHash("sha256").update(String(value).trim().toLowerCase()).digest("hex").slice(0, 32);
}

function tooMany(retryAfterSeconds, message) {
  const error = new ApiError(429, message, "RATE_LIMITED");
  error.retryAfter = Math.max(1, Math.ceil(retryAfterSeconds));
  return error;
}

/** Atomic fixed-window counter in dbo."RateLimitBuckets": correct across every API instance. */
export async function hitSharedBucket(key, windowSeconds, db = { query }) {
  const r = await db.query(
    `INSERT INTO "dbo"."RateLimitBuckets" ("Key","WindowStart","Count") VALUES ($1, now(), 1)
     ON CONFLICT ("Key") DO UPDATE SET
       "Count" = CASE WHEN "RateLimitBuckets"."WindowStart" <= now() - make_interval(secs => $2)
                      THEN 1 ELSE "RateLimitBuckets"."Count" + 1 END,
       "WindowStart" = CASE WHEN "RateLimitBuckets"."WindowStart" <= now() - make_interval(secs => $2)
                      THEN now() ELSE "RateLimitBuckets"."WindowStart" END
     RETURNING "Count",
       GREATEST(0, EXTRACT(EPOCH FROM ("WindowStart" + make_interval(secs => $2) - now())))::float AS "ResetIn"`,
    [key, windowSeconds],
  );
  if (Math.random() < 0.01) {
    // Opportunistic cleanup; never blocks the request.
    db.query(`DELETE FROM "dbo"."RateLimitBuckets" WHERE "WindowStart" < now() - interval '1 day'`).catch(() => {});
  }
  return { count: r.rows[0].Count, resetIn: Number(r.rows[0].ResetIn) };
}

/**
 * Shared (database-backed) limit. `key(req)` returns the subject (e.g. client IP, hashed email) or null to skip.
 * Over the limit → 429 RATE_LIMITED with Retry-After.
 */
export function sharedRateLimit({ name, windowSeconds, max, key, message = "Too many attempts. Please wait and try again.", hit = hitSharedBucket }) {
  return async (req, _res, next) => {
    try {
      const subject = key(req);
      if (!subject) return next();
      const { count, resetIn } = await hit(`${name}:${subject}`.slice(0, 200), windowSeconds);
      if (count > max) return next(tooMany(resetIn, message));
      next();
    } catch (error) {
      // Before db/migrations/2026-10-16-v2-rate-limits.sql is applied: no shared limits, behave as before.
      if (error?.code === "42P01") return next();
      next(error);
    }
  };
}

/** Per-process fixed window. Best effort only (each Vercel instance counts separately); used for general throttling. */
export class MemoryWindow {
  constructor({ windowMs, max, maxKeys = 50000, now = Date.now }) {
    Object.assign(this, { windowMs, max, maxKeys, now });
    this.buckets = new Map();
  }

  hit(key) {
    const t = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket || t - bucket.start >= this.windowMs) {
      if (this.buckets.size >= this.maxKeys) {
        for (const [k, b] of this.buckets) if (t - b.start >= this.windowMs) this.buckets.delete(k);
        if (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value);
      }
      bucket = { start: t, count: 0 };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    return { allowed: bucket.count <= this.max, resetIn: (bucket.start + this.windowMs - t) / 1000 };
  }
}

export function memoryRateLimit({ windowMs, max, key, message = "Too many requests. Please slow down." }) {
  const window = new MemoryWindow({ windowMs, max });
  const middleware = (req, _res, next) => {
    const subject = key(req);
    if (!subject) return next();
    const { allowed, resetIn } = window.hit(subject);
    return allowed ? next() : next(tooMany(resetIn, message));
  };
  middleware.window = window;
  return middleware;
}
