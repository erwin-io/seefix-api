# SEEFIX rollout, Oct 9–13, 2026

System-level record of the rollout that moved SEEFIX to queued AI assessments, a background worker,
direct-to-Cloudinary uploads and Vercel hosting. Setup instructions live in [SYSTEM_SETUP.md](SYSTEM_SETUP.md);
this file records what changed, what broke, how it was fixed and what is still open.
Tracking issue: [#12](https://github.com/erwin-io/seefix-api/issues/12).

No credentials, private hostnames or network addresses are recorded here.

## Topology after the rollout

```
Web admin (Vercel, /api rewrite) ─┐
Mobile app (Android, HTTPS) ──────┼─► seefix-api (Vercel) ──► PostgreSQL (Neon) ◄── seefix-worker (AI host)
                                  │        │  signs uploads        ▲                   realtime-dispatch, agent-retry
          files ──► Cloudinary ◄──┘        │  drafts, previews,    │
                                           ▼  /health (HTTPS)      │
                        seefix-agents + Ollama (AI host, Tailscale Funnel) ── claims PENDING assessments
```

- **Assessments are queued.** The API saves reports and completions as `PENDING`; the Agent claims them from the
  database. A report is accepted while the Agent is down.
- **Files never pass through the API.** Clients get a signed Cloudinary upload, send the file to Cloudinary and submit
  only public IDs. Images up to 10 MB, documents up to 15 MB. Legacy multipart stays for older app versions.
- **Realtime is durable.** Changes write `OutboxEvents`; seefix-worker delivers them to Pusher.

## Merged changes

| Date | Repo | PR | Change |
|---|---|---|---|
| Oct 9 | seefix-api | [#6](https://github.com/erwin-io/seefix-api/pull/6) | Web-admin contract endpoints: assignable users, reference categories, handoff `ReportId`. |
| Oct 9 | seefix-api | [#7](https://github.com/erwin-io/seefix-api/pull/7) | Removed the first Vercel config (re-added in #10). |
| Oct 9 | seefix-web-admin | [#2](https://github.com/erwin-io/seefix-web-admin/pull/2), [#3](https://github.com/erwin-io/seefix-web-admin/pull/3) | Web Admin MVP: foundation, business modules, role workflows. |
| Oct 9 | seefix-mobile-reporter | [#2](https://github.com/erwin-io/seefix-mobile-reporter/pull/2) | CI runs the app checks on every PR. |
| Oct 9 | seefix-agents | [#4](https://github.com/erwin-io/seefix-agents/pull/4) | CI runs the Agent checks on every PR. |
| Oct 10 | seefix-api | [#9](https://github.com/erwin-io/seefix-api/pull/9) | Durable `OutboxEvents` → Pusher dispatcher, opt-in; `REALTIME_CLIENTS_ENABLED` gates clients. |
| Oct 10 | seefix-web-admin | [#9](https://github.com/erwin-io/seefix-web-admin/pull/9) | Pusher lifecycle with polling fallback. |
| Oct 11 | seefix-api | [#11](https://github.com/erwin-io/seefix-api/pull/11) | Agent assessments queued in PostgreSQL; the API no longer calls the Agent to start them. |
| Oct 11 | seefix-agents | [#6](https://github.com/erwin-io/seefix-agents/pull/6) | Workers back off and log during PostgreSQL outages. |
| Oct 11 | seefix-worker | [#1](https://github.com/erwin-io/seefix-worker/pull/1) | New job runner: `realtime-dispatch` and `agent-retry` (2, then 4 min backoff, 3 attempts). |
| Oct 12 | seefix-api | [#10](https://github.com/erwin-io/seefix-api/pull/10) | Vercel serverless deployment (`vercel.json`, no listen/dispatcher on Vercel, opt-in dispatch endpoint). |
| Oct 12 | seefix-api | [#13](https://github.com/erwin-io/seefix-api/pull/13) | Direct-to-Cloudinary uploads: `POST /api/uploads/sign`, verified public IDs, per-upload transaction lock (409 on reuse), legacy multipart kept. |
| Oct 12 | seefix-api | [#14](https://github.com/erwin-io/seefix-api/pull/14) | Hotfix: default export from `src/app.js` (Vercel Express preset entry). |
| Oct 12 | seefix-web-admin | [#12](https://github.com/erwin-io/seefix-web-admin/pull/12) | Completion photos and procurement documents upload direct; limits in `environment.ts`. |
| Oct 12 | seefix-web-admin | [#13](https://github.com/erwin-io/seefix-web-admin/pull/13) | UI fixes: side column overlap, in-app image viewer, datepicker, form spacing. |
| Oct 12 | seefix-web-admin | [#14](https://github.com/erwin-io/seefix-web-admin/pull/14) | Vercel config: `/api` and `/health` rewritten to the API, SPA fallback. |
| Oct 12 | seefix-mobile-reporter | [#4](https://github.com/erwin-io/seefix-mobile-reporter/pull/4) | Report photos upload direct, no re-compression; 10 MB limit in environment files. |
| Oct 12 | seefix-worker | [#2](https://github.com/erwin-io/seefix-worker/pull/2) | `upload-cleanup` job for unattached uploads (off by default). |

Code-accepted, awaiting owner-approved merge:
[seefix-api #15](https://github.com/erwin-io/seefix-api/pull/15) (CORS: unlisted `Origin` no longer returns 500) and
[seefix-mobile-reporter #5](https://github.com/erwin-io/seefix-mobile-reporter/pull/5) (app calls the API directly;
dev proxy and native URL removed).

## Configuration (non-secret)

**seefix-api on Vercel** (Express preset, production from `main`; Production and Preview share values)

| Setting | Value |
|---|---|
| Region / time limit | `cle1`, 60 s (`vercel.json`) |
| `DATABASE_SSLMODE` | `verify-full` (Neon pooler host; the URL also uses `sslmode=verify-full`) |
| `OUTBOX_DISPATCHER`, `OUTBOX_DISPATCH_AFTER_WRITE` | `off` (seefix-worker delivers) |
| `REALTIME_CLIENTS_ENABLED` | `off` until the realtime gate below passes |
| `CORS_ORIGINS` | `https://localhost` (Android app), `http://127.0.0.1:8100`, `http://localhost:8100`, `http://localhost:4200` (local dev), `https://seefix-web-admin.vercel.app` |
| `LOCAL_AGENT_URL` | the AI host's Tailscale Funnel address |

**seefix-web-admin on Vercel**: Angular preset, no environment variables; the API is reached through the `vercel.json` rewrite.

**AI host**: Windows services through NSSM, all auto-start at boot and restart on crash, with Windows service recovery as a second layer: `SeefixOllama` (`qwen3-vl:2b-instruct-q4_K_M`), `SeefixAgent` (127.0.0.1:8000, published by Tailscale Funnel), `SeefixWorker` (`realtime-dispatch`, `agent-retry`; `upload-cleanup` off). A scheduled watchdog runs every 5 minutes as SYSTEM: it starts any stopped SEEFIX service and resets Funnel when the production API's `/health` reports the Agent unreachable.

## Incidents

| When | Symptom | Cause | Fix |
|---|---|---|---|
| Oct 12, after #10 | Every API request returned `500 FUNCTION_INVOCATION_FAILED` | Vercel's Express preset runs `src/app.js`, which had no default export | [#14](https://github.com/erwin-io/seefix-api/pull/14), verified on a real Preview first |
| Oct 13 | API `/health` showed the Agent unreachable while the AI host looked healthy | Stale Funnel registration. A first watchdog checked the Funnel from the host itself, where the name resolves to its own tailnet address, so it never saw the outage | Funnel reset; the watchdog now checks `agent.reachable` through the production API. Recovery tested: 48 s |
| Oct 13 | Every web-admin POST returned 500 once `CORS_ORIGINS` was set | The web admin's `/api` rewrite forwards the browser `Origin`, and the API rejected unlisted origins with an error | Web-admin origin added to `CORS_ORIGINS`; permanent fix [#15](https://github.com/erwin-io/seefix-api/pull/15) |
| Oct 13 | AI completion check `FAILED`: `CERTIFICATE_VERIFY_FAILED … self-signed certificate in certificate chain` | The AI host lacked the GlobalSign Root R46 root; some Cloudinary CDN servers chain to it, so downloads failed depending on the server | Microsoft's root list imported into the machine store; check re-queued and completed. Hardening proposed: verify downloads with `certifi` in seefix-agents |

## Test evidence

- Automated suites green on merged changes: seefix-api 85 pass (5 live-database tests skipped), web admin 49/49,
  mobile 83/83, worker and Agent CI.
- Live upload checks against the real Cloudinary account (local API and database), 14/14 passed: direct and legacy
  uploads, 409 on reuse, 403 for another user's upload, per-role signing. Details on issue #12.
- Production after #14: `/health` 200 with database and Agent reachable; anonymous requests to protected routes 401;
  CORS allows exactly the listed origins.
- Production internal-repair flow, end to end with real before and after photos: report with a direct photo upload →
  Agent assessment → Maintenance Review (INTERNAL) → work order WO-2026-000007 → completion photo → completion check
  `COMPLETED` (`VISIBLE_IMPROVEMENT`, on attempt 2 after the certificate fix) → supervisor decision.

## Known limitations

- Legacy multipart uploads through Vercel are capped at 4.5 MB per request; current clients bypass this.
- The Agent and the worker poll the database every 2–3 s, so a Neon free-plan database never suspends; watch compute usage.
- The AI host is a single machine: when it is off, assessments wait as `PENDING` and realtime delivery pauses.

## Remaining gates

| Gate | Blocks closing #12 | Next step |
|---|---|---|
| PROCUREMENT path on production | **Yes** | Review a report as PROCUREMENT → handoff → procurement PDF uploaded direct → `ProcurementDocuments` row and the document opens for an authorized user |
| Merge API #15 and mobile #5 | No | Owner approval; then the release checks posted on each PR |
| Live updates (`REALTIME_CLIENTS_ENABLED=on`) | No | Observe `SENT` growth in `OutboxEvents` and private-channel delivery, confirm REST fallback |
| `JOB_UPLOAD_CLEANUP=on` | No | Test-account check with orphan and attached files |
| seefix-agents `certifi` hardening | No | Separate PR; certificate verification stays on |
