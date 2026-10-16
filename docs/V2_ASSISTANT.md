# Web Admin V2: assistant tools, drafts, guarded reassessment and reminders

Contract for [seefix-api#21](https://github.com/seefixmanagement/seefix-api/issues/21) (epic seefix-web-admin#16). It is
consumed by:
- seefix-web-admin#21 (floating assistant UI)
- seefix-agents#7/#8 (fact-only phrasing and the reassessment claim)
- seefix-worker#3 (reminder delivery)

Migration: `db/migrations/2026-10-16-v2-workflow-assistant.sql`. It is additive and idempotent, has a rollback in
`db/migrations/rollback/`, and runs after `…-v2-search-buildings.sql`. Before it is applied, the new routes answer
`503 SCHEMA_NOT_READY`.

## 0. Rules

- **The LLM never calls the API and never picks tools.** The API runs fixed, read-only tools after its own RBAC, and
  sends the resulting facts to the Agent's `POST /api/assistant/respond`. The Agent only phrases an answer. There is no
  free SQL; every value is a bound parameter, and the only dynamic identifiers are fixed constants.
- **Who:** the five internal roles. REPORTER gets 403 on every `/api/assistant/*` route. The session rules are those of
  `requireAuth`, so a password/OTP change (`CredentialsVersion`) or a deactivation revokes access immediately.
- **The only writes** are user-owned drafts, reminders and reassessment requests. Each needs `confirm: true`; creates
  also need an `idempotencyKey` (UUID).
- **Prohibited for every role, ADMIN included** (`403 ASSISTANT_ACTION_PROHIBITED`):
  - the maintenance review and routing decision
  - every procurement action
  - Work Order creation, assignment and authorization
  - any Work Order status change, including COMPLETE and REWORK

  These stay on the normal screens and routes. Names matching approve/authorize/complete/rework/procure/work order/
  route/review/assign are refused even if not listed.
- **No caching.** Every response is `Cache-Control: no-store`.

## 1. Read-only tools

| Route | Returns | Row scope |
|---|---|---|
| `GET /api/assistant/tools` | `{ role, tools, actions: { allowed, prohibited }, navigation }` | — |
| `GET /api/assistant/tools/navigation` | web-admin paths the role may open (mirrors the Angular route guards) | — |
| `GET /api/assistant/tools/summary` | counts only: open reports/WOs by status, action items, open/overdue handoffs | Maintenance/Admin: all. PROCUREMENT: handoffs. WORKER: `myOpenWorkOrders` (WOs they lead) |
| `GET /api/assistant/tools/action-queue?limit=1..50` (default 10) | `{ items: [{ entityType, entityId, action, reference, summary, priority, since, dueAt?, route }] }` | Maintenance: `/action-center` filter and order (Staff: own `AssignedRole`). PROCUREMENT: `/procurement/inbox` order. WORKER: open WOs they lead, soonest deadline first |
| `GET /api/assistant/tools/trends?days=7..90` (default 14) | `{ days, series: { name: [{ day, count }] } }`, per UTC day, zero-filled | Maintenance: reports created, WOs completed. PROCUREMENT readers: handoffs submitted/completed. WORKER: own WOs assigned/completed |
| `GET /api/assistant/tools/records/:type/:id` (`report`, `work_order`, `handoff`) | `{ fact }` | **The detail route's rule and status code** (`assertReportAccess`, `assertWorkAccess`, procurement readers) |

A fact is `{ id, kind, label, data, navigation }`.
- **No personal data:** no emails, phone numbers, reporter or lead names, or image URLs.
- **Free text** (`description`, `aiSummary`) is cut to 500 characters, and the Agent treats it as untrusted data.
- **Ids:** fact ids are `report:<uuid>`, `work_order:<uuid>`, `handoff:<uuid>`, `summary:current`, `queue:<n>`.

## 2. `POST /api/assistant/ask`

Request: `{ question: 1..1000 chars, context?: { type, id } }`. The response has the Agent's shape:

```json
{ "status": "ANSWERED|NO_FACTS|FALLBACK", "answer": "…", "citedFactIds": ["report:…"],
  "navigation": [{ "factId": "report:…", "path": "/reports/…", "label": "RPT-…" }],
  "fallbackReason": null, "model": "…", "promptVersion": "assistant-v1", "processingTimeMs": 812 }
```

- **Facts:** the context record (access-checked; 403/404 as on the detail route), the summary and the top 10 of the
  action queue.
- **Checking the answer:** the Agent's `citedFactIds` and `navigation` are intersected with the facts the API sent,
  and each path is replaced by the API's own path. Anything else is dropped.
- **Agent down, timed out or invalid:** a deterministic `FALLBACK` that cites every fact with its API navigation.
  Always a 200; the model never causes a 5xx.
- **Limit:** shared `assistant-ask-user`, 120 per hour per user (429 `RATE_LIMITED`).

## 3. Writes: explicit confirmation, idempotency

`POST /api/assistant/actions { action, params, confirm, idempotencyKey }`. Every REST route below is the same action
with the same checks.

- **`confirm` is not exactly `true`:** the response is `200 { status: "CONFIRMATION_REQUIRED", action, preview }` and
  nothing is written. The UI shows the preview, and the human confirms.
- **Order of checks:**
  1. the prohibited/role boundary (403)
  2. confirmation
  3. validation (400)
  4. row access (403/404)
  5. state (409)
- **Responses:** `201` when a row was created. `200` for a replay of the same `idempotencyKey` (same body, the original
  row), a cancel or a discard.

| Action | REST shape | Roles |
|---|---|---|
| `save_draft` | `POST /api/assistant/drafts` | internal roles, per kind |
| `discard_draft` | `POST /api/assistant/drafts/:id/discard` | author |
| `create_reminder` | `POST /api/assistant/reminders` | internal roles |
| `cancel_reminder` | `POST /api/assistant/reminders/:id/cancel` | creator or recipient |
| `request_reassessment` | `POST /api/assistant/reassessments` | Maintenance roles, Admin |
| `cancel_reassessment` | `POST /api/assistant/reassessments/:id/cancel` | requester, Supervisor, Admin |

Reads: `GET /api/assistant/drafts?entityId=`, `GET /api/assistant/reminders?scope=received|created[&page&pageSize]`,
`GET /api/assistant/reassessments?reportId=`.

### Drafts (`dbo."AssistantDrafts"`)

Private text, up to 8,000 characters:
- `REVIEW_NOTE` on a report: Maintenance/Admin
- `WORK_ORDER_UPDATE` on a WO the caller can open: work roles
- `CLARIFICATION_REPLY` on a handoff: procurement readers

A draft never writes a workflow table (tested with a fingerprint of Reports, Reviews, Requests, Work Orders, Handoffs and
Outcomes). The human pastes it into the real form and submits it there.

## 4. Guarded assessment regeneration

**Why a job table instead of `Reports.AgentStatus='PENDING'`:**
- `POST /api/maintenance/reports/:id/review` requires `AgentStatus='COMPLETED'`. Requeueing the report itself would block
  human review while the job runs.
- A failure would leave a `PENDING_REVIEW` report `FAILED`, which could then never be reviewed.

With `dbo."AssessmentRegenerationJobs"`, the current assessment stays reviewable the whole time. It's still a PostgreSQL
PENDING queue the Agent claims: the API never pushes to the Agent.

**Request:** `{ reportId, reason: 3..1000 chars, idempotencyKey, confirm }`. Limit `limits.aiGenerate` (30 per hour per
user, shared with maintenance-request regeneration); only confirmed requests count. The checks run in one transaction,
with the report row locked (`FOR UPDATE`, the same lock as the review route):

| Check | Result |
|---|---|
| Report missing | 404 `REPORT_NOT_FOUND` |
| Same `idempotencyKey` for the same report | 200, the original job. For another report: 409 `IDEMPOTENCY_KEY_REUSED` |
| `Status` not `PENDING_REVIEW`, or `AgentStatus` not `COMPLETED` (so a cancelled report can never be revived) | 409 `REPORT_NOT_REASSESSABLE` |
| Any non-cancelled `MaintenanceReviews` row, or the MR is no longer `DRAFT` | 409 `HUMAN_DECISION_EXISTS` |
| A `PENDING`/`PROCESSING` job exists (also a unique partial index) | 409 `REASSESSMENT_IN_PROGRESS`, `details.job` |
| 5 jobs already exist for the report | 409 `REASSESSMENT_LIMIT_REACHED` |
| Otherwise | 201 `{ job }`, plus `AuditLogs` `ASSESSMENT_REGENERATION_REQUESTED` |

**Statuses:** `PENDING → PROCESSING → COMPLETED | FAILED`, or `CANCELLED` (human) or `SUPERSEDED` (system).
- **A human decision wins.** Triggers mark active jobs `SUPERSEDED` as soon as the report leaves `PENDING_REVIEW` or a
  non-cancelled review row is written.
- **Terminal jobs are never revived.** Claim only takes `PENDING`, requeue only takes `PROCESSING`, and finish requires
  `PROCESSING` with the same attempt.

**History:** `GET /api/assistant/reassessments?reportId=` returns the jobs plus every `ReportAssessmentHistory`
attempt. Old attempts are kept.

### Agent claim contract (SQL functions; seefix-agents implements the caller)

| Function | Use |
|---|---|
| `dbo."ClaimNextAssessmentRegeneration"(worker text)` → `(JobId, ReportId, Attempt)` or no row | Oldest PENDING, `FOR UPDATE SKIP LOCKED`, `AttemptCount+1`. Ineligible jobs are SUPERSEDED on the way |
| `dbo."FinishAssessmentRegeneration"(jobId, attempt, ok, error)` → boolean | **First statement of the Agent's write transaction.** Locks the report, then the job (the review route's order, so no deadlock). `true` only if the job is `PROCESSING` with that attempt and the report is still reassessable |
| `dbo."RequeueStaleAssessmentRegenerations"(minutes)` → count | Stale `PROCESSING` → `PENDING` (or `FAILED` after 3 attempts) |
| `dbo."IsReportReassessable"(reportId)` → boolean | The single eligibility rule used by all of the above |

