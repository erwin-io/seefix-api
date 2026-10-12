# Deploying seefix-api on Vercel

`server.js` exports the Express app. On Vercel (`VERCEL` is set by the platform) it does not call `listen()`
or start the OutboxEvents dispatcher loop: Vercel runs the app per request and freezes it in between.
Locally, `npm start` is unchanged.

## Deploys
- Import this GitHub repo in Vercel (Framework preset: **Other**, root directory: repo root). After that,
  every push to `main` deploys **production** and every other branch or PR gets a **preview** URL.
- `vercel.json` pins functions to `cle1` (Cleveland, Ohio), next to the Neon `us-east-2` database, and allows 60 s per request.
  If your Neon project is in another region, change `regions` to the closest Vercel region.
- Previews use the **Preview** environment variables. Point them at a separate Neon branch or database,
  not production data.

## Environment variables (Vercel → Project → Settings → Environment Variables)
Use the values from your working `.env`. Do not commit them.

| Required (the app refuses to start without them) | Notes |
|---|---|
| `DATABASE_URL` | Neon **pooled** host, `?sslmode=verify-full` |
| `DATABASE_SSLMODE` | `verify-full` |
| `JWT_SECRET`, `OTP_PEPPER` | at least 32 characters each |
| `SMTP_HOST`, `SMTP_FROM` (+ `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` as in your `.env`) | OTP / account emails |
| `LOCAL_AGENT_URL`, `LOCAL_AGENT_SECRET` | Agent's public HTTPS URL (for example a Tailscale Funnel URL) and its key |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | uploads |
| `CORS_ORIGINS` | comma-separated web admin and app origins, for example `https://seefix-admin.vercel.app` |

Realtime on Vercel (no long-lived process, so the API delivers OutboxEvents on demand):

| Variable | Value | Why |
|---|---|---|
| `PUSHER_APP_ID`, `PUSHER_KEY`, `PUSHER_SECRET`, `PUSHER_CLUSTER` | your Pusher app | publish events and sign client subscriptions |
| `OUTBOX_DISPATCHER` | `off` | the in-process loop can't run on serverless |
| `OUTBOX_DISPATCH_AFTER_WRITE` | `on` | after each successful write request, deliver what it queued (`waitUntil`, ~1 s) |
| `OUTBOX_CRON_SECRET` | a long random value | enables `POST /api/realtime/dispatch` for the external scheduler |
| `REALTIME_CLIENTS_ENABLED` | `on` once the scheduler is set up | clients go "live" only when delivery is running |

The other variables in `.env.example` are optional and have defaults.

## Delivery without an always-on machine
- **API writes** (status changes, assignments, notifications) are delivered right after the response
  (`OUTBOX_DISPATCH_AFTER_WRITE=on`).
- **Everything else** (events the Agent writes, anything missed after a crash or a Pusher outage) is delivered when
  something calls the protected endpoint:
  ```
  POST https://<your-api>.vercel.app/api/realtime/dispatch
  Authorization: Bearer <OUTBOX_CRON_SECRET>
  ```
  Response: `{"passes":1,"claimed":2,"sent":2,"retried":0,"failed":0,"expired":0}`. It returns 404 when the secret
  isn't configured, 401 for a wrong secret, and 503 when Pusher isn't configured.
- **Scheduler:** a free external cron such as cron-job.org, every 1 minute, `POST` with the header above.
  Vercel Cron also works (it sends the same `Authorization: Bearer` header), but Hobby cron runs at most once per day.
- Overlapping calls are safe: delivery reuses the outbox claim (`FOR UPDATE SKIP LOCKED`), retries, the 60-minute age
  cap and lease rules, so a row is never sent twice by concurrent calls. One call drains at most 10 batches within 20 s.
- Self-hosted alternative: `npm run outbox:dispatch` on an always-on machine (see `docs/REALTIME_ROLLOUT.md`).

## Known limits on Vercel
- **Request body limit: 4.5 MB.** Current clients upload files straight to Cloudinary (`POST /api/uploads/sign`) and send
  only public IDs, so this doesn't affect them (images up to 10 MB, documents up to 15 MB). Older clients that still send
  multipart through the API fail with `413 FUNCTION_PAYLOAD_TOO_LARGE` above 4.5 MB per request.
- **Request time: 60 s** (`maxDuration`). Agent processing is asynchronous (the API gets `202 Accepted`), so this only
  affects slow uploads or slow database round trips.
