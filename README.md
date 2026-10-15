# SEEFIX API — Node.js / Express Business API

SEEFIX is an AI-assisted maintenance prioritization and workflow system. This service is the authenticated business API between the Reporter/Maintenance/Procurement/Worker clients, PostgreSQL, Cloudinary, and the protected `seefix-agents` FastAPI service.

## Current workflow

```text
Reporter submits report + images
        ↓
SEEFIX Agent assessment
        ↓
Deterministic priority / triage queue
        ↓
Maintenance Review
        ├── INTERNAL
        │      ↓
        │   Work Order PENDING_ASSIGNMENT
        │      ↓
        │   human assignment / dispatch
        │
        ├── PROCUREMENT
        │      ↓
        │   Procurement handoff
        │      ↓
        │   UC Procurement process outside SEEFIX
        │      ↓
        │   Procurement Outcome
        │      ↓
        │   Work Order PENDING_ASSIGNMENT
        │      ↓
        │   human assignment / dispatch
        │
        ├── NO_ACTION
        └── DUPLICATE

ASSIGNED → IN_PROGRESS → completion evidence
        ↓
AI completion assistance
        ↓
Maintenance Supervisor COMPLETE or REWORK
```

AI assesses, prioritizes, drafts, compares, warns, and monitors. Human-authorized roles own routing, assignment, Procurement decisions, work execution, and final completion acceptance.

## Roles

- `REPORTER`
- `MAINTENANCE_STAFF`
- `MAINTENANCE_SUPERVISOR`
- `PROCUREMENT`
- `WORKER`
- `ADMIN`

## Main API groups

- `/api/auth` — registration, email verification, login (email or username), password reset, account changes (profile, username, email, password).
- `/api/reports` — report submission, Reporter list/detail, independent verification, Agent state.
- `/api/reference` — active buildings and configured facility locations.
- `/api/notifications` — persistent user notifications.
- `/api/maintenance` — priority/review queues, Maintenance Review, Procurement clarification response, completion/rework authority.
- `/api/procurement` — Procurement inbox, acknowledgement/start, clarification, documents, Procurement Outcome.
- `/api/work-orders` — dispatch/assignment, execution status, people/materials, completion evidence and completion-Agent state.
- `/api/admin` — user management.
- `/api/admin/knowledge` — damage-category, skill and material reference configuration.
- `/api/uploads` — signed direct-to-Cloudinary uploads (`POST /api/uploads/sign`).
- `/api/realtime` — Pusher config, private-channel auth, and the protected outbox dispatch endpoint.
- `GET /health` — API, database and Agent status.

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Git | any | to clone the repo |
| Node.js | 20 or newer (22 LTS recommended) | `node -v` |
| PostgreSQL | 13+ (local) or a Neon project | holds the SEEFIX `dbo` schema; `psql`/`pg_restore` to load it |
| SEEFIX database backup | `seefix-dbo-<date>.sql` | ask the project owner for the latest schema + setup data backup |
| Cloudinary account | — | report, work order and procurement files |
| SMTP account | — | verification and password-reset emails |
| `seefix-agents` | running, optional for first start | AI assessment; reports are still accepted while it is down |
| Pusher app | optional | live updates; without it clients poll |

## Setup (step by step)

1. **Clone and install**
   ```powershell
   git clone https://github.com/seefixmanagement/seefix-api.git
   cd seefix-api
   npm ci
   ```
