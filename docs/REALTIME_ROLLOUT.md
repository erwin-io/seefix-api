# Realtime (OutboxEvents -> Pusher) rollout

Two independent opt-in switches, both **off by default**:

| Switch | Controls | Default |
|---|---|---|
| `OUTBOX_DISPATCHER=on` (or a dedicated `npm run outbox:dispatch` worker) | **Publishing**: `OutboxEvents` → Pusher | off: rows stay `PENDING` |
| `REALTIME_CLIENTS_ENABLED=on` | **Advertising**: `GET /api/realtime/config` → `enabled:true`, and `/api/realtime/auth` signs subscriptions | off: `enabled:false`, `/auth` 503, clients poll |

Having `PUSHER_*` credentials enables neither. Clients go "live" and stop polling only when realtime is advertised, so
`REALTIME_CLIENTS_ENABLED` must be turned on **only after a publisher is confirmed running**, and turned off **before** stopping
the last publisher. REST stays authoritative, and every realtime message is a "refetch" hint carrying `eventId`.

**Activation order.** Single-instance: set `OUTBOX_DISPATCHER=on` on that instance, confirm a row reaches `SENT`, then set
`REALTIME_CLIENTS_ENABLED=on` and restart. Dedicated worker: run `npm run outbox:dispatch` (API instances keep `OUTBOX_DISPATCHER=off`),
confirm a row reaches `SENT`, then set `REALTIME_CLIENTS_ENABLED=on` on the API instances.

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
- **Lapsed lease past max age:** if a worker dies holding a row and the row crosses `OUTBOX_MAX_AGE_MINUTES` before its
  lease expires, the next pass sets it to `FAILED` with `LastError='expired: lease lapsed ...'`. `FAILED` is used, not
  `CANCELLED`, because older schemas allow only `PENDING/PROCESSING/SENT/FAILED`; no migration is needed. It is never re-sent
  and never left `PROCESSING`. A lease that has not expired yet is left to its owner. Check with
  `SELECT COUNT(*) FROM dbo."OutboxEvents" WHERE "Status"='FAILED' AND "LastError" LIKE 'expired:%';`.
- **Scoping:** channels are derived server-side (`src/realtime/channels.js`) from `AggregateType`/`AggregateId`. Child
  aggregates resolve their parent from the DB. A legacy `ChannelName` (`report-{id}`, `work-order-{id}`) is accepted
  only when it names that same channel; any mismatch or unrecognised name fails closed. Unroutable rows become `FAILED`, never
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

## Verification (reproducible)
Ordinary CI (`npm run check && npm test`) runs the unit tests only. The live tests are opt-in and separate:
they need a PostgreSQL with the SEEFIX schema (`DATABASE_URL`) and, for the ACL/secret test, `PUSHER_*`.
They never modify existing `dbo` rows. Dispatcher tests use a throwaway schema copied from `dbo."OutboxEvents"`,
and the notification test rolls its transaction back.
```bash
npm run check && npm test                                    # unit: channel matrix, dispatcher outcomes, claim SQL
SEEFIX_INTEGRATION_DB=1 node --test --test-reporter=spec tests/outbox-dispatcher.live.test.js   # concurrency, outage, lease, max age, tx rollback
SEEFIX_INTEGRATION_DB=1 REALTIME_CLIENTS_ENABLED=on node --test --test-reporter=spec tests/realtime-acl-parity.live.test.js # REST vs realtime auth per role; secret checks
```
Preflight (no user-identifying fields; payload **key names** only):
```sql
SELECT "Transport","Status","AggregateType","EventName",
       (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys("Payload") k) AS payload_keys,
       ("ChannelName" IS NOT NULL) AS has_channel_name, ("RecipientUserId" IS NOT NULL) AS has_recipient,
       COUNT(*)::int AS n, date_trunc('day', MIN("CreatedAt")) AS oldest_day
  FROM dbo."OutboxEvents" GROUP BY 1,2,3,4,5,6,7 ORDER BY 1,3,4;
```
Expected payload keys are ids or status only (for example `reportId,reportNo,agentStatus` or `notificationId,type,entityType,entityId`).
Stop and review before enabling if a payload carries free text or personal data: every subscriber authorized on that channel receives it.

## One-instance canary checklist
- [ ] Deployed with `OUTBOX_DISPATCHER=off` (the default) on **all** instances. Startup is clean: no lease/timeout config error.
- [ ] Preflight query reviewed: the payload keys are ids or status only, and the stale `PENDING` count is noted. Those rows will **not** be sent
      (60-minute cap, measured from `CreatedAt` at claim time).
- [ ] Turn on **one** instance: `OUTBOX_DISPATCHER=on`, then restart. The log shows `OutboxEvents -> Pusher dispatcher running` and,
      if any exist, `[OUTBOX] N PUSHER event(s) older than 60 min stay PENDING`.
- [ ] Before clients are enabled: `GET /api/realtime/config` returns `enabled:false` (clients poll), even with `PUSHER_*` set.
- [ ] After the canary row below reaches `SENT`, set `REALTIME_CLIENTS_ENABLED=on` (canary instance, or all API instances when a dedicated worker
      publishes) and restart. `GET /api/realtime/config` now returns `enabled:true`.
- [ ] Trigger one notification for test user A. In the Pusher debug console it appears on `private-user-{A}` only, and its row
      becomes `SENT` with `AttemptCount=1`.
- [ ] As user B, `POST /api/realtime/auth` for `private-user-{A}`, a report/work order/handoff that B cannot GET, and a
      nonexistent id. All return **403**. The same call for B's own channel returns 200.
- [ ] Watch for one hour: `SELECT "Status",COUNT(*) FROM dbo."OutboxEvents" WHERE "Transport"='PUSHER' AND "CreatedAt">NOW()-interval '1 hour' GROUP BY 1;`
      Expect no `FAILED` rows and no `PROCESSING` rows older than the lease (60 s).
- [ ] Duplicate delivery is understood. If the instance is killed between a Pusher accept and the `SENT` write, the row is re-sent
      after the lease with the **same `eventId`**. Clients treat events as "refetch", so a duplicate costs one extra GET.
- [ ] Only after the hour is clean: enable on other instances, if wanted. Concurrent dispatchers are safe (`SKIP LOCKED`).

## Disable / rollback
First set `REALTIME_CLIENTS_ENABLED=off` and restart the API instances, so clients see `enabled:false` on their next start and poll.
Then set `OUTBOX_DISPATCHER=off` (or stop the worker) and restart; no code rollback or migration is needed. Undelivered rows stay `PENDING`, nothing is
lost, and clients poll. A row a stopped instance was holding as `PROCESSING` is picked up after its lease by any
instance still on, or left as is if all are off.

## Deliberate replay
Only when a replay is actually wanted: temporarily raise `OUTBOX_MAX_AGE_MINUTES` on one instance, let it drain,
then restore it. To retry `FAILED` rows, set them back to `PENDING` with `"NextAttemptAt"=NULL` (an operator
decision; not automated).
