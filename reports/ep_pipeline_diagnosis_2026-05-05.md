# EP After-Hours / Video Generation Pipeline — Full Diagnosis
**Date:** 2026-05-05  
**Scope:** ElevenLabs After Hours Research Caller v1 → Post-Call Webhook → Video Generation → Instantly Campaign  
**Method:** Read-only. No code changes, no agent edits, no deploys.

---

## Executive Summary

| # | Finding | Severity |
|---|---------|----------|
| 1 | Agent fires a **second spoken turn on voicemail calls** (says "Hello" after the first message). Root cause: `turn_timeout=6.0s` fires during the voicemail silence window. | HIGH |
| 2 | `deriveCallResult` in `epHandler.js` only recognizes **3 of 6 evaluation criteria**. Three new criteria (`BUSINESS_AFTER_HOURS_DENIED`, `VOICEMAIL_GREETING_CAPTURED`, `BUSINESS_CONFIRMED_AFTER_HOURS`) are live in the agent but produce no DB call_result or GHL update. | HIGH |
| 3 | **Video pipeline is 100% manual** — `generate.py` runs on your local machine by hand; there is no webhook trigger, no queue, no Railway job. After running it, Instantly outreach is a second separate manual step (test_instantly.py). Zero automation from voicemail → video → email. | HIGH |
| 4 | **Instantly `video_url` variable is not landing in emails.** The Python script sends `video_url` but the Instantly template almost certainly uses `{{video_link}}` (variable name mismatch), or the value has stray whitespace. The `biz_name` / `first_name` variables work because their names match. | MEDIUM |
| 5 | **49 audio fetches are permanently stuck at `pending`** (older than 3 days). The async fire-and-forget audio job silently failed for these calls and there is no batch-retry path. Those voicemail recordings are unrecoverable from Railway (ElevenLabs deletes audio after 90 days). | MEDIUM |
| 6 | **`generate.py` does not write `video_url` back to the DB**, so the EP Review page shows "Watch video" links for exactly zero calls, defeating its purpose as a review tool. | MEDIUM |
| 7 | **No EP calls in the last 3 days** (last call: 2026-05-02 16:11 UTC). Campaign appears to be paused or exhausted. | INFO |
| 8 | Four `data_collection_results` fields (`voicemail_greeting_summary`, `live_response_outcome`, `estimated_quote_dollars`, `did_business_acknowledge_after_hours`) are being populated by ElevenLabs and stored in `raw_payload` but **never extracted into their own DB columns or surfaced anywhere**. | LOW |
| 9 | Five DB columns (`review_status`, `review_notes`, `video_url`, `video_processed_at`, `instantly_lead_id`) exist in the live Postgres table but **are not in any migration file**. If the DB is ever reset, they're gone. | LOW |

---

## Component-by-Component Status

### 1. ElevenLabs Voice Agent (agent_2001kpf1b4vme47vjawagajw23e4)

**What works:**
- Agent config is clean and current. System prompt is well-written.
- Voice ID `yr43K8H5LoTp6S1QFSGg` (Alex) confirmed in agent — matches what `generate.py` expects.
- First message: `"Um... hm... uh, hello? ... Are you there? ... I thought you took after-hours requests?"` is a solid voicemail opener.
- Four data collection fields are populating correctly in ElevenLabs (raw_payload has the data).
- Agent correctly ends calls when asked "is this AI?" (detects and invokes `end_call`).
- 6 evaluation criteria defined and being scored by ElevenLabs' post-call analysis LLM.
- LLM: Gemini 2.5 Flash. 4 outbound phone numbers assigned (2 MN area codes, 2 Minneapolis suburbs).
- `call_limits`: concurrency=5, daily_limit=500.

**What's broken:**

**[BUG 1 — Turn Timeout]** `turn_timeout = 6.0` causes a second spoken turn on voicemail calls.  
Evidence from transcript spot-check:
```
conv_2301kqmmdyasewzt21r9: Um... hm... uh, hello?... I thought you took after-hours requests? | ... | [pauses] [confused] Hello
conv_6501kqkkqcame9z: Um... hm... uh, hello?... I thought you took after-hours requests? | ... | [pauses] [hesitant] Hello
```
What happens: first message plays into voicemail (4–5 seconds). Voicemail records it. Silence follows. After 6 seconds of silence, `turn_timeout` fires and the agent speaks a second time ("Hello"). This second utterance gets recorded onto the voicemail. `silence_end_call_timeout = 10.0` would eventually end the call, but the damage is done — the voicemail now has a confusing second message on it. The "known issue" in memory about the agent speaking before ringing finishes is related but distinct: `initial_wait_time = 5.5` gives some protection on the connect side; the second-turn problem is the bigger active defect.

