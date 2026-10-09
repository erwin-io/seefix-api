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

- `/api/auth` — registration, login, current user.
- `/api/reports` — report submission, Reporter list/detail, independent verification, Agent state.
- `/api/reference` — active buildings and configured facility locations.
- `/api/notifications` — persistent user notifications.
- `/api/maintenance` — priority/review queues, Maintenance Review, Procurement clarification response, completion/rework authority.
- `/api/procurement` — Procurement inbox, acknowledgement/start, clarification, documents, Procurement Outcome.
- `/api/work-orders` — dispatch/assignment, execution status, people/materials, completion evidence and completion-Agent state.
- `/api/admin` — user management.
- `/api/admin/knowledge` — damage-category, skill and material reference configuration.

## Setup

1. Configure `.env`. Node and `seefix-agents` must use the same canonical PostgreSQL database and shared Agent secret.
2. Install dependencies:

   `npm install`

3. Validate:

   `npm run check`
   `npm test`
   `npm run verify:db`

4. Start:

   `npm start`

No static UI is served.

## Report upload

`POST /api/reports` uses Bearer JWT and `multipart/form-data`.

- `images` — one or more JPEG/PNG/WebP files, required.
- `locationId` — optional configured `FacilityLocations.Id`.
- `building`, `floor`, `roomOrArea` — optional fallback/snapshot location text when no configured location is selected.
- `description`, `notes`, `gpsLat`, `gpsLng` — optional.

After the report and images commit, Node best-effort triggers `seefix-agents`. PostgreSQL remains the durable queue, so a failed HTTP trigger does not lose the report.

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