**The Agent's write after `FinishAssessmentRegeneration(...)` returns `true` with `ok`:** in the same transaction, it
updates the assessment columns and inserts `ReportAssessmentHistory` with
`AgentAttemptCount = Reports.AgentAttemptCount + 1`, bumping `Reports.AgentAttemptCount`.
- It never writes `Status`. `AdvanceReportAfterAgentAssessment` only acts on `SUBMITTED`.
- The `reports` cache domain is bumped by the existing triggers.

**When it returns `false`:** the Agent discards its result. The causes are a late attempt, a cancellation, a
supersede, or a human decision.

**A failure** (`ok = false`) only marks the job; the report is never touched.

## 5. Persistent reminders (`dbo."AssistantReminders"`)

`POST /api/assistant/reminders { recipientUserId?, title, message?, dueAt, timeZone, entity?: { type, id }, idempotencyKey, confirm }`

- **`title` and `message`:** `title` is 1–250 characters; `message` is up to 2,000.
- **Time:**
  - `timeZone` must be an IANA zone from `pg_timezone_names`; otherwise 400 `INVALID_TIME_ZONE`.
  - `dueAt` is a local `YYYY-MM-DDTHH:mm[:ss]` read in `timeZone`, or an ISO instant with `Z` or an offset (kept as
    given).
  - PostgreSQL converts it (`AT TIME ZONE`), and it's stored as UTC `DueAt`/`NextRunAt`. `TimeZone` is kept for
    display.
  - **DST:** a local time in a spring-forward gap moves forward (`2027-03-14T02:30` New York → `07:30Z`, which is 03:30
    EDT). An ambiguous fall-back time takes the later, standard-time occurrence (`2026-11-01T01:30` → `06:30Z`).
  - It must be in the future and within 366 days; otherwise 400 `INVALID_DUE_AT`.
