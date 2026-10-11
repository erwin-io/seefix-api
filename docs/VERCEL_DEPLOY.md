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

Realtime on Vercel:

| Variable | Value | Why |
|---|---|---|
| `PUSHER_APP_ID`, `PUSHER_KEY`, `PUSHER_SECRET`, `PUSHER_CLUSTER` | your Pusher app | sign client subscriptions (`/api/realtime/auth`) |
| `OUTBOX_DISPATCHER` | `off` | no long-lived process on Vercel |
| `REALTIME_CLIENTS_ENABLED` | `on` **only while** a dispatcher is running elsewhere | otherwise clients go "live" but receive nothing |

The other variables in `.env.example` are optional and have defaults.

## Outbox dispatcher on an always-on host
Pusher delivery needs one long-running process that reads `dbo.OutboxEvents` and publishes:
```
npm run outbox:dispatch
```
Run it on any always-on machine with Node.js and this repo. Give it the same `.env` as the API: it validates the
same required settings, and needs `DATABASE_URL` (the same Neon database) and `PUSHER_*`. One instance is enough;
a second is safe (row claims use `FOR UPDATE SKIP LOCKED`). On Windows, run it as a service, for example with NSSM:
`node scripts/outbox-dispatch.js` with the repo folder as the working directory. See `docs/REALTIME_ROLLOUT.md` for
the activation order and backout.

## Known limits on Vercel
- **Request body limit: 4.5 MB.** Photo and document uploads larger than that fail with `413 FUNCTION_PAYLOAD_TOO_LARGE`,
  even though `MAX_UPLOAD_MB` allows 10 MB per file and several files per request. Workaround until direct-to-Cloudinary
  uploads exist: keep each request under 4.5 MB (smaller or compressed photos, one at a time).
- **Request time: 60 s** (`maxDuration`). Agent processing is asynchronous (the API gets `202 Accepted`), so this only
  affects slow uploads or slow database round trips.
