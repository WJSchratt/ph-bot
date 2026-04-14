# PH Insurance SMS Bot

Node.js/Express middleware replacing Botpress for SMS lead qualification. Bridges GoHighLevel (GHL) CRM and the Claude API.

## Quick start

```bash
cp .env.example .env   # fill in secrets
npm install
npm run migrate        # creates schema in DATABASE_URL
npm start              # starts on $PORT (default 3000)
```

Dashboard: open `http://localhost:3000/`.

## Endpoints

- `POST /webhook/inbound` — GHL webhook entry point
- `GET /api/analytics` — cross-account or per-location rollup
- `GET /api/conversations` — paged list
- `GET /api/conversations/:contact_id/:location_id` — single conversation + messages
- `GET /api/message-performance` — message-type engagement
- `GET /api/sync-status` — pending field syncs
- `POST /cron/sync-fields` — batched GHL contact field sync (auth via `X-Cron-Secret`)
- `POST /cron/aggregate-analytics` — daily rollup into `analytics_daily`

## Deploy to Railway

1. Push to GitHub.
2. Create Railway project → add PostgreSQL plugin → add web service from repo.
3. Set `ANTHROPIC_API_KEY`, `GHL_POST_CALL_ROUTER_URL`, `CRON_SECRET`. `DATABASE_URL` is injected.
4. Schedule daily Railway crons hitting `/cron/sync-fields` and `/cron/aggregate-analytics` with header `X-Cron-Secret: $CRON_SECRET`.
5. In GHL workflow, change webhook URL to `https://your-app.railway.app/webhook/inbound`.

## Architecture

- **`src/server.js`** — Express app.
- **`src/routes/webhook.js`** — inbound pipeline: parse → upsert → Claude → GHL send → log → terminal handling.
- **`src/services/claude.js`** — Claude API call with prompt caching on the system block.
- **`src/services/ghl.js`** — SMS send, contact field update, DND set.
- **`src/services/postCallRouter.js`** — fires GHL post-call router webhook on terminal outcome.
- **`src/services/conversationStore.js`** — Postgres reads/writes.
- **`src/prompts/`** — 4 system-prompt variants + knowledge base.
- **`src/db/schema.sql`** — 3 tables: `conversations`, `messages`, `analytics_daily`.
- **`public/index.html`** — React dashboard (served statically).

Multi-tenant by design: `ghl_token` and `ghl_location_id` arrive per webhook; nothing is hardcoded per sub-account.