- **Recipient:**
  - Self always.
  - `MAINTENANCE_SUPERVISOR` → also `MAINTENANCE_STAFF` and `WORKER`.
  - `ADMIN` → any active internal user.
  - Never a REPORTER or an inactive account.
  - Unknown, inactive and out-of-policy recipients all get 403 `REMINDER_RECIPIENT_FORBIDDEN` (no account probing).
- **Entity:** must be readable by the creator (detail-route status) **and** by the recipient
  (403 `REMINDER_ENTITY_FORBIDDEN`), so a reminder can't leak a record.
- **Limit:** at most 50 active reminders per creator (409 `REMINDER_LIMIT_REACHED`; a per-creator advisory lock prevents
  races).
- **Audit:** create and cancel write `AuditLogs` rows `ASSISTANT_REMINDER_CREATED` / `ASSISTANT_REMINDER_CANCELLED`.
- **Cancel:** by the creator or the recipient, from `SCHEDULED`, `PROCESSING` or `FAILED`. A repeat is a 200 no-op.
  `SENT` gives 409 `REMINDER_ALREADY_SENT`. Anyone else gets 404.

### Worker claim contract (seefix-worker#3 delivers)

| Column | Meaning |
|---|---|
| `Status` | `SCHEDULED → PROCESSING → SENT`, or back to `SCHEDULED` on failure, `FAILED` after 5 attempts, `CANCELLED` |
| `NextRunAt` | when it may next be claimed (UTC) |
| `Attempts` | claim counter; the fencing token |
| `ClaimedAt` / `ClaimedBy` | lease |