**[BUG 2 — initial_wait_time risk]** `initial_wait_time = 5.5s` and `disable_first_message_interruptions = false`.  
If a voicemail greeting is short (< 5.5s), the agent starts speaking mid-greeting and the first few words of the opener get clipped before the voicemail beep. Some calls in the DB have duration 4s (`conv_5001kqmbwxb1fhv`), suggesting the call may have been cut off before the full message was recorded.

**What's unknown:**
- Whether the second-turn utterance is actually causing meaningful damage to the recording quality or whether recipients notice.
- The exact trigger: is it the voicemail BEEP triggering VAD → `speculative_turn=true` firing prematurely, or purely `turn_timeout`?

---

### 2. Post-Call Webhook Handler (Railway → `elevenlabs_calls` table)

**What works:**
- HMAC verification working (`verifySignature` in `elevenlabsWebhook.js`).
- `upsertBase` idempotent — retries from ElevenLabs don't create duplicates.
- EP classification (`isEpCall` in `epHandler.js`) working — 837 of 1,161 calls correctly tagged `is_ep=TRUE`.
- Dedup logic (10-minute sibling window, priority by result rank, tie-break by shorter duration) is working: see `+17635591900` with 5 calls in 2 minutes — 1 `success`, 4 `skipped_dedup`. Correct behavior.
- GHL contact lookup + custom field update working: 712 of 837 EP calls (85%) got a successful GHL write.
- Audio async fetch working for most calls: 765 of 837 (91%) have `audio_fetch_status=success`.

**What's broken:**

**[BUG 3 — deriveCallResult missing 3 criteria]** The `deriveCallResult` function in `epHandler.js:27` only checks `VOICEMAIL_HIT`, `DISPATCHER_BLOWN`, and `LIVE_PICKUP`. But the live agent now has 6 evaluation criteria:

| Criteria ID | Handled by deriveCallResult? | What it means |
|-------------|------------------------------|---------------|
| VOICEMAIL_HIT | YES → `voicemail` | |
| LIVE_PICKUP | YES → `live_pickup` | |
| DISPATCHER_BLOWN | YES → `dispatcher_blown` | |
| BUSINESS_AFTER_HOURS_DENIED | **NO** | Live human said they DON'T take after-hours — A-tier video content per agent config |
| VOICEMAIL_GREETING_CAPTURED | **NO** | Real voicemail greeting recorded — B-tier content |
| BUSINESS_CONFIRMED_AFTER_HOURS | **NO** | Live human confirmed they DO take after-hours — should be tagged DO-NOT-LOOM |

Result: calls where only `BUSINESS_AFTER_HOURS_DENIED` or `VOICEMAIL_GREETING_CAPTURED` or `BUSINESS_CONFIRMED_AFTER_HOURS` fires as `success` get stored as `call_result='unknown'`. There are **96 `unknown` calls in the DB**. Spot-check confirms they are all-failure across all 6 criteria (rang out, no answer) — so those 96 are genuinely "no outcome" calls, not misclassified. But any future calls that hit the 3 new criteria will be silently bucketed as `unknown`.

**[BUG 4 — 49 stale pending audio fetches]** 72 EP calls have `audio_fetch_status='pending'`; 49 of those are older than 3 days. The async audio job (`setImmediate` in `elevenlabsWebhook.js:104`) fires once on webhook receipt and has no retry path. If Railway restarted mid-fetch, those jobs were lost silently. The `/api/elevenlabs/audio/:conversation_id/refetch` endpoint exists but requires per-call manual trigger. No bulk retry exists.

**Dedup logic verification:**  
Call counts per duplicate phone (top 5):
- `+19522999888`: 34 calls
- `+17633379437`: 29 calls  
- `+16123389999`: 15 calls
- `+19528843552`: 8 calls
- `+16513814600`: 7 calls

