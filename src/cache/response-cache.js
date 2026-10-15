import { config } from "../config.js";
import { readVersions, versionStamp } from "./versions.js";

/**
 * Bounded per-process LRU of serialized GET responses (no Redis: each Node/Vercel instance has its own).
 * An entry is served only when the domain versions it was built from are still current, so a write committed by any
 * instance, the Agent or the Worker invalidates it on the next request. The TTL only bounds time-based drift.
 */
export class ResponseCache {
  constructor({ maxEntries, maxBytes, ttlMs, now = Date.now } = {}) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = new Map(); // key -> { stamp, body, bytes, expiresAt }; Map order = LRU order
    this.bytes = 0;
    this.inflight = new Map(); // `${key}#${stamp}` -> Promise<string | null>
    this.stats = { hits: 0, misses: 0, shared: 0 };
  }

  get(key, stamp) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.stamp !== stamp || entry.expiresAt <= this.now()) {
      this.delete(key);
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, entry); // most recently used
    return entry.body;
  }

  set(key, stamp, body) {
    const bytes = body.length;
    if (bytes > this.maxBytes) return;
    this.delete(key);
    this.entries.set(key, { stamp, body, bytes, expiresAt: this.now() + this.ttlMs });
    this.bytes += bytes;
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries && this.bytes <= this.maxBytes) break;
      this.delete(oldest);
    }
  }

  delete(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.bytes -= entry.bytes;
    this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
}

export const responseCache = new ResponseCache({
  maxEntries: config.responseCacheMaxEntries,
  maxBytes: config.responseCacheMaxBytes,
  ttlMs: config.responseCacheTtlMs,
});

function cacheKey(req, scope) {
  const params = new URLSearchParams(
    Object.entries(req.query)
      .filter(([, value]) => typeof value === "string")
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const who = scope === "user" ? `user:${req.user.id}` : `role:${req.user.role}`;
  return `${req.baseUrl}${req.path}?${params}|${who}`;
}

/**
 * Cache a GET route's JSON response. Mount AFTER requireAuth/requireRoles, so nothing private is read before the
 * caller is authorized. `scope: "role"` shares an entry between users of the same role (the route's result depends
 * only on role and query); use `scope: "user"` when it depends on who is asking (row ownership, WORKER scoping).
 */
export function cachedGet({ domains, scope = "role", cache = responseCache, versions = readVersions, enabled = config.responseCacheEnabled }) {
  if (scope !== "role" && scope !== "user") throw new Error(`cachedGet scope must be "role" or "user".`);
  return async (req, res, next) => {
    if (!enabled || req.method !== "GET" || !req.user) return next();
    let current;
    try {
      // Read versions BEFORE the handler reads data, so a response is never labelled newer than it is.
      current = await versions();
    } catch (error) {
      return next(error); // database unreachable: never fall back to possibly stale cached data
    }
    if (!current) return next(); // migration not applied yet: behave exactly as before

    const key = cacheKey(req, scope);
    const stamp = versionStamp(current, domains);
    res.set("X-Data-Versions", stamp);

    const hit = cache.get(key, stamp);
    if (hit !== null) {
      cache.stats.hits += 1;
      res.set("X-Cache", "HIT");
      return res.type("application/json").send(hit);
    }

    const flightKey = `${key}#${stamp}`;
    const pending = cache.inflight.get(flightKey);
    if (pending) {
      const body = await pending;
      if (body !== null) {
        cache.stats.shared += 1;
        res.set("X-Cache", "SHARED");
        return res.type("application/json").send(body);
      }
      return next(); // the first request failed: run this one normally
    }

    cache.stats.misses += 1;
    let settle;
    cache.inflight.set(flightKey, new Promise((resolve) => (settle = resolve)));
    const done = (body) => {
      if (cache.inflight.get(flightKey)) cache.inflight.delete(flightKey);
      settle(body);
    };
    const json = res.json.bind(res);
    res.json = (payload) => {
      if (res.statusCode === 200) {
        const body = JSON.stringify(payload);
        cache.set(key, stamp, body);
        done(body);
      } else {
        done(null);
      }
      res.set("X-Cache", "MISS");
      return json(payload);
    };
    res.on("close", () => done(null));
    next();
  };
}
