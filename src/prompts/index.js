const standardDefault = require('./standard');
const californiaDefault = require('./california');
const client = require('./client');
const application = require('./application');
const knowledgeBase = require('./knowledgeBase');
const chiroPrompt = require('./chiro');
const db = require('../db');

const RESPONSE_FORMAT = `---
RESPONSE FORMAT REQUIREMENT:
You must respond with a JSON object and NOTHING else. No markdown, no backticks, no explanation outside the JSON. The format:

{
  "messages": ["first SMS message text", "optional second SMS message text"],
  "collected_data": {
    "age": "value or null",
    "smoker": "value or null",
    "health": "value or null",
    "coverage_amount": "value or null",
    "coverage_for": "value or null",
    "spouse_name": "value or null",
    "preferred_time": "value or null",
    "appointment_time": "value or null",
    "decision_maker_confirmed": true/false/null,
    "spouse_on_call": true/false/null,
    "ai_voice_consent": "value or null",
    "health_flag": true/false/null,
    "tied_down": true/false/null,
    "call_sentiment": "value or null",
    "objection_type": "value or null",
    "motivation_level_1": "value or null",
    "conversation_language": "value or null",
    "call_summary": "value or null"
  },
  "terminal_outcome": null or "appointment_booked" or "advanced_market_booked" or "fex_immediate" or "mp_immediate" or "human_handoff" or "dnc",
  "message_type": "greeting|qualification|objection_handling|scheduling|confirmation|dnc|handoff|general|reschedule|cancel_appointment|post_booking_question|post_booking_chat"
}

RULES FOR THE JSON:
- "messages" array: 1 or 2 strings. Each string MUST be under 320 characters. 160 characters ideal.
- "collected_data": only include fields that were newly collected or confirmed THIS turn. Use null for everything else.
- "terminal_outcome": null unless this turn ends the conversation.
- "message_type": categorize what this turn was about (for analytics).
- Only include non-null values in collected_data.`;

// In-process cache of the DB-saved override to avoid hitting Postgres on every
// webhook. 30-second TTL — short enough that apply-pending changes go live
// quickly without a deploy, long enough that burst traffic doesn't hammer the
// DB. Cleared explicitly by the QC apply-pending route after it writes.
let overrideCache = { text: null, fetchedAt: 0, exists: false };
let chiroOverrideCache = { text: null, fetchedAt: 0, exists: false };
const OVERRIDE_TTL_MS = 30 * 1000;

async function getSavedOverride() {
  const now = Date.now();
  if (now - overrideCache.fetchedAt < OVERRIDE_TTL_MS) return overrideCache;
  try {
    const q = await db.query(
      `SELECT value FROM app_settings WHERE section = 'analyzer_prompt' AND key = 'current'`
    );
    const v = q.rows[0]?.value;
    overrideCache = { text: v || null, fetchedAt: now, exists: !!v };
  } catch {
    overrideCache = { text: null, fetchedAt: now, exists: false };
  }
  return overrideCache;
}

function clearOverrideCache() {
  overrideCache = { text: null, fetchedAt: 0, exists: false };
}

async function getChiroOverride() {
  const now = Date.now();
  if (now - chiroOverrideCache.fetchedAt < OVERRIDE_TTL_MS) return chiroOverrideCache;
  try {
    const q = await db.query(
      `SELECT value FROM app_settings WHERE section = 'chiro_prompt' AND key = 'current'`
    );
    const v = q.rows[0]?.value;
    chiroOverrideCache = { text: v || null, fetchedAt: now, exists: !!v };
  } catch {
    chiroOverrideCache = { text: null, fetchedAt: now, exists: false };
  }
  return chiroOverrideCache;
}

function clearChiroOverrideCache() {
  chiroOverrideCache = { text: null, fetchedAt: 0, exists: false };
}

