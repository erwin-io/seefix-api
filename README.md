# SEEFIX API — Node.js / Express Business API

This is the business API for **SEEFIX — Smart AI Maintenance Prioritization System**. The previous browser assessment UI and raw `/api/analyze` gateway were removed. Reporter/PPO/Procurement/maintenance clients use this JSON API; AI work is performed by the protected `seefix-agents` FastAPI service.

## Final runtime

```text
Reporter Mobile / PPO / Procurement clients
                    ↓
            Node.js / Express
        JWT + RBAC + business rules
                    ↓
          PostgreSQL dbo schema
                    ↕
            seefix-agents
                    ↓
             Ollama / Qwen
```

A new Report is persisted with its Cloudinary `ReportImages` records first. Only after commit does Node call `POST /api/reports/{id}/process`. If that HTTP trigger fails, the Report remains `AgentStatus=PENDING` and the Python `ReportWorker` will still claim it from PostgreSQL.

## Setup

1. Copy `.env.example` to `.env` and fill your local credentials. Use the same PostgreSQL database and the same Node→Agent shared secret as `seefix-agents`.
2. Install:
   `npm install`
3. Verify syntax/tests/database:
   `npm run check`
   `npm test`
   `npm run verify:db`
4. Run:
   `npm start`

No static web UI is served.

## Main API groups

- `/api/auth` — Reporter registration/login and current user.
- `/api/reports` — Reporter submission, list/detail, independent verification, Agent state.
- `/api/notifications` — persistent mobile/web notifications.
- `/api/ppo` — PPO action center, report verification + maintenance authorization, clarification response, Work Order confirmation/completion/rework.
- `/api/procurement` — inbox, acknowledge/start, clarifications, final Procurement Outcome.
- `/api/work-orders` — execution, status/progress, people, materials, completion evidence and completion-agent state.
- `/api/admin` — basic user management.

## Important human gates

Node intentionally owns the human-authorized writes that the Agent must never perform:

- PPO Staff: FinalCategory/FinalUrgency review + Maintenance Request authorization.
- Procurement: final outcome metadata only; bidding/provider selection stays outside SEEFIX.
- PPO Head: Work Order confirmation.
- Responsible maintenance party/PPO: start/progress/completion submission.
- PPO Head: Confirm Complete or Require Rework.

The Agent provides inspection, drafts, deterministic policy/knowledge, Procurement clarification drafts, Work Order readiness/variance, and before/after completion assistance.

## Report upload (mobile-ready)

`POST /api/reports` with Bearer JWT and `multipart/form-data`:

- `images` — one or more JPEG/PNG/WebP files (required)
- `description`, `notes`, `building`, `floor`, `roomOrArea`, `gpsLat`, `gpsLng` — optional

The API uploads evidence to Cloudinary and writes `Reports` + `ReportImages` in one PostgreSQL transaction.

## Security

Do not commit `.env`. The project never exposes `LOCAL_AGENT_SECRET` to mobile clients. Rotate any secret previously included in exported source files. Use strong JWT and Agent secrets in production and TLS for remote API/database traffic.
