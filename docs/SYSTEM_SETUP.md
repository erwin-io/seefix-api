# SEEFIX system setup

How the SEEFIX services fit together and how to set them up. Steps marked **🔑** need the owner's accounts, secrets or
machines; everything else is configuration in this guide.

## Architecture
```
 Web admin / Mobile app ──HTTPS──► seefix-api (laptop/server or Vercel) ──► PostgreSQL (Neon) ◄── seefix-worker (always-on host)
        ▲                                  │   saves reports / completions as PENDING     ▲          jobs: realtime-dispatch, agent-retry
        │ live updates                     │   previews + /health over HTTPS              │
     Pusher ◄──────────────── realtime-dispatch (worker) or the API's own dispatcher        │
                                           ▼                                              │
                       seefix-agents + Ollama (AI host, Windows services, Tailscale Funnel) ┘ claims PENDING work, writes results
```
- **Assessments are queued, never pushed.** The API saves a report (`AgentStatus=PENDING`) or a completion
  (`CompletionAgentStatus=PENDING`). The Agent claims pending work from the database within about 3 s. A report is
  accepted even while the Agent is down; it's processed when the Agent is back.
- **Failures retry themselves.** seefix-worker's `agent-retry` job puts `FAILED` work back to `PENDING` after 2, then
  4 minutes, for 3 attempts in total. After that the work stays `FAILED` for a person.
- **Interactive AI features stay direct.** The maintenance request draft, procurement package preview, work order
  preview and review, clarification draft and `/health` are HTTPS calls from the API to the Agent, because a person is
  waiting for the answer.
- **Realtime is durable.** Every change writes an `OutboxEvents` row in the same transaction. A dispatcher sends it to
  Pusher: either seefix-worker's `realtime-dispatch` job, or the API's built-in loop when the API runs on an always-on
  machine. When nothing dispatches, the apps fall back to polling.

## What runs where
| Component | Repo | Runs on | Needs |
|---|---|---|---|
| Database | — | Neon (or any PostgreSQL 13+) | the SEEFIX `dbo` schema |
| Business API | seefix-api | Vercel, or a laptop/server (`npm start`) | DB, Cloudinary, Pusher, Agent URL and key |
| AI Agent + model | seefix-agents + Ollama | AI host, Windows services (NSSM) | DB, local Ollama |
| Background jobs | seefix-worker | any always-on host, e.g. the AI host | DB, Pusher |
| Web admin | seefix-web-admin | Vercel or any static host | API URL |
| Mobile reporter | seefix-mobile-reporter | Android build | API URL |

## 1. Database 🔑
1. Create a Neon project in the region **closest to where the API and Agent run**. Each query pays the round trip,
   and the Agent makes many per report. Create a database `seefixdb`.
2. Load the schema and setup data from a backup. Use the **direct** (non-`-pooler`) host for restores:
   ```
   pg_restore --no-owner --no-privileges -d "postgresql://<user>:<password>@<host>.neon.tech/seefixdb?sslmode=require" seefix-dbo-<date>.sql
   ```
3. Check it (from seefix-api, with `DATABASE_URL` set to the database):
   ```
   npm run verify:db
   ```
4. Create the login accounts (from seefix-api, with `SEEFIX_RBAC_PASSWORD` set in its `.env`):
   ```
   node scripts/seed-rbac-users.js
   ```
5. The apps use the **pooled** host (`-pooler`): `…/seefixdb?sslmode=verify-full` for Node (seefix-api,
   seefix-worker) and `?sslmode=require` for Python (seefix-agents).