2. **Create the database** (skip if you use an existing SEEFIX database). Local PostgreSQL example:
   ```powershell
   createdb -U postgres seefixdb
   pg_restore --no-owner --no-privileges -U postgres -d seefixdb seefix-dbo-<date>.sql
   ```
   For Neon, restore with the **direct** (non-`-pooler`) host; see [docs/SYSTEM_SETUP.md](docs/SYSTEM_SETUP.md#1-database-).
3. **Apply the migrations** in `db/migrations/` that the backup doesn't include yet, oldest first. Each is safe to run twice:
   ```powershell
   psql "<DATABASE_URL>" -f db/migrations/2026-10-14-report-client-id.sql
   ```
4. **Configure `.env`**
   ```powershell
   copy .env.example .env      # cp on Linux/macOS
   ```
   Then set at least:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | the database from step 2. The **same** database is used by `seefix-agents` and `seefix-worker` |
   | `JWT_SECRET` | random, 32+ characters (generate below) |
   | `OTP_PEPPER` | random, 32+ characters. **Required, not in `.env.example`: add it** |
   | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | your mail provider. **Not in `.env.example`: add them** |
   | `LOCAL_AGENT_URL`, `LOCAL_AGENT_SECRET` | Agent address and key; the key must equal `SEEFIX_AGENT_API_KEY` in `seefix-agents` |
   | `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | your Cloudinary account |
   | `CORS_ORIGINS` | browser origins that call the API directly, e.g. `http://localhost:4200` (mobile app in the browser) |

   Generate secrets with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.
   Never reuse the sample values from `.env.example`. The app refuses to start and lists anything missing.
5. **Check the code and the database**
   ```powershell
   npm run check        # syntax
   npm test             # unit tests
   npm run verify:db    # read-only check of the database contract
   ```
6. **Create the test login accounts** (optional): add `SEEFIX_RBAC_PASSWORD=<8+ characters>` to `.env`, then
   ```powershell
   node scripts/seed-rbac-users.js
   ```
   It creates one account per role: `reporter@`, `maintenance.staff@`, `maintenance.supervisor@`, `procurement@`,
   `worker@` and `admin.test@seefix.local`, all with that password.
7. **Start**
   ```powershell
   npm run dev          # auto-restarts on file changes
   npm start            # plain start (run_windows.bat does install + check + start)
   ```
   Open `http://127.0.0.1:3000/health`: expect `"status":"ok"`. `agent.reachable` is `false` until `seefix-agents` runs.

No static UI is served. For the whole system (Agent host, worker, realtime, hosting) see [docs/SYSTEM_SETUP.md](docs/SYSTEM_SETUP.md);
for Vercel see [docs/VERCEL_DEPLOY.md](docs/VERCEL_DEPLOY.md). Production: `https://seefix-api.vercel.app`
(every push to `main` deploys).

### Other scripts

| Command | Purpose |
|---|---|
| `npm run test:rbac` | role-permission acceptance run against a running API (`SEEFIX_RBAC_BASE_URL`, default `http://127.0.0.1:3000`; uses the seeded accounts) |
| `npm run outbox:dispatch` | stand-alone OutboxEvents → Pusher dispatcher (see docs/REALTIME_ROLLOUT.md) |
| `node scripts/smoke-report-idempotency.js` | live smoke test of offline report submission (`clientReportId`); set `SMOKE_API` and the variables listed at the top of the script |

## Report upload

`POST /api/reports` uses Bearer JWT and JSON; images are uploaded straight to Cloudinary first (see `POST /api/uploads/sign`).
Older clients may still send `multipart/form-data` with `images` instead of `imagePublicIds` (see docs/API_ENDPOINTS.md).

- `imagePublicIds` — array of 1–5 Cloudinary public IDs from `purpose: "report-image"` uploads (JPEG/PNG/WebP, ≤ 10 MB each), required.
- `locationId` — optional configured `FacilityLocations.Id`.
- `building`, `floor`, `roomOrArea` — optional fallback/snapshot location text when no configured location is selected.
- `description`, `notes`, `gpsLat`, `gpsLng` — optional.

After the report and images commit, the report waits in PostgreSQL as `AgentStatus=PENDING`. The API does **not** call `seefix-agents`: the Agent claims pending work from the database, and `seefix-worker`'s `agent-retry` job re-queues failed attempts. A report is therefore accepted even while the Agent is down. Completion evidence works the same way (`CompletionAgentStatus=PENDING`).

## Human authority boundaries

- Maintenance Staff/Supervisor: review prioritized reports and choose `INTERNAL`, `PROCUREMENT`, `NO_ACTION`, or `DUPLICATE`.
- Maintenance Staff/Supervisor: assign/dispatch Work Orders.
- Procurement: manage the SEEFIX handoff and record the final outcome only; bidding/provider selection remains outside SEEFIX.
- Responsible worker/maintenance party: start work, record progress, parts/hold state, materials, people, and completion evidence.
- Maintenance Supervisor: answer Procurement clarifications and make final complete/rework decisions.

Work Orders begin at `PENDING_ASSIGNMENT`; the previous `PENDING_CONFIRMATION → CONFIRMED` gate no longer exists.

## Security

- JWT authentication and role middleware protect business endpoints.
- `LOCAL_AGENT_SECRET` is server-only and must never be sent to clients.
- Report and Work Order images are restricted to supported image MIME types.
- Database writes use parameterized SQL.
- Keep `.env` out of source control and use TLS/production secrets for deployment.