Total: 15 phone numbers with >1 EP call. The dedup logic handles concurrent-burst correctly (same number within 10-minute window). These represent numbers called on different days. For cross-day calls to the same number, dedup does NOT apply (10-min window only) — intended behavior.

**Outcome variable spot-check (voicemail accuracy):**  
5 most-recent voicemail calls sampled. All 5 have `VOICEMAIL_HIT=success` in evaluation_criteria AND transcripts that only show the agent's opener followed by silence. Flag accuracy appears correct for these samples.

---

### 3. Video Generation Pipeline

**What works:**
- `generate.py` is fully functional when run manually.
- Pulls EP voicemail call from DB, downloads audio, fetches GHL contact data, generates 5-part video.
- Rendering: **FFmpeg local** (on your Windows machine — NOT Shotstack, NOT Creatomate, NOT Railway).
- Upload: **Bunny Stream CDN** (library ID `650848`). NOT YouTube (YouTube code is dead — marked as such in the file, not called from `main()`).
- Landing page: `https://web-production-f3109.up.railway.app/watch/{video_id}` — the `/watch/:video_id` route exists in `epReview.js:321` and is deployed and working.
- GHL write-back: sets `loom_url` field (custom field ID `xUkZInTNAGCKpmfzBAor`) on the GHL contact.
- EP Review page at `/ep-review` exists, requires auth, shows last 7 days of voicemail calls with approve/disqualify workflow.

**What's broken:**