1. **Claim:** `SELECT * FROM dbo."ClaimDueAssistantReminders"(worker, batch, leaseSeconds)`.
   - It takes `SCHEDULED` rows with `NextRunAt <= now()`, plus `PROCESSING` rows whose lease (`ClaimedAt`) is older than
     `leaseSeconds`. That's how missed reminders are recovered after a Worker outage.
   - `SKIP LOCKED`, `Attempts+1`.
   - A due reminder whose recipient is now inactive or a REPORTER becomes `CANCELLED` (`RECIPIENT_INACTIVE`) and isn't
     returned.
2. **Deliver**, per row, in **one transaction**:
   - `createNotification(client, { userId: RecipientUserId, type: "ASSISTANT_REMINDER", title: Title, message: Message ?? Title, entityType, entityId, deduplicationKey: "assistant-reminder:" + Id })`.
     This also writes the `notification.created` Outbox row. The dedupe key makes a replay a no-op.
   - `SELECT dbo."FinishAssistantReminder"(Id, Attempts, true, null, notificationId)`.
   - If that returns `false`, **roll back**: the reminder was cancelled or re-claimed by another Worker.
3. **Failure:** `FinishAssistantReminder(Id, Attempts, false, error, null)`. The reminder goes back to `SCHEDULED` with
   `NextRunAt = now() + 2^Attempts minutes` (at most 60), and becomes `FAILED` after 5 attempts.

Only the recipient is notified; the payload carries ids only. Reminders are not a cache domain. Notifications already
reach clients through the Outbox and `notification.created`.

## 6. Tests and evidence (local PostgreSQL 16 copy `seefix_v2_dev`; no production)

- **Migration:** applied twice, rolled back, and re-applied. The schema dump after re-apply is byte-identical, and
  nothing is left after the rollback.
- **`tests/assistant.test.js`** (no database):
  - the prohibited list and pattern for every role
  - unknown actions
  - the confirmation gate
  - the recipient policy
  - Agent answer sanitizing (foreign ids and paths dropped) and the fallback
  - navigation per role
- **`tests/agent-queue-contract.test.js`:** the assistant uses only `assistantRespond`; reassessment is a queue insert.
- **`tests/assistant.live.test.js`** (`SEEFIX_INTEGRATION_DB=1`; creates and deletes its own users, reports and rows):
  - the RBAC matrix
  - record tools equal the detail routes' 200/403/404 for 5 roles × reports, WOs and handoffs; no personal data in facts
  - prohibited actions: 403 for 5 roles × 7 actions, workflow fingerprint unchanged
  - reassessment:
    - preview writes nothing
    - 10 concurrent requests → exactly 1 job
    - idempotent replay, including concurrent replays
    - key reuse → 409
    - stale claim requeued → the late attempt-1 result is refused, attempt 2 lands
    - cancel is never claimed or revived
    - cancel while running → finish refused
    - a real NO_ACTION review supersedes the running job; the late result can't overwrite it
    - a pending review → `HUMAN_DECISION_EXISTS`
    - limit
    - audit
  - reminders:
    - recipient policy, including reporter and unknown users
    - entity readable by both
    - Manila, offset, DST gap and ambiguous conversions
    - invalid input
    - 5 concurrent same-key requests → 1 row
    - cancel rules
    - Worker claim, live-lease skip, lease-expiry takeover, late finish refused, failure backoff
    - delivery with Notification + Outbox in one transaction, recipient only
    - cancel while processing
    - inactive recipient cancelled
  - drafts: kind/role check, private, no workflow write
  - ask: the WORKER's facts are scoped to their own WOs; Agent down → 200 `FALLBACK`; a foreign context → 403
  - a credentials change → 401 `SESSION_REVOKED`