## 2. External services 🔑
| Service | What to create | Values |
|---|---|---|
| Pusher Channels | one app (any cluster near users) | `PUSHER_APP_ID`, `PUSHER_KEY`, `PUSHER_SECRET`, `PUSHER_CLUSTER` |
| Cloudinary | one account | `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` |
| SMTP | any provider | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` |
| Tailscale | one account (free) | used for the Agent's public HTTPS address |

## 3. Shared secrets
Generate each secret once, with Python or Node:
```
python -c "import secrets; print(secrets.token_urlsafe(48))"
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```
| Secret | Set in | Must match |
|---|---|---|
| Agent key | seefix-api `LOCAL_AGENT_SECRET`, seefix-agents `SEEFIX_AGENT_API_KEY` | yes, identical |
| `JWT_SECRET`, `OTP_PEPPER` (32+ characters each) | seefix-api only | — |
| Database URL | seefix-api, seefix-agents, seefix-worker | the **same database** |
| Pusher keys | seefix-api, seefix-worker | the same Pusher app |

Never commit `.env` files. Every repo ignores them, and the `.env.example` files hold placeholders only.

## 4. AI host (Windows) 🔑 machine
One always-on Windows PC runs Ollama and the Agent, and optionally seefix-worker. Run these in an **administrator** PowerShell.

**Ollama and the model**
```powershell
winget install Ollama.Ollama
ollama pull qwen3-vl:2b-instruct-q4_K_M
```
Disable the Ollama tray app at sign-in (Task Manager → Startup apps), so only the service runs.

**seefix-agents**
```powershell
git clone https://github.com/erwin-io/seefix-agents.git C:\Development\seefix-agents
cd C:\Development\seefix-agents
py -3.12 -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
copy .env.example .env
```
In `.env`, set `DATABASE_URL` (pooled host, `?sslmode=require`), `SEEFIX_DATABASE_SSLMODE=require`,
`SEEFIX_AGENT_API_KEY`, and `SEEFIX_OLLAMA_BASE_URL=http://127.0.0.1:11434`. Then check the contract:
```powershell
.venv\Scripts\python.exe scripts\verify_database_contract.py
```

**Services** (install NSSM first with `winget install NSSM.NSSM`):
```powershell
New-Item -ItemType Directory -Force C:\Development\seefix-agents\logs | Out-Null
nssm install SeefixOllama "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe" serve
nssm set SeefixOllama AppEnvironmentExtra "OLLAMA_HOST=127.0.0.1:11434" "OLLAMA_MODELS=$env:USERPROFILE\.ollama\models" "OLLAMA_KEEP_ALIVE=15m"
nssm set SeefixOllama Start SERVICE_AUTO_START
nssm set SeefixOllama AppStdout C:\Development\seefix-agents\logs\ollama.log
nssm set SeefixOllama AppStderr C:\Development\seefix-agents\logs\ollama.log
nssm start SeefixOllama

nssm install SeefixAgent "C:\Development\seefix-agents\.venv\Scripts\python.exe" "-m uvicorn app.main:app --host 127.0.0.1 --port 8000"
nssm set SeefixAgent AppDirectory C:\Development\seefix-agents
nssm set SeefixAgent AppEnvironmentExtra "PYTHONUNBUFFERED=1"
nssm set SeefixAgent DependOnService SeefixOllama
nssm set SeefixAgent Start SERVICE_DELAYED_AUTO_START
nssm set SeefixAgent AppStdout C:\Development\seefix-agents\logs\agent.log
nssm set SeefixAgent AppStderr C:\Development\seefix-agents\logs\agent.log
nssm start SeefixAgent

powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```
For both services, also set `AppExit Default Restart`, `AppRestartDelay 5000`, `AppRotateFiles 1` and
`AppRotateBytes 10485760`. To edit a service later: `nssm edit <name>`.

**Public HTTPS address (Tailscale Funnel)** 🔑 sign-in
1. Install Tailscale (`winget install Tailscale.Tailscale`), sign in, then run `tailscale set --unattended=true`.
2. In the admin console: **Machines → the AI host → Disable key expiry**. **DNS**: MagicDNS and HTTPS Certificates
   enabled. **Access controls**: the policy contains a `nodeAttrs` entry granting `funnel`.
3. Publish the Agent: `tailscale funnel --bg 8000`. `tailscale funnel status` shows the address, e.g.
   `https://<machine>.<tailnet>.ts.net`. It survives reboots. A new name can take up to about 20 minutes to appear in public DNS.