**[BUG 5 — generate.py doesn't update the DB `video_url` column]**  
The DB has a `video_url` column (added outside migrations). The EP Review page reads it to show a "Watch video" link next to each card. But `generate.py` only writes to GHL — it never does `UPDATE elevenlabs_calls SET video_url=... WHERE ...`. Result: `video_url` is NULL for all 837 EP calls. The "Watch video" link never appears on the EP Review page.

**[BUG 6 — Trigger is manual-only]**  
There is no webhook, queue, cron job, or Railway service that auto-triggers `generate.py`. After a voicemail call lands in the DB and gets approved in EP Review, someone has to manually `cd video-gen && python generate.py` on the local Windows machine. This requires:
- Windows machine to be on
- venv activated
- FFmpeg in PATH (it is)
- Playwright Chromium installed (it is)
- Valid DB connection (public proxy URL `monorail.proxy.rlwy.net:37139`)

There is no video queue, no processing flag, no `video_processed_at` trigger logic. The `video_processed_at` column exists in the DB but is never written by anything in the codebase.

**What's unknown:**
- How many videos have actually been generated vs. how many approved calls exist (47 approved, but can't know how many got videos without a `video_url` in the DB).

---

### 4. Instantly Campaign Integration

**What works:**
- `test_instantly.py` can add a lead to the "EP Leads Outreach" campaign (campaign ID is looked up dynamically by name, not hardcoded — resilient to campaign ID changes).
- `biz_name` and `first_name` variables are being passed and received in Instantly.
- GHL contact lookup logic in the script is solid.

**What's broken:**

**[BUG 7 — `video_url` variable not rendering in Instantly emails]**  
The script sends:
```python
"custom_variables": {
    "video_url":  VIDEO,     # <-- variable name is "video_url"
    "biz_name":   lead["biz_name"],
    "first_name": lead["first_name"],
}
```
The task description states the video link is NOT sending even though other variables work. The most likely cause: the Instantly email template uses `{{video_link}}` (different variable name). This is the canonical Instantly variable-name mismatch bug — Instantly silently renders nothing for variables that don't match. Second possibility: the landing page URL (`https://web-production-f3109.up.railway.app/watch/{video_id}`) contains no stray whitespace when generated, but the Bunny embed URL (`https://iframe.mediadelivery.net/embed/...`) in test_instantly.py might not be what the template expects (it's an iframe src, not a clickable link).

To verify: open the Instantly campaign template, find the variable placeholder, and compare the exact string (case-sensitive, underscore vs hyphen vs space).

**[BUG 8 — No automation from video → Instantly]**  
`generate.py` ends after writing the Bunny URL to GHL. It does NOT call the Instantly API. Adding a lead to Instantly requires running `test_instantly.py` separately (or copy-pasting the URL manually). These two scripts are completely disconnected.

**Send timing:** Instantly controls send scheduling. The "prioritize new leads" toggle in the campaign settings (inside Instantly dashboard) determines whether a freshly added lead jumps to the front of the queue or waits for the next scheduled send window. Nothing on the Railway/Python side controls this.

---

### 5. ~837 Queued Calls — DB Health Check

| Metric | Value |
|--------|-------|
| Total calls in `elevenlabs_calls` | 1,161 |
| EP calls (`is_ep=TRUE`) | 837 |
| call_result = voicemail | 445 (53%) |
| call_result = dispatcher_blown | 150 (18%) |
| call_result = live_pickup | 146 (17%) |
| call_result = unknown | 96 (11%) |
| null evaluation_criteria (older calls) | 63 |
| GHL write success | 712 (85%) |
| GHL write skipped (no contact found) | 94 (11%) |
| GHL write failed | 3 (<1%) |
| GHL write pending | 1 |
| Audio fetch success | 765 (91%) |
| Audio fetch pending (stuck) | 72 (9%) |
| Audio fetch pending >3 days (likely lost) | 49 |
| EP calls date range | 2026-04-18 → 2026-05-02 |
| **Last EP call** | **2026-05-02 16:11 UTC (3 days ago)** |
| Phone numbers with >1 EP call | 15 |
| EP Review: pending | 779 |
| EP Review: approved | 47 |
| EP Review: disqualified | 11 |

**No EP calls in the last 3 days.** This is significant. Either the Twilio/ElevenLabs outbound campaign is paused, the lead list is exhausted, or there's a campaign configuration issue. Worth confirming in the ElevenLabs dashboard outbound calls section.

**Voicemail flag accuracy:** 5-call spot-check shows `VOICEMAIL_HIT=success` aligning with transcript content (agent's opener + silence). Flag appears accurate for sampled calls.

---

## Root Cause Hypotheses

**[HIGH confidence]**

1. **Second spoken turn on voicemail:** `turn_timeout=6.0` is too short for voicemail silence. After the first message plays and the voicemail records it (~4–5 seconds of speech + 1–2 seconds to close), there's silence. The 6-second timer fires and the LLM generates a new utterance. The agent's prompt says to invoke `end_call` when "voicemail detected and first_message has been delivered," but the voicemail beep doesn't reliably trigger the LLM's end_call decision — it just sees silence and fires the turn. Fix: either wire in `voicemail_detection` as a native built-in, or significantly increase `turn_timeout` to 15–20s (or set `silence_end_call_timeout` lower than `turn_timeout`).

2. **Instantly variable mismatch:** Variable names are case- and character-sensitive in Instantly. `biz_name` works, `first_name` works, but `video_url` doesn't. The Instantly template must use a different placeholder name (most likely `{{video_link}}`). This is a one-character check in the Instantly dashboard.

3. **Stale pending audio:** Railway dyno restart or ephemeral network failure at the moment the `setImmediate` audio job ran. The job is fire-and-forget with no retry queue or durable task system. 49 calls' audio is now stuck and the original ElevenLabs audio may still be fetchable (90-day retention policy, so calls from April 2026 are still within window until July 2026).

**[MEDIUM confidence]**

4. **generate.py doesn't write `video_url` to DB:** This was probably added as a column when the EP Review page was being built, but the code path to set it was never wired into generate.py. The omission is silent — the column just stays NULL.

5. **No campaign calls in 3 days:** Likely the outbound campaign was paused manually or reached the end of its lead list. Not a bug in the code — just a operational state worth verifying.

**[LOW confidence]**

6. **initial_wait_time too short for some voicemails:** 5.5s should be adequate for most voicemail systems (typical ring pattern: 4 rings ≈ 20–24 seconds before voicemail picks up), but some calls show only 4s duration which might indicate the agent's first message was clipped. This could also just be very brief voicemail greetings. Hard to confirm without listening to the recordings.

---

## Open Questions

1. **Instantly template variable name:** What is the exact variable name for the video URL in the Instantly email template? (Log into Instantly → campaign → sequence → hover variable placeholder.)

2. **ElevenLabs outbound campaign status:** Why did EP calls stop on 2026-05-02? Is the campaign paused in ElevenLabs, or is the lead list exhausted? Check the ElevenLabs Outbound Campaigns section.

3. **EP Review workflow:** When a call is approved in EP Review, is the intent to auto-trigger video generation, or is it purely a manual "these are the good ones" list that someone then processes separately? The `review_status` column and the manual `generate.py` suggest manual workflow, but worth confirming.

4. **Target for `BUSINESS_AFTER_HOURS_DENIED` calls:** The agent's criteria description says these are "A-tier video content." Should these calls be routed to video generation with a different script/framing? Or are they just flagged for GHL tagging?

5. **49 stuck audio fetches:** Are those voicemail calls worth recovering? If so, do you want to hit the ElevenLabs REST API manually for each conversation_id before the 90-day window closes? Audio is recoverable until ~July 2026.

6. **`data_collection_results` fields:** ElevenLabs is producing `voicemail_greeting_summary`, `live_response_outcome`, `estimated_quote_dollars`, `did_business_acknowledge_after_hours` for every call. These are stored in `raw_payload` but not surfaced. Do you want these written to DB columns and shown in EP Review?

7. **Video count discrepancy:** How many videos have actually been generated so far? 47 calls are "approved" in EP Review but `video_url` is NULL for all of them. Were videos generated before the EP Review page existed?

---

## Proposed Fix Plan

**Priority 1 (fixes the quality of current recordings — do ASAP):**

> Fix the second-turn voicemail problem.

**Option A (preferred):** In ElevenLabs agent config, change `turn_timeout` from `6.0` to `20.0` and change `silence_end_call_timeout` from `10.0` to `8.0`. This ensures silence ends the call (8s) before the turn timeout fires (20s). No code changes required.

**Option B (more robust):** Enable the `voicemail_detection` built-in tool in the agent config. In 11 Labs dashboard: agent → Tools → Add built-in → Voicemail Detection. Configure it to invoke `end_call` automatically on detection.

Both options together is best. Do not change the system prompt — the prompt already instructs the agent to call `end_call` when "voicemail detected and first_message has been delivered"; the timer settings are the structural issue.

---

**Priority 2 (fix the Instantly broken variable — 15 minutes):**

> Log into Instantly → "EP Leads Outreach" campaign → sequence → identify the exact variable name for the video link.

1. If it says `{{video_link}}`: change `test_instantly.py` line 65 from `"video_url": VIDEO` to `"video_link": VIDEO`.
2. If it says `{{video_url}}` (matches): the issue is something else — check for stray whitespace in the value, or whether the URL format (embed vs. landing page) matters to the template.
3. Also audit: should the URL sent be the Bunny embed URL or the Railway landing page URL? `generate.py` writes the landing page URL to GHL. `test_instantly.py` uses a hardcoded Bunny embed URL. These two should use the same URL. Decide which one, standardize in both places.

---

**Priority 3 (connect generate.py → DB video_url — 30 minutes):**

> After `upload_to_bunny()` returns `landing_url`, add a DB write:

File: `C:\Users\johns\OneDrive\Desktop\Video Editor Auto\video-gen\generate.py`, after the `write_loom_url_to_ghl` call (~line 1263).

Plan: write a `_write_video_url_to_db(conv_id, url)` function (similar to `write_loom_url_to_ghl`) that does:
```sql
UPDATE elevenlabs_calls
   SET video_url = %s, video_processed_at = NOW()
 WHERE conversation_id = %s
```
Pass `conv_id` from the `call` dict (already returned by `load_data`). This makes the "Watch video" link on the EP Review page actually work.

---

**Priority 4 (connect generate.py → Instantly — 1–2 hours):**

> Merge the Instantly push into `generate.py` so video generation and outreach are a single run.

Plan in `generate.py`:
1. After `upload_to_bunny()` returns URL, call `write_loom_url_to_ghl()` (existing).
2. Write video_url to DB (Priority 3 above).
3. Look up GHL contact email (already fetched in `_ghl_contact()` — `contact.get("email")`).
4. Call Instantly `POST /api/v2/leads/add` with `video_url` (or whatever the correct variable name is from Priority 2).
5. On success, write `instantly_lead_id` to the DB (`instantly_lead_id` column already exists).

Do not make this auto-trigger from the webhook. Keep it manual for now — run `python generate.py [--phone N]` intentionally per approved lead.

---

**Priority 5 (add 3 missing eval criteria to deriveCallResult — 30 minutes):**

File: `src/services/epHandler.js`, function `deriveCallResult` (~line 26).

Plan:
- Add `BUSINESS_AFTER_HOURS_DENIED` → return `'denied_after_hours'`
- Add `VOICEMAIL_GREETING_CAPTURED` → return `'voicemail_greeting'`
- Add `BUSINESS_CONFIRMED_AFTER_HOURS` → return `'confirmed_after_hours'`
- Set priority in `RESULT_PRIORITY` dict (line 18): `voicemail: 3, dispatcher_blown: 2, live_pickup: 1, denied_after_hours: 4, voicemail_greeting: 2, confirmed_after_hours: 0`
- Update `FIELD_NAME_HINTS` if GHL has new custom fields to receive these values.
- Note: the 96 existing `unknown` calls are all genuinely no-answer calls (all 6 criteria = failure). No backfill needed.

---

**Priority 6 (batch retry stuck audio — 1 hour):**

Plan: write a one-time script `scripts/retry-pending-audio.js` that:
1. Queries `SELECT conversation_id FROM elevenlabs_calls WHERE audio_fetch_status='pending' AND is_ep=TRUE`
2. For each, calls `audio.fetchAndStore(convId, {})` (existing function in `elevenlabsAudio.js`)
3. On success, calls `epHandler.finalizeEpRecording(convId, url)` to write GHL recording URL
4. Runs once via `node scripts/retry-pending-audio.js` locally — doesn't need to deploy

Don't run this until after Priority 1 is shipped. The pending calls are still within ElevenLabs' 90-day retention window (April calls → safe until July).

---

**Priority 7 (add missing DB columns to migrations — 30 minutes, low risk):**

The following columns exist in the live DB but are in no migration file:
- `review_status TEXT`
- `outcome_type TEXT`
- `review_notes TEXT`
- `video_url TEXT`
- `video_processed_at TIMESTAMPTZ`
- `instantly_lead_id TEXT`

Plan: create `db/migrations/004_add_ep_review_columns.sql` with idempotent `IF NOT EXISTS` column adds (same pattern as `002_add_call_number.sql`). Commit and push — on next Railway redeploy, migrations run and the columns are formally documented. This protects against DB reset.

---

## Risk Flags

1. **Do not change `initial_wait_time` without testing.** Memory shows Jeremiah signed off on the current voicemail behavior. Only change `turn_timeout` and `silence_end_call_timeout` for the second-turn fix (Priority 1).

2. **Do not change the system prompt.** The existing prompt is well-crafted and producing correct `VOICEMAIL_HIT=success` results. The second-turn bug is a timer config issue, not a prompt issue.

3. **Do not add auto-trigger from webhook to video pipeline.** The video generation pipeline uses Playwright (headless Chrome) + FFmpeg, both local dependencies on your Windows machine. A Railway-side trigger would fail because neither is available in the Railway container. Keep trigger manual until the pipeline is containerized (not planned).

4. **94 calls have `ghl_update_status='skipped_no_contact'`.** This means the phone number from ElevenLabs didn't match any contact in GHL. Before assuming these are data quality issues, verify that the GHL contact search is using normalized E.164 format (it is — `normalizePhone()` in `elevenlabsStore.js` is correct). These are likely real gaps in the lead list (numbers were called that don't have GHL records).

5. **The `call_limits.daily_limit=500` on the agent is fine** for current volume (avg ~50 calls/day peak). Do not increase without understanding the Twilio rate limits on the 4 assigned numbers.

6. **3 GHL write failures.** These are live in the DB (`ghl_update_status='failed'`). Before touching them, check Railway logs for their conversation_ids to see what GHL error occurred. They may be stale (contact deleted in GHL) or may indicate a PIT token expiry. `PH_MAIN_PIT = 'pit-4bfd7709-87ff-49ba-acf3-96853845ac26'` is hardcoded in epHandler.js — if that token expires, all GHL writes will fail silently.

---

*Diagnosis generated 2026-05-05. All data from Railway Postgres (public proxy) and ElevenLabs API (read-only). No changes made.*
