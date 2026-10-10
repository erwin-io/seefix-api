# Realtime (OutboxEvents -> Pusher) rollout

Delivery is **off by default**. Deploying this code changes nothing until `OUTBOX_DISPATCHER=on` is set
(or `npm run outbox:dispatch` is started) with `PUSHER_*` configured. Clients keep polling either way;
REST stays authoritative and every realtime message is a "refetch" hint carrying `eventId`.

## Guarantees and limits
- **Contract:** uses only existing `dbo."OutboxEvents"` columns (`Status`, `AttemptCount`, `NextAttemptAt`,
  `LastError`, `SentAt`) and the existing `IX_OutboxEvents_Queue` index. No migration.
- **Claim:** `FOR UPDATE SKIP LOCKED`, `PUSHER` rows only, `PENDING` and due, or `PROCESSING` with an expired lease.
- **Lease vs timeout:** each Pusher call is aborted after `OUTBOX_PUBLISH_TIMEOUT_MS`. A batch is published
  sequentially under one lease, so startup fails unless `OUTBOX_LEASE_SECONDS*1000 > OUTBOX_BATCH_SIZE*OUTBOX_PUBLISH_TIMEOUT_MS`
  (defaults: 60 s > 10 x 5 s).
- **Idempotency:** delivery is at-least-once. A crash after Pusher accepted a message but before `SENT` is written
  re-sends it after the lease, with the same `eventId`. Outcome writes are guarded by `Id + PROCESSING + AttemptCount`.
- **Retry:** exponential backoff (`OUTBOX_BACKOFF_*`); `FAILED` after `OUTBOX_MAX_ATTEMPTS`; rows are never deleted.
- **Backlog bound:** rows older than `OUTBOX_MAX_AGE_MINUTES` (default 60) are never claimed and stay `PENDING`,
  untouched. Enabling delivery therefore never floods clients with old events.
- **Scoping:** channels are derived server-side (`src/realtime/channels.js`); unroutable rows become `FAILED`, never
  broadcast. `/api/realtime/auth` applies the same rules as `GET /api/reports/:id` (`canSubscribe`).

## Stale events: policy, observability, cleanup
- **Deliberate:** events older than `OUTBOX_MAX_AGE_MINUTES` stay `PENDING` and are never sent. A realtime event
  is only a "refetch" hint; once it is stale, the client's REST read or poll already has the data. Leaving the
  row untouched keeps the audit trail and allows a deliberate replay.
- **Observability:** on start, the dispatcher logs `[OUTBOX] N PUSHER event(s) older than ... stay PENDING`, and it logs
  each pass that moves rows to `FAILED`. For ad-hoc checks:
  `SELECT "Status",COUNT(*),MIN("CreatedAt") FROM dbo."OutboxEvents" WHERE "Transport"='PUSHER' GROUP BY 1;`
- **Cleanup (operator decision, not automated):** to close stale rows explicitly without deleting them:
  `UPDATE dbo."OutboxEvents" SET "Status"='FAILED',"LastError"='expired: older than OUTBOX_MAX_AGE_MINUTES'
   WHERE "Transport"='PUSHER' AND "Status"='PENDING' AND "CreatedAt"<NOW()-interval '60 minutes';`
  Rows are never deleted by the application.

## Enable (canary)
1. Confirm the backlog that will **not** be sent:
   `SELECT "Status",COUNT(*),MIN("CreatedAt") FROM dbo."OutboxEvents" WHERE "Transport"='PUSHER' GROUP BY 1;`
2. Enable on **one** instance: `OUTBOX_DISPATCHER=on` (others stay `off`), or run `npm run outbox:dispatch` once.
3. Canary: trigger one notification for a test user, open the Pusher debug console, and verify:
   the event lands on `private-user-{that user}` only; the row is `SENT`; a second user's client receives nothing;
   `/api/realtime/auth` returns 403 for that second user on the first user's channel.
4. Watch `"Status"='FAILED'` and `"LastError"` for an hour, then enable on the remaining instances if wanted
   (concurrent dispatchers are safe).

## Disable / rollback
Set `OUTBOX_DISPATCHER=off` and restart. Undelivered rows stay `PENDING`; nothing is lost and clients poll.

## Deliberate replay
Only when a replay is actually wanted: temporarily raise `OUTBOX_MAX_AGE_MINUTES` on one instance, let it drain,
then restore it. To retry `FAILED` rows, set them back to `PENDING` with `"NextAttemptAt"=NULL` (an operator
decision; not automated).
