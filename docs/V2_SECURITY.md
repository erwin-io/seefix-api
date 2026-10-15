# Web Admin V2: rate limiting, throttling and SQL-injection audit

Scope of [seefix-api#19](https://github.com/seefixmanagement/seefix-api/issues/19), part of the Web Admin V2 epic.
Minimal and focused: JWT/RBAC are unchanged, and only the missing protections were added.

## 1. What already existed (kept as is)

| Protection | Where |
|---|---|
| Bearer JWT; the user, role, active state and session version are re-read on every request | `src/middleware/auth.js` |
| Role checks on every business route | `requireRoles(...)` in routes |
| OTP issue limits: 1 per minute and 5 per hour per user and purpose | `src/services/account-challenges.js` |
| OTP guessing: a limited number of attempts per challenge, then the challenge is dead | `consumeChallenge` |
| Generic reset/verification responses (no account enumeration) | `src/routes/auth.js` |
| Request body limit 2 MB; uploads go straight to Cloudinary through signed uploads | `src/app.js`, `src/routes/uploads.js` |

## 2. Added rate limits

**Shared** limits are stored in `dbo."RateLimitBuckets"` (migration `db/migrations/2026-10-16-v2-rate-limits.sql`):
one atomic `INSERT … ON CONFLICT DO UPDATE` per checked request, so they hold across every Vercel instance. Account
identifiers are SHA-256 hashed and normalized (trimmed, lowercased) before they become keys; raw emails are never
stored. Over the limit the API returns `429`, code `RATE_LIMITED`, with a `Retry-After` header in seconds.

| Policy | Routes | Shared limits |
|---|---|---|
| Sign in | `POST /api/auth/login` | 10 / 15 min per account (identifier, email or username, normalized), 60 / 15 min per IP |
| Register | `POST /api/auth/register` | 20 / hour per IP |
| Code requests | `POST /api/auth/forgot-password`, `/resend-verification` | 10 / hour per email address (also addresses with no account), 30 / hour per IP |
| Code checks | `POST /api/auth/verify-email`, `/reset-password`, `/me/change-email/confirm` | 15 / 15 min per email address, 60 / 15 min per IP (bounds guessing across re-issued codes) |
| Current-password checks | `PATCH /api/auth/me/username`, `POST /me/change-password`, `/me/change-email` | 10 / 15 min per signed-in user (a stolen token can't brute-force the password) |
| AI generation | `POST /api/maintenance/reports/:id/maintenance-request/regenerate` | 30 / hour per user (one shared AI host). Search (#20) and assessment regeneration (#21) will reuse `sharedRateLimit` |

**Why the IP limits are generous:** many staff can share one address, such as an office network or the web admin's
`/api` proxy. The strict limits are per account, so one attacker can't lock a whole office out of signing in.

**General throttle, best effort:** at most 600 requests per minute per signed-in user, per instance (`userThrottle`,
run inside `requireAuth`).
- **Why it's per instance:** Vercel instances don't share memory. That's accepted here because this throttle stops
  runaway loops; it isn't a security boundary.
- **Large tables still load:** 600 per minute allows loading a 10,000-row table (20 pages of 500) 30 times a
  minute. The memory map is bounded (50,000 keys).

**Client IP:**
- On Vercel: `x-vercel-forwarded-for`. Vercel's edge sets it and overwrites anything the client sent.
- Elsewhere: Express `req.ip` with `trust proxy` 1.
- A client-sent `X-Forwarded-For` is never trusted on Vercel.

**Before the migration is applied:** shared limits are skipped, and the routes behave exactly as before. Any other
database error fails the request; it's never silently allowed.

## 3. SQL-injection audit (main @ 75b76d9)

- **All values are bound parameters** (`$1…`), checked across `src/routes`, `src/services`, `src/realtime` and
  `scripts`.
- **Dynamic identifiers,** each reviewed:
  - `src/routes/admin-knowledge.js` (category PATCH): column names come from a fixed server-side map. Request keys
    only select entries in that map.
  - `src/routes/auth.js` (`PATCH /me`): column names come from a fixed field list; values are parameters.
  - `src/realtime/outbox-dispatcher.js`: `${table}` is the internal constant `"dbo"."OutboxEvents"`. It's overridden
    only by tests and never comes from a request.
  - `ORDER BY`: every clause is a fixed literal. No route sorts by a request value.
- **Request-driven filters** (`status`, `triage`) are bound parameters or allowlisted (`triage` →
  `all|actionable|screening`, otherwise `400`).
- **New V2 endpoints** (search, analytics, paging) must follow the same rules: values as parameters; any sortable
  column or type filter mapped through a server-side allowlist. Paging input is validated by
  `src/utils/pagination.js` (#18).

**Findings:** no injectable SQL found. No code change was needed beyond these notes.

## 4. Tests

- **`tests/rate-limit.test.js`** (no database):
  - 429, `RATE_LIMITED` and `Retry-After`
  - separate budgets per account
  - limits skipped before the migration; other database errors fail
  - memory window, its reset and its key bound
  - a 10k-row table load is not throttled
  - Vercel IP handling ignores spoofed `X-Forwarded-For`
  - hashed, normalized identifiers
- **`tests/security.live.test.js`** (`SEEFIX_INTEGRATION_DB=1`):
  - 40 concurrent increments yield exactly 1..40, and an expired window restarts at 1
  - the 11th sign-in attempt for one account returns 429 with `Retry-After`, including through the `email` and
    `username` fields and other casing
  - `' OR 1=1 --` and `'; DROP TABLE …` in `status` are just data (200, no rows), and in `triage` they return 400
  - the Users table is intact afterwards

Secrets: none are logged. Rate-limit keys contain only a policy name and a hashed or IP subject.
