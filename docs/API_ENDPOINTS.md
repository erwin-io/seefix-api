# SEEFIX API Endpoint Map

All `/api/*` routes return JSON. Protected routes use `Authorization: Bearer <JWT>`.

## Authentication
- `POST /api/auth/register` — public Reporter registration.
- `POST /api/auth/login` — login for every SEEFIX role.
- `GET /api/auth/me` — current authenticated user.

## Uploads (direct to Cloudinary)
Files never pass through the API (so Vercel's 4.5 MB body limit doesn't apply):
1. `POST /api/uploads/sign` with `{ "purpose": "report-image" | "completion-image" | "procurement-document" }` returns
   `{ uploadUrl, fields, maxBytes, allowedFormats, expiresAt }`. Limits: images 10 MB (JPEG/PNG/WebP), documents 15 MB.
2. The client POSTs each file to `uploadUrl` as multipart: every entry of `fields` plus `file`. The signature (valid
   1 hour) fixes the folder, formats and tags, so they can't be changed.
3. The client sends the resulting `public_id`s to the endpoint below. The API checks each upload in Cloudinary
   (uploader, purpose, type, size, not already used) before saving it, and locks each ID inside the saving
   transaction so concurrent requests can't attach the same upload twice (the second gets 409 `UPLOAD_ALREADY_USED`).

**Legacy multipart** (clients released before direct uploads) still works on the same three endpoints: `images`
(reports, completion) or `file` (documents), same type and size limits. Requests through Vercel are capped at 4.5 MB
in total. A request uses one format; sending both is a 400. To be removed once every installed client is updated.

Uploads never attached to a record are removed later by seefix-worker's `upload-cleanup` job.

## Reporter / reports
- `POST /api/reports` — JSON with `imagePublicIds` (1–5 `report-image` uploads), or legacy multipart `images`.
- `GET /api/reports/my` — current user's reports.
- `GET /api/reports/:id` — report detail.
- `GET /api/reports/:id/agent-status` — Agent progress, read from the database (the Agent writes it there; the API never calls the Agent for it).
- `POST /api/reports/:id/verifications` — independent corroboration; owner self-verification is blocked.

## Notifications
- `GET /api/notifications`
- `POST /api/notifications/:id/read`
- `POST /api/notifications/read-all`

## PPO
- `GET /api/ppo/action-center`
- `GET /api/ppo/reports`
- `POST /api/ppo/reports/:id/verify-request-maintenance` — PPO Staff human gate. Stores final classification and authorizes the Maintenance Request.
- `POST /api/ppo/procurement/clarifications/:id/respond` — PPO Head human clarification response.
- `POST /api/ppo/work-orders/:id/confirm` — PPO Head human Work Order confirmation after deterministic readiness review.
- `POST /api/ppo/work-orders/:id/complete` — PPO Head human close-out.
- `POST /api/ppo/work-orders/:id/rework` — PPO Head rework decision.

## Procurement bridge
- `GET /api/procurement/inbox`
- `GET /api/procurement/handoffs/:id`
- `POST /api/procurement/handoffs/:id/acknowledge`
- `POST /api/procurement/handoffs/:id/start`
- `POST /api/procurement/handoffs/:id/clarifications`
- `POST /api/procurement/handoffs/:id/documents` — JSON `{ publicId, resourceType, fileName?, mimeType?, documentType?, clarificationId? }` from a `procurement-document` upload, or legacy multipart `file`.
- `POST /api/procurement/handoffs/:id/outcome` — records only final execution facts; no bidding/provider ranking.

## Work Orders
- `GET /api/work-orders`
- `GET /api/work-orders/:id`
- `POST /api/work-orders/:id/start`
- `POST /api/work-orders/:id/status`
- `POST /api/work-orders/:id/updates`
- `POST /api/work-orders/:id/people`
- `POST /api/work-orders/:id/materials`
- `POST /api/work-orders/:id/completion` — completion evidence: JSON (`repairNotes`, `imagePublicIds` from `completion-image` uploads, …) or legacy multipart `images`; saves `CompletionAgentStatus=PENDING` for the Agent to claim (no direct Agent call).
- `GET /api/work-orders/:id/completion-status` — completion-Agent progress, read from the database.

## Admin
- `GET /api/admin/users`
- `POST /api/admin/users`

## Health
- `GET /health` — PostgreSQL + Agent health.
