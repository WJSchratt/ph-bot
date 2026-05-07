# PH Bot — Client Onboarding SOP

Step-by-step checklist for onboarding a new client to the ph-bot SMS system. Follow phases in order. Phases 1 and 5 are automated; everything else requires manual action.

---

## Phase 1 — Automated Setup (Onboarding Form)

Submit the onboarding form at `/onboarding` (or trigger `POST /onboarding/submit`). The pipeline runs automatically and does:

- [ ] Creates the GHL sub-account via Agency API (`GHL_AGENCY_API_KEY` must be set in Railway)
- [ ] Sets all GHL custom values: `bot_name`, `agent_name`, `agent_phone`, `agent_email`, `agent_business_card_link`, `meeting_type`, `meeting_link`, `calendar_link_mp`, `calendar_link_fx`, `loom_video_mp`, `loom_video_fx`, `offer`, `offer_short`, `language`, `marketplace_type`, `bot_use_case`, `elevenlabs_api_key`
- [ ] Creates ElevenLabs agents (EN + ES if applicable) and writes agent IDs back to GHL custom values
- [ ] Inserts a row into the `subaccounts` DB table
- [ ] Sends Walt/Jeremiah a PCR webhook notification with the manual checklist below

**If GHL_AGENCY_API_KEY is not configured**, create the GHL sub-account manually first, then fill in the form or run the pipeline with the existing location ID.

---

## Phase 2 — Phone Number & Registration

- [ ] **Buy a phone number** in the GHL sub-account matching the client's preferred area code(s)
- [ ] **Submit A2P Brand + Campaign** in Signal House for that number
- [ ] **Register the number** with FreeCaller, Hiya, and Orion (caller ID whitelisting)

Do not upload leads until A2P is approved and the number passes spam checks.

---

## Phase 3 — GHL Sub-account Configuration

- [ ] **Apply the Profit Hexagon snapshot** to the sub-account. This installs:
  - Workflows (inbound SMS trigger → ph-bot webhook, Post-Call Router, etc.)
  - Custom fields (bot fields folder, EP fields, etc.)
  - Sales Pipeline with named stages (`Engaging with AI`, `Needs Human Contact`, `Appointment Set`, `DNC / Remove`, `Disqualified`) — stage names must match exactly so the bot's auto-discovery works
- [ ] **Create a Private Integration Token (PIT)** in the sub-account:
  GHL → Settings → Integrations → Private Integrations → Create New
  Required scopes: `conversations.readonly`, `conversations.write`, `contacts.readonly`, `contacts.write`, `opportunities.readonly`, `opportunities.write`, `calendars.readonly`, `calendars.write`
- [ ] **Set `ghl_token` custom value** in the sub-account to the PIT token just created. This is what gets passed in every webhook payload to the bot.
- [ ] **Set `post_call_router_url` custom value** to the sub-account's Post-Call Router GHL workflow webhook URL (only available after the snapshot is applied and the workflow exists)

> **Note:** As of 2026-05-07, `ghl_api_key` is written to the `subaccounts` DB table automatically the first time the bot receives an inbound message from this location. No manual SQL update needed.

---

## Phase 4 — ElevenLabs

- [ ] **Configure the EN ElevenLabs agent webhook** → set to the sub-account's Post-Call Router GHL workflow webhook URL
- [ ] **Configure the ES ElevenLabs agent webhook** (if Spanish is enabled) → same URL

The agent IDs were written to GHL custom values in Phase 1. The webhook URL must point to this sub-account's workflow, not the PH main account.

---

## Phase 5 — DB Token Capture (Automated)

No action needed. The first inbound SMS from this sub-account automatically upserts the location's PIT token into `subaccounts.ghl_api_key`. After this fires:

- The location is included in the daily 7am GHL conversation repull
- Weekly summaries are generated for this location every Monday
- The location appears by name (not UUID) in the dashboard per-account breakdown

You can confirm by checking Railway logs for a `subaccount_sync / new_location` event after the first test SMS.

---

## Phase 6 — Pre-Launch Testing

- [ ] **Load media** into the sub-account's media library (agent photo, memes if used)
- [ ] **Bulk-update `assigned_agent`** on all contacts to the agent's first name — this is the value the bot uses for `[agentName]` in messages
- [ ] **Send a test SMS** through the GHL workflow to confirm:
  - Webhook hits Railway (check Railway logs for `inbound` parse event)
  - Bot replies within ~10 seconds
  - Reply appears in GHL conversation thread
  - No 499 errors in GHL workflow execution history
- [ ] **Verify pipeline routing** — confirm the contact moves to `Engaging with AI` stage in the Sales Pipeline after the first reply
- [ ] **Verify field sync** — after a terminal outcome, confirm GHL contact fields update (call_sentiment, appointment_outcome, etc.)

---

## Phase 7 — Go Live

- [ ] **Upload leads** to the sub-account
- [ ] **Activate the outbound drip workflow** (or confirm it fires on lead upload)
- [ ] **Schedule onboarding call** with the agent to walk through what the bot does and how handoffs work

---

## Reference: What's in Each Custom Value

| Custom Value | Set by | Example |
|---|---|---|
| `bot_name` | Onboarding pipeline | `Sarah` |
| `agent_name` | Onboarding pipeline | `Jeremiah` |
| `agent_phone` | Onboarding pipeline | `+18015550000` |
| `agent_email` | Onboarding pipeline | `jeremiah@ph.com` |
| `ghl_token` | **Manual (Phase 3)** | `pit-xxxx-xxxx-xxxx` |
| `post_call_router_url` | **Manual (Phase 3)** | GHL workflow webhook URL |
| `offer` | Onboarding pipeline | `Mortgage Protection` |
| `offer_short` | Onboarding pipeline | `protecting your mortgage` |
| `meeting_type` | Onboarding pipeline | `Phone` or `Zoom` |
| `bot_use_case` | Onboarding pipeline | `mp`, `fx`, `chiropractic` |
| `elevenlabs_api_key` | Onboarding pipeline | same for all clients |
| `elevenlabs_agent_id_en` | Onboarding pipeline | EL agent ID |
| `elevenlabs_agent_id_es` | Onboarding pipeline | EL agent ID (ES) |
| `language` | Onboarding pipeline | `en` or `es` |
| `marketplace_type` | Onboarding pipeline | `ACA` or blank |

---

## Reference: What Breaks If Steps Are Skipped

| Skipped step | Symptom |
|---|---|
| PIT token not set as `ghl_token` custom value | Bot receives no `ghl_token` in payload; cannot send replies or make GHL API calls |
| `post_call_router_url` not set | Terminal outcomes (handoff, DNC, booked) don't fire the PCR workflow; GHL doesn't route the contact |
| Snapshot not applied | Bot can't auto-discover Sales Pipeline stages; `routeOpportunity` falls back to PH main's hardcoded stage IDs, which are wrong for this location |
| A2P not submitted | Number flagged as spam; messages filtered or blocked by carriers |
| ElevenLabs webhook not configured | Post-call data from voice agents doesn't reach GHL; EP review queue doesn't populate |
| `assigned_agent` not bulk-updated | Bot addresses the agent by whatever GHL has on file (may be blank or wrong name) |
