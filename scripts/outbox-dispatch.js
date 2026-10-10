// Standalone OutboxEvents -> Pusher worker (optional). Use with OUTBOX_DISPATCHER=off on API instances
// to run delivery in one dedicated process instead of inside every API process.
// Usage: npm run outbox:dispatch   (requires DATABASE_URL and PUSHER_* in the environment)
import { config, validateRuntimeConfig } from "../src/config.js";
import { pool, query } from "../src/database.js";
import { startDispatcher } from "../src/realtime/outbox-dispatcher.js";
import { publish, realtimeEnabled } from "../src/realtime/pusher-client.js";

validateRuntimeConfig();
if (!realtimeEnabled) {
  console.error("PUSHER_* is not configured; nothing to dispatch.");
  process.exit(1);
}
const stop = startDispatcher({
  q: query,
  publish,
  intervalMs: config.outboxPollMs,
  batchSize: config.outboxBatchSize,
  maxAttempts: config.outboxMaxAttempts,
  leaseSeconds: config.outboxLeaseSeconds,
  baseMs: config.outboxBackoffBaseMs,
  maxMs: config.outboxBackoffMaxMs,
  maxAgeMinutes: config.outboxMaxAgeMinutes,
});
console.log("OutboxEvents dispatcher running. Ctrl+C to stop.");
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    stop();
    await pool.end();
    process.exit(0);
  });
}
