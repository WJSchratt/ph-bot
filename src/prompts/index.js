const standard = require('./standard');
const california = require('./california');
const client = require('./client');
const application = require('./application');
const knowledgeBase = require('./knowledgeBase');

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
  "terminal_outcome": null or "appointment_booked" or "fex_immediate" or "mp_immediate" or "human_handoff" or "dnc",
  "message_type": "greeting|qualification|objection_handling|scheduling|confirmation|dnc|handoff|general"
}

RULES FOR THE JSON:
- "messages" array: 1 or 2 strings. Each string MUST be under 320 characters. 160 characters ideal.
- "collected_data": only include fields that were newly collected or confirmed THIS turn. Use null for everything else.
- "terminal_outcome": null unless this turn ends the conversation.
- "message_type": categorize what this turn was about (for analytics).
- Only include non-null values in collected_data.`;

function selectBasePrompt(contactStage, isCa) {
  if (contactStage === 'client') return client;
  if (contactStage === 'application') return application;
  if (isCa) return california;
  return standard;
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

function buildSystemPrompt(conv) {
  const base = selectBasePrompt(conv.contact_stage, conv.is_ca);
  const context = buildContextBlock(conv);
  return `${base}\n\n${context}\n\n${RESPONSE_FORMAT}\n\n=== KNOWLEDGE BASE ===\n\n${knowledgeBase}`;
}

module.exports = { buildSystemPrompt, selectBasePrompt };
