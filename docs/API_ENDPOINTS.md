# SEEFIX API Endpoint Map

All `/api/*` routes return JSON. Protected routes use `Authorization: Bearer <JWT>`.

## Authentication
- `POST /api/auth/register` — public Reporter registration.
- `POST /api/auth/login` — login for every SEEFIX role.
- `GET /api/auth/me` — current authenticated user.

## Reporter / reports
- `POST /api/reports` — multipart report submission; `images` is required.
- `GET /api/reports/my` — current user's reports.
- `GET /api/reports/:id` — report detail.
- `GET /api/reports/:id/agent-status` — Agent state with DB fallback.
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
- `POST /api/procurement/handoffs/:id/documents`
- `POST /api/procurement/handoffs/:id/outcome` — records only final execution facts; no bidding/provider ranking.

## Work Orders
- `GET /api/work-orders`
- `GET /api/work-orders/:id`
- `POST /api/work-orders/:id/start`
- `POST /api/work-orders/:id/status`
- `POST /api/work-orders/:id/updates`
- `POST /api/work-orders/:id/people`
- `POST /api/work-orders/:id/materials`
- `POST /api/work-orders/:id/completion` — multipart completion evidence; queues Completion Agent.
- `GET /api/work-orders/:id/completion-status`

## Admin
- `GET /api/admin/users`
- `POST /api/admin/users`

## Health
- `GET /health` — PostgreSQL + Agent health.
