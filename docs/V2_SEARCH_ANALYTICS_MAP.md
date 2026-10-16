# Web Admin V2: universal search, analytics and campus map APIs

Contract for [seefix-api#20](https://github.com/seefixmanagement/seefix-api/issues/20), consumed by
seefix-web-admin#19 (Spotlight search) and #20 (dashboards and map). Migration:
`db/migrations/2026-10-16-v2-search-buildings.sql` (additive, idempotent, rollback included; run after the cache
versions migration).

## 1. `GET /api/search?q=&types=&limit=`

- **Who:** staff roles only (Reporter → 403).
- **Caching:** not cached (`no-store`).
- **Throttle:** 120 requests per minute per user, per instance.
- **Validation:**
  - `q`: 2–100 characters after trimming; otherwise `400 INVALID_QUERY`.
  - `limit`: results per group, 1–20, default 5; otherwise `400 INVALID_LIMIT`.
  - `types`: optional comma list; an unknown type gives `400 INVALID_TYPES`.
- **Literal matching:** the text is matched case-insensitively and literally. `%`, `_` and `\` are escaped, and
  every value is a bound parameter.

```json
{ "q": "stair", "groups": [ { "type": "reports", "label": "Reports",
  "items": [ { "id": "…", "title": "RPT-2026-000039", "subtitle": "PENDING_REVIEW · Old Building · …", "route": "/reports/…" } ] } ] }
```

Only groups with results are returned. `route` is a web-admin path the caller may open. It is `null` for buildings,
which have no detail page yet.

| Role | Types it can search | Row scope (same rule as the detail route) |
|---|---|---|
| ADMIN | reports, maintenance_requests, work_orders, procurement, action_items, users, buildings | all |
| MAINTENANCE_SUPERVISOR / STAFF | the same, except users | all; Staff's action items limited to their assigned role |
| PROCUREMENT | reports, procurement, buildings | reports only when linked to a procurement handoff |
| WORKER | reports, work_orders, buildings | work orders they lead, and those work orders' reports |

Types a role can't read are dropped silently, so requesting them leaks nothing. Matched fields:
- **Reports:** number, description and building text.
- **Maintenance requests:** number and scope of work.
- **Work orders:** number, assigned party and lead name.
- **Handoffs:** number and external reference.
- **Action items:** reference and summary.
- **Users:** name, email and username.
- **Buildings:** name and code.

`pg_trgm` GIN indexes cover the report, work order, handoff, request and user expressions. With sequential scans
disabled, the plan uses `Bitmap Index Scan on "IX_Reports_Search_Trgm"` (printed by the live test). On the tiny local
dataset the planner otherwise prefers a sequential scan, which is expected.

## 2. `GET /api/analytics/overview?from=YYYY-MM-DD&to=YYYY-MM-DD`

The default range is the last 30 days. `to` is inclusive, the maximum span is 366 days, and invalid or rolled-over
dates (e.g. `2026-02-30`) return `400 INVALID_DATE`. The response is cached through the domain versions, per user.

| Section | Roles | Definition (one SQL aggregate each) |
|---|---|---|
| `reports` | Admin, Maintenance | Reports with `CreatedAt` in range, broken down by current status, by effective category (`v_ReportPriorityLive`) and per UTC day |
| `queueAging` | Admin, Maintenance | Reports **now** `PENDING_REVIEW`, by age (`<1d`, `1–3d`, `3–7d`, `>7d`); not range-bound |
| `workOrders` | Admin, Maintenance; WORKER sees only work orders they lead | All work orders by current status. Completed = `COMPLETED` with `ResolvedAt` in range. Turnaround = `ResolvedAt − AssignedAt` in hours (average and p50). Rework rate = share of completed work orders with any status-history move to `REWORK_REQUIRED` |
| `procurement` | Admin, Maintenance, Procurement | Handoffs by current status; open = not `COMPLETED`/`CANCELLED`; overdue = open with `ExpectedResponseAt < now`; completed = `CompletedAt` in range; average days = `CompletedAt − SubmittedAt` |
| `agent` | Admin, Maintenance | Reports created in range: by `AgentStatus`; retried = `AgentAttemptCount > 1`; latency p50/p95 = `AgentCompletedAt − CreatedAt` for `COMPLETED`; `failedOpen` = **now** `FAILED` and `SUBMITTED` |

The live test compares the API's numbers with direct SQL for reports created, queue aging total, completed work
orders and `failedOpen`.

## 3. Building geometry (Admin)

`dbo."Buildings"` gains these columns:

| Column | Meaning |
|---|---|
| `DefaultLat` / `DefaultLng` | the building's default pin |
| `Perimeter` | JSON `[[lat, lng], …]`, 3–200 points |
| `ToleranceMeters` | 0–1000, default 25 |
| `GeometryRevision` | revision number of the geometry |
| `GeometryUpdatedAt` / `GeometryUpdatedBy` | when and by whom the geometry last changed |

Every geometry change is recorded in `dbo."BuildingGeometryHistory"`. Building edits bump the `reference` cache
domain through the existing triggers.

| Endpoint | Notes |
|---|---|
| `GET /api/admin/buildings` | All buildings with geometry |
| `POST /api/admin/buildings` | Required: `code`, `name`. Optional: `description`, `sortOrder`, default pin, `perimeter`, `toleranceMeters`, `reason`. Creates revision 1 and its history row |
| `PATCH /api/admin/buildings/:id` | Any of: `name`, `description`, `isActive`, `sortOrder`, default pin, `perimeter`, `toleranceMeters`, `reason`. A geometry change bumps the revision and adds a history row. Send `geometryRevision` to get `409 GEOMETRY_CONFLICT` if someone else changed the geometry. A rename is not a geometry change. Invalid geometry returns `400 INVALID_GEOMETRY` |
| `GET /api/admin/buildings/:id/geometry-history` | Revisions, newest first, with reason and who changed them |

## 4. `GET /api/map`

- **Who:** Admin and Maintenance see all active reports and active work orders. WORKER sees only the work orders they
  lead, with no report markers. Procurement and Reporter get 403.
- **Active** means: reports not RESOLVED, NO_ACTION, DUPLICATE or CANCELLED; work orders not COMPLETED or CANCELLED.

```json
{ "buildings": [ { "id": "…", "name": "Old Building", "defaultLat": 14.6, "defaultLng": 121.0, "perimeter": [[…]],
                   "toleranceMeters": 25, "geometryRevision": 2, "counts": { "reports": 3, "workOrders": 1 } } ],
  "markers": [ { "kind": "REPORT", "id": "…", "no": "RPT-…", "status": "PENDING_REVIEW", "category": "…", "urgency": "High",
                 "buildingId": "…", "buildingName": "Old Building", "buildingMatch": "LOCATION",
                 "location": { "source": "BUILDING_DEFAULT", "lat": 14.6, "lng": 121.0,
                               "rawGps": { "lat": 14.7, "lng": 121.1 }, "gpsCheck": "OUTSIDE", "gpsDistanceMeters": 1234.5 },
                 "route": "/reports/…" } ] }
```

**Building link (`buildingMatch`):**
- `LOCATION`: the report's configured facility location.
- `NAME`: an exact, case-insensitive building name or code match.
- `NONE`: no link.

The link is computed for display only and never written back to the report.

**Display location (`location.source`)**, by the pure function `services/geo.js#effectiveLocation`:
- `CORRECTED`: maintenance saved a map location for the report (§4.2). `location.correction` says who, when, why.
- `GPS`: the report's GPS when the building has no perimeter, or when the GPS is inside it or within its tolerance.
- `BUILDING_DEFAULT`: the building's location when GPS is missing or outside the perimeter: its default pin, or the
  centre of its perimeter when it has no pin (`location.defaultFrom`: `PIN` or `PERIMETER_CENTER`).
- `NONE`: not pinned. The marker still appears in the table view.

`rawGps` is always the report's untouched coordinates. `gpsCheck` explains the provenance: `INSIDE`,
`WITHIN_TOLERANCE`, `OUTSIDE`, `NO_GPS`, `NO_PERIMETER` or `NO_BUILDING`.

**GPS accuracy:** the Reporter app doesn't send accuracy today (no new mobile features in V2), so tolerance is the
only reliability control. Adding accuracy would be a separate, additive Reporter change.

The response also carries `campus` (§4.1), the area every campus map stays inside.

### 4.1 Campus map area: `GET/PUT /api/admin/campus-settings` (ADMIN)

`{ "centerLat": 10.326321, "centerLng": 123.954995, "radiusMeters": 600, "minZoom": 16 }`. Maps open at the centre,
can't be panned outside the circle (`radiusMeters`, 100–5000) and can't zoom out past `minZoom` (10–18). Stored in
`dbo."SystemSettings"` key `campus.map` (no migration); until an admin saves it, these defaults apply (`isDefault`).
A save is audited (`CAMPUS_MAP_SETTINGS_UPDATED`) and refreshes open maps (the `reference` cache domain).

### 4.2 One report's map location: `GET /api/map/reports/:id`, `PUT|DELETE /api/map/reports/:id/location`

- **GET** (map roles; same 404/403 rule as the report detail): `{ report, building, location, suggestion, campus,
  canCorrect }`. Only this report; no other markers.
- **PUT** (ADMIN, MAINTENANCE_SUPERVISOR, MAINTENANCE_STAFF) `{ lat, lng, source: "MANUAL"|"BUILDING", buildingId?,
  reason? }`: saves where the map shows the report. The point must be inside the campus area (400 `OUTSIDE_CAMPUS`).
  **DELETE** removes it (back to GPS / building location). Both are audited (`REPORT_MAP_LOCATION_SET|CLEARED`).
- Stored in `dbo."ReportLocationCorrections"` (migration `2026-10-17-report-map-location.sql`), never in
  `dbo."Reports"`: raw GPS and the building text stay as submitted.
- `suggestion` ("Use … location"): the linked building's location, else the single building whose name or code loosely
  matches the report's building text (`old bldg.` → Old Building). Deterministic; no AI. `null` when unsure.

## 5. Evidence (local PostgreSQL 16 copy, no production)

- **Migration:** applied twice without errors.
- **`tests/geo-search.test.js`:**
  - inside, outside and edge-within-tolerance cases, and tolerance 0
  - display-location fallbacks; raw GPS preserved
  - perimeter validation
  - LIKE escaping
  - date range, including rollover
- **`tests/search-analytics-map.live.test.js`:**
  - the RBAC matrix for 6 roles across search, analytics, map and admin buildings
  - procurement and worker search rows match their detail-route rules
  - injection and `%%` match nothing
  - analytics equal direct SQL; procurement and worker sections are scoped
  - building create, revision, 409 on a stale revision, invalid geometry 400, rename keeps the revision, history order
  - map active counts equal SQL; worker map scoped to their own work orders
  - trigram index plan
- **Full suite:** `SEEFIX_INTEGRATION_DB=1 npm test` → 133 pass.