4. This address is the API's `LOCAL_AGENT_URL`. Only `/health` is public; everything else requires the Agent key.

A full restart takes about 3 minutes before the address answers (boot, Wi-Fi, Tailscale, delayed Agent start). No
sign-in is needed.

## 5. seefix-worker (any always-on host)
```powershell
git clone https://github.com/erwin-io/seefix-worker.git C:\Development\seefix-worker
cd C:\Development\seefix-worker
npm ci
copy .env.example .env
```
In `.env`, set `DATABASE_URL` (same database), `PUSHER_*`, `JOB_REALTIME_DISPATCH=on` and `JOB_AGENT_RETRY=on`. Then:
```powershell
npm run once
```
It should print `Jobs: realtime-dispatch, agent-retry` and one summary line per job. Install it as the
`SeefixWorker` service; the NSSM and systemd steps are in the seefix-worker README. Only **one** worker is needed,
but two are safe.

## 6. seefix-api
Shared settings (see `.env.example`): `DATABASE_URL`, `DATABASE_SSLMODE=verify-full`, `JWT_SECRET`, `OTP_PEPPER`,
`SMTP_*`, `CLOUDINARY_*`, `LOCAL_AGENT_URL` (the Funnel address), `LOCAL_AGENT_SECRET`, `PUSHER_*`, and `CORS_ORIGINS`
(the web admin's and the apps' origins).

| Setting | API on a laptop/server **with** seefix-worker | API on a laptop/server **without** a worker | API on Vercel 🔑 |
|---|---|---|---|
| `OUTBOX_DISPATCHER` | `off` | `on` (built-in loop) | `off` (ignored on Vercel) |
| `REALTIME_CLIENTS_ENABLED` | `on` | `on` | `on` |
| failed-assessment retries | worker `agent-retry` | **none**: run the worker for `agent-retry` | worker `agent-retry` |

**Vercel** 🔑 account. Import the repo (framework preset **Other**) and set every variable above in Project → Settings
→ Environment Variables. After that, `main` deploys to production and other branches get previews.
`docs/VERCEL_DEPLOY.md` covers the details and limits (4.5 MB request bodies, 60 s per request).

## 7. Clients
- **Web admin:** set `apiBaseUrl` in `src/environments/environment.ts` (empty = same origin behind a proxy), and add
  its origin to the API's `CORS_ORIGINS`.
- **Mobile reporter:** point its API base URL at the API, then build.

## 8. Checklist
| Check | Expected |
|---|---|
| `https://<funnel-address>/health` | `"status":"ok"`, database and ollama `reachable:true`, `modelAvailable:true` |
| `<api>/health` | `"status":"ok"`, with `agent.reachable:true` |
| seefix-worker log | `Jobs: realtime-dispatch, agent-retry` |
| Submit a report with the Agent **stopped** | the report is saved, stays `PENDING`, and is processed after the Agent starts |
| Assign a work order to a signed-in user | their bell updates within a couple of seconds |
| Reboot the AI host without signing in | the Funnel `/health` is `ok` again within about 3 minutes |

## 9. Operations
| Task | How |
|---|---|
| After editing an `.env` | restart that service: `nssm restart SeefixAgent` / `SeefixWorker`, or restart / redeploy the API |
| Agent logs | `Get-Content C:\Development\seefix-agents\logs\agent.log -Tail 50 -Wait` |
| Assessments failing | Agent log, then `/health`. Ollama hung: `nssm restart SeefixOllama`, then `nssm restart SeefixAgent` |
| Work that failed for good | `SELECT "ReportNo","AgentAttemptCount","AgentLastError" FROM dbo."Reports" WHERE "AgentStatus"='FAILED' AND "Status"='SUBMITTED';` |
| Realtime not live | `SELECT "Status",COUNT(*) FROM dbo."OutboxEvents" WHERE "Transport"='PUSHER' GROUP BY 1;` A growing `PENDING` count means no dispatcher is running |
| Rotate the Agent key | new value in both `.env` files, then restart the Agent and the API |
