# Web Admin V2: cache domain versions, response cache and list paging

Contract for [seefix-api#18](https://github.com/seefixmanagement/seefix-api/issues/18), part of the Web Admin V2 epic
([seefix-web-admin#16](https://github.com/seefixmanagement/seefix-web-admin/issues/16)). It is consumed by
seefix-web-admin#17 (tables), #18 (CacheSyncService) and seefix-worker#3 (change hints).

## 1. Cache domains and how versions move

`dbo."CacheDomainVersions"` has one row per domain plus a `'*'` counter. Migration:
`db/migrations/2026-10-16-v2-cache-domain-versions.sql`, which is additive, idempotent, and includes a rollback.

| Domain | Tables (any INSERT/UPDATE/DELETE bumps it) |
|---|---|
| `reports` | Reports, ReportImages, ReportStatusHistory, ReportAssessmentHistory, ReportVerifications, ReportDuplicateCandidates, MaintenanceRequests (+ Materials, Skills, Revisions), MaintenanceReviews |
| `work_orders` | WorkOrders, WorkOrderAssignments, WorkOrderPeople, WorkOrderMaterials, WorkOrderImages, WorkOrderUpdates |
| `procurement` | ProcurementHandoffs, ProcurementClarifications, ProcurementDocuments, ProcurementOutcomes |
| `action_items` | WorkflowActionItems |
| `users` | Users |
| `reference` | Buildings, FacilityLocations, DamageCategories, Skills, Materials, CategorySkillRequirements, CategoryMaterialReferences, SystemSettings |

Notifications, OutboxEvents, AuditLogs and UserAuthChallenges are not cached domains.

**Every writer is covered without code changes.** The versions are bumped by `DEFERRABLE INITIALLY DEFERRED`
constraint triggers, so this happens inside the writer's own transaction, at COMMIT. That covers the API, seefix-agents
(assessments, drafts, completion checks, queue claims) and seefix-worker (agent-retry requeues), and anything else that
writes SQL. Properties:

- **Transactional.** A rollback bumps nothing. A commit bumps each touched domain exactly once, however many rows
  changed.
- **Monotonic.** Versions come from the `'*'` counter, so they are strictly increasing across all domains.
- **Deadlock-free.** The version rows are locked only at commit, after all business locks, and always in the order
  `'*'` then domain.
- **Cost.** At most two single-row UPDATEs per touched domain per transaction. Committing writers serialize on the
  `'*'` row for the moment of commit only.

## 2. `GET /api/sync/versions`

Requires authentication; staff roles only (Reporter → 403). The response is never cached (`Cache-Control: no-store`).

```json
{ "available": true, "versions": { "reports": 41, "work_orders": 17, "procurement": 9, "action_items": 3, "users": 12, "reference": 5 } }
```

- **Role filtering.** Each role only sees the domains it can read:
  - ADMIN and Maintenance roles: all six domains.
  - PROCUREMENT: `procurement`, `reports`, `reference`.
  - WORKER: `work_orders`, `reports`, `reference`.
- **Before the migration** the response is `{ "available": false, "versions": {} }`. Clients then fall back to
  time-based refresh.
- **Clients poll it even while Pusher is connected**, because a publisher can be down behind a healthy socket. When a
  domain's number changes, refetch the datasets that depend on it.

## 3. Per-instance response cache

`src/cache/response-cache.js` holds a bounded LRU of serialized JSON for GET routes. There is no Redis; every
Node/Vercel instance has its own cache.

- **Order of operations per request:**
  1. JWT check and the user re-read from the database (`requireAuth`).
  2. Role check.
  3. Read the domain versions.
  4. If the cached entry was built from exactly these versions and its TTL hasn't expired, serve it (`X-Cache: HIT`).
  5. Otherwise run the handler (`MISS`). Identical concurrent requests share that one run (`SHARED`).
- **Private data is never read before the caller is authorized.** Permissions and action eligibility always come from
  the database: user, role, active state and session revocation are re-read on every request, and detail routes are
  not cached.
- **The key is** path + sorted query + role. Routes whose result depends on the caller use `scope: "user"` instead of
  role, for example `GET /api/work-orders`, where a WORKER sees only the work orders they lead.
- **Only `200` responses are stored.**
- **Header `X-Data-Versions`** carries the stamp the response was built from, e.g. `reports:41|reference:5`.
- **Database unreachable:** if the versions can't be read, the request fails like any other database error. No cached
  data is served, because it can't be proven current.
- **Migration not applied:** the table is missing, so the route runs uncached, exactly as before.
- **TTL** (default 60 s) only bounds time-based drift. Live priority rises with a report's age without any write, and
  that rise must still show up.
- **Settings:**

  | Variable | Default |
  |---|---|
  | `RESPONSE_CACHE` | `on` |
  | `RESPONSE_CACHE_TTL_MS` | 60000 |
  | `RESPONSE_CACHE_MAX_ENTRIES` | 500 |
  | `RESPONSE_CACHE_MAX_BYTES` | 50 MB per instance |

| Cached route | Domains | Scope |
|---|---|---|
| `GET /api/maintenance/action-center` | reports, work_orders, procurement, reference | role |
| `GET /api/maintenance/review-queue` | reports, reference | role |
| `GET /api/maintenance/reports` | reports, reference | role |
| `GET /api/work-orders` | work_orders, reports | user |
| `GET /api/work-orders/assignable-users` | users | role |
| `GET /api/procurement/inbox` | procurement, reports, reference | role |
| `GET /api/admin/users` | users | role |
| `GET /api/reference/*` | reference | role |

Not cached: auth and account routes, OTP, signed uploads, every mutation, detail pages, notifications and realtime.

## 4. List paging (for seefix-web-admin#17)

The list routes above accept `?page=1&pageSize=200`:
- `page` starts at 1.
- `pageSize` is 1–500.
- Anything else returns `400 INVALID_PAGE` / `INVALID_PAGE_SIZE`.

```json
{ "items": [ ... ], "page": 1, "pageSize": 200, "hasMore": true }
```

- **Without paging params a route returns its legacy `{ items }` unchanged**, including the old 200-row cap on
  reports and work orders. The current production web admin keeps working.
- **Server order is stable** and ends with an Id tie-breaker. Action Center, Review Queue and Procurement Inbox keep
  their business ranking (priority, then age). Reports keep priority order; Work Orders and Users are newest first.
  The client applies its own default sort after loading.
- **The client loads every page** (`hasMore` until `false`), dedupes by id, and compares `X-Data-Versions` across
  pages (or `/api/sync/versions` before and after). If the domains moved during the load, it refetches once. No
  snapshot is held open between requests.

## 5. Client mapping (for seefix-web-admin#18)

| Web module / dataset | Domains to watch |
|---|---|
| Action Center | reports, work_orders, procurement, reference |
| Review Queue | reports, reference |
| Reports | reports, reference |
| Work Orders | work_orders, reports |
| Procurement Inbox | procurement, reports, reference |
| Users | users |
| Dashboard | every domain the role receives |

## 6. Realtime change hints (seefix-worker#3)

The versions table is itself the durable change log; business transactions write nothing extra to OutboxEvents.

- **Publisher.** seefix-worker job `cache-change-hints` (`JOB_CACHE_CHANGE_HINTS=on`) reads `dbo."CacheDomainVersions"`
  every ~2 s. When domains rose, it publishes `data.changed { "versions": { "<domain>": <version>, ... } }` to each
  role channel allowed to see those domains (`DOMAINS_BY_ROLE` above, the same filter as `GET /api/sync/versions`).
- **Restart-safe and idempotent.** After a (re)start it publishes the current versions once. A repeated hint is harmless:
  clients compare numbers.
- **Channels.** `private-role-<ROLE>` for the five staff roles. `/api/realtime/auth` signs one only for the caller's own
  current role (`req.user.role`, re-read from the database on each request); another role's channel, a REPORTER, an
  unknown role or a malformed name gets 403 (`src/realtime/role-channels.js`). `GET /api/realtime/config` returns it as
  `roleChannel` (`null` for REPORTER). A role change takes effect for new subscriptions; an already-open socket keeps the
  old role channel until it reconnects, which only exposes domain numbers the user could read moments earlier.

The hint carries only domain names and numbers: no record data. Clients treat it as "check `/api/sync/versions`
now", and the REST poll stays the authority, also when the socket is connected but the publisher is down.

## 7. Evidence (local PostgreSQL 16 copy of the 2026-10-13 backup + Oct 14 migration)

- **Migration:** applied twice without errors. `npm run verify:db` reports `7 domains, 31 version triggers`.
- **Existing suites with the triggers installed:** `npm test` with `SEEFIX_INTEGRATION_DB=1`: all existing live and
  unit tests pass.
- **Unit tests** (`tests/response-cache.test.js`):
  - hit and miss on version change
  - role and user isolation
  - query-order-independent keys
  - single flight
  - errors not cached
  - database down → error, not stale
  - no table → uncached
  - LRU, byte budget and TTL
  - paging validation, including injection-shaped input
- **Live test** (`tests/cache-sync.live.test.js`), with two separate API processes on one database:
  - a rolled-back write doesn't invalidate
  - an Agent-style SQL commit invalidates the other instance
  - an API commit on instance B invalidates instance A
  - `/api/sync/versions` is `no-store` and role-filtered
  - paging returns every row exactly once, in direct-SQL order
  - legacy callers keep `{ items }`
  - prints cached vs uncached p50/p95
