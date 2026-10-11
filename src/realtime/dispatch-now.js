/**
 * On-demand OutboxEvents delivery for hosts without a long-lived dispatcher loop (Vercel).
 * - POST /api/realtime/dispatch (external cron / the Agent) calls dispatchNow().
 * - dispatchAfterWrite middleware runs one drain after each successful write request.
 * Both reuse dispatchOnce(): SKIP LOCKED claims, retries, max-age and lease rules are unchanged,
 * so overlapping calls (cron + after-write + another instance) never send a row twice.
 */
import { timingSafeEqual, createHash } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { config } from "../config.js";
import { query } from "../database.js";
import { dispatchOnce } from "./outbox-dispatcher.js";
import { publish, realtimeEnabled } from "./pusher-client.js";

const MAX_PASSES = 10;
const TIME_BUDGET_MS = 20000; // stay well inside Vercel's 60 s maxDuration

/** Drain pending rows: repeat passes while full batches are claimed. Returns summed counts. */
export async function dispatchNow({ q = query, send = publish, enabled = realtimeEnabled, now = Date.now } = {}) {
  const total = { passes: 0, claimed: 0, sent: 0, retried: 0, failed: 0, expired: 0 };
  if (!enabled) return total;
  const started = now();
  while (total.passes < MAX_PASSES && now() - started < TIME_BUDGET_MS) {
    const r = await dispatchOnce({
      q,
      publish: send,
      batchSize: config.outboxBatchSize,
      leaseSeconds: config.outboxLeaseSeconds,
      maxAttempts: config.outboxMaxAttempts,
      baseMs: config.outboxBackoffBaseMs,
      maxMs: config.outboxBackoffMaxMs,
      maxAgeMinutes: config.outboxMaxAgeMinutes,
    });
    total.passes += 1;
    for (const k of ["claimed", "sent", "retried", "failed", "expired"]) total[k] += r[k] ?? 0;
    if (r.claimed < config.outboxBatchSize) break;
  }
  return total;
}

/** Constant-time check of `Authorization: Bearer <secret>` (same header Vercel Cron sends). */
export function hasDispatchSecret(authorization, secret = config.outboxCronSecret) {
  if (!secret) return false;
  const given = String(authorization || "").replace(/^Bearer\s+/i, "");
  const digest = (v) => createHash("sha256").update(String(v)).digest();
  return timingSafeEqual(digest(given), digest(secret));
}

/** After a successful write request, deliver what it queued without delaying the response. */
export function dispatchAfterWrite({ run = dispatchNow, schedule = waitUntil, log = console } = {}) {
  return (req, res, next) => {
    // Reads queue nothing; /api/realtime/* (auth, dispatch itself) writes no business events.
    if (["GET", "HEAD", "OPTIONS"].includes(req.method) || req.originalUrl.startsWith("/api/realtime/")) return next();
    res.on("finish", () => {
      if (res.statusCode >= 400) return;
      const job = run().catch((e) => log.warn?.(`[OUTBOX] after-write dispatch failed: ${e?.message || e}`));
      schedule(job); // Vercel keeps the function alive until it settles; elsewhere it simply runs.
    });
    next();
  };
}