async function selectBasePrompt(contactStage, isCa) {
  // Client and application variants are NOT overridden by apply-pending —
  // those are smaller, purpose-built prompts and QC flow targets the lead
  // qualifier only.
  if (contactStage === 'client') return client;
  if (contactStage === 'application') return application;

  const override = await getSavedOverride();

  if (isCa) {
    // Rebuild the CA variant on top of whichever standard base is active so
    // QC corrections flow through to California leads without a deploy.
    // When no override exists, use the precomputed fullText so we don't
    // re-run the regex on every request.
    if (!override.exists) return californiaDefault.fullText;
    return californiaDefault.CA_PREAMBLE + californiaDefault.stripStandardVersionBlock(override.text);
  }
  return override.exists ? override.text : standardDefault;
}

function buildChiroContextBlock(conv) {
  const cfg = (conv.vertical_config && typeof conv.vertical_config === 'object') ? conv.vertical_config : {};
  const doctorName = cfg.doctor_name || conv.agent_name || 'Dr. Johnson';
  const practiceName = cfg.practice_name || 'our practice';
  const officeHours = cfg.office_hours || 'Monday-Friday 8am-6pm';
  const calLink = cfg.calendar_link || '';
  const botName = conv.bot_name || 'Aria';
  return `---
PRACTICE CONTEXT:
- Patient First Name: ${conv.first_name || ''}
- Bot Name: ${botName}
- Doctor: ${doctorName}
- Practice Name: ${practiceName}
- Office Hours: ${officeHours}
- Booking Link: ${calLink}

Replace [BOT_NAME] with "${botName}", [DOCTOR] with "${doctorName}", [PRACTICE_NAME] with "${practiceName}" in all responses.
`;
}

function buildContextBlock(conv) {
  const leadTypeLabel = conv.product_type === 'mp'
    ? 'mortgage protection'
    : conv.product_type === 'fex'
      ? 'final expense life'
      : (conv.offer || 'life insurance');

  return `---
CONTACT CONTEXT (current data from GHL):
- First Name: ${conv.first_name || ''}
- Product Type: ${conv.product_type || ''} (${conv.offer || ''})
- Lead Type Label: ${leadTypeLabel}
- State: ${conv.state || ''}
- Bot Name: ${conv.bot_name || 'Sarah'}
- Agent Name: ${conv.agent_name || 'Jeremiah'}
- Agent Phone: ${conv.agent_phone || ''}
- Agent Business Card: ${conv.agent_business_card_url || ''}
- Meeting Type: ${conv.meeting_type || 'Phone'}
- Existing DOB: ${conv.existing_dob || ''}
- Existing Age: ${conv.existing_age || ''}
- Existing Smoker: ${conv.existing_smoker || ''}
- Existing Health: ${conv.existing_health || ''}
- Existing Spouse: ${conv.existing_spouse_name || ''}
- Existing Mortgage Balance: ${conv.existing_mortgage_balance || ''}
- Existing Coverage Subject: ${conv.existing_coverage_subject || ''}
- Language: ${conv.language || ''}
- Marketplace Type: ${conv.marketplace_type || ''}
- Consent Status: ${conv.consent_status || ''}

GHL DRIP MESSAGE HISTORY (messages sent before bot engaged):
${conv.ghl_message_history || '(none)'}
`;
}

async function buildSystemPrompt(conv) {
  if (conv.vertical === 'chiro') {
    const override = await getChiroOverride();
    const base = override.exists ? override.text : chiroPrompt;
    const context = buildChiroContextBlock(conv);
    return `${base}\n\n${context}\n\n${RESPONSE_FORMAT}`;
  }
  const base = await selectBasePrompt(conv.contact_stage, conv.is_ca);
  const context = buildContextBlock(conv);
  return `${base}\n\n${context}\n\n${RESPONSE_FORMAT}\n\n=== KNOWLEDGE BASE ===\n\n${knowledgeBase}`;
}

module.exports = { buildSystemPrompt, selectBasePrompt, clearOverrideCache, clearChiroOverrideCache };
