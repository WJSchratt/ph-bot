const db = require('../db');

const COLLECTED_FIELD_MAP = {
  age: 'collected_age',
  smoker: 'collected_smoker',
  health: 'collected_health',
  coverage_amount: 'collected_coverage_amount',
  coverage_for: 'collected_coverage_for',
  spouse_name: 'collected_spouse_name',
  preferred_time: 'collected_preferred_time',
  appointment_time: 'collected_appointment_time',
  decision_maker_confirmed: 'decision_maker_confirmed',
  spouse_on_call: 'spouse_on_call',
  ai_voice_consent: 'ai_voice_consent',
  health_flag: 'health_flag',
  tied_down: 'tied_down',
  call_sentiment: 'call_sentiment',
  objection_type: 'objection_type',
  motivation_level_1: 'motivation_level_1',
  conversation_language: 'conversation_language',
  call_summary: 'call_summary'
};

async function upsertConversation(parsed, { is_sandbox = false } = {}) {
  const res = await db.query(
    `INSERT INTO conversations (
      contact_id, location_id, phone, first_name, last_name, state, product_type, contact_stage, is_ca,
      existing_dob, existing_age, existing_smoker, existing_health, existing_spouse_name,
      existing_mortgage_balance, existing_coverage_subject,
      bot_name, agent_name, agent_phone, agent_business_card_url,
      calendar_link_fx, calendar_link_mp, loom_video_fx, loom_video_mp, meeting_type,
      ghl_token, ghl_message_history, offer, offer_short, language, marketplace_type, consent_status,
      is_sandbox, last_message_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,
      $10,$11,$12,$13,$14,
      $15,$16,
      $17,$18,$19,$20,
      $21,$22,$23,$24,$25,
      $26,$27,$28,$29,$30,$31,$32,
      $33, NOW()
    )
    ON CONFLICT (contact_id, location_id) DO UPDATE SET
      phone = EXCLUDED.phone,
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      state = EXCLUDED.state,
      product_type = COALESCE(NULLIF(EXCLUDED.product_type, ''), conversations.product_type),
      contact_stage = EXCLUDED.contact_stage,
      is_ca = EXCLUDED.is_ca,
      existing_dob = COALESCE(NULLIF(EXCLUDED.existing_dob, ''), conversations.existing_dob),
      existing_age = COALESCE(NULLIF(EXCLUDED.existing_age, ''), conversations.existing_age),
      existing_smoker = COALESCE(NULLIF(EXCLUDED.existing_smoker, ''), conversations.existing_smoker),
      existing_health = COALESCE(NULLIF(EXCLUDED.existing_health, ''), conversations.existing_health),
      existing_spouse_name = COALESCE(NULLIF(EXCLUDED.existing_spouse_name, ''), conversations.existing_spouse_name),
      existing_mortgage_balance = COALESCE(NULLIF(EXCLUDED.existing_mortgage_balance, ''), conversations.existing_mortgage_balance),
      existing_coverage_subject = COALESCE(NULLIF(EXCLUDED.existing_coverage_subject, ''), conversations.existing_coverage_subject),
      bot_name = EXCLUDED.bot_name,
      agent_name = EXCLUDED.agent_name,
      agent_phone = EXCLUDED.agent_phone,
      agent_business_card_url = EXCLUDED.agent_business_card_url,
      calendar_link_fx = EXCLUDED.calendar_link_fx,
      calendar_link_mp = EXCLUDED.calendar_link_mp,
      loom_video_fx = EXCLUDED.loom_video_fx,
      loom_video_mp = EXCLUDED.loom_video_mp,
      meeting_type = EXCLUDED.meeting_type,
      ghl_token = EXCLUDED.ghl_token,
      ghl_message_history = EXCLUDED.ghl_message_history,
      offer = EXCLUDED.offer,
      offer_short = EXCLUDED.offer_short,
      language = EXCLUDED.language,
      marketplace_type = EXCLUDED.marketplace_type,
      consent_status = EXCLUDED.consent_status,
      is_sandbox = EXCLUDED.is_sandbox,
      last_message_at = NOW(),
      updated_at = NOW()
    RETURNING *`,
    [
      parsed.contact_id, parsed.location_id, parsed.phone, parsed.first_name, parsed.last_name, parsed.state, parsed.product_type, parsed.contact_stage, parsed.is_ca,
      parsed.existing_dob, parsed.existing_age, parsed.existing_smoker, parsed.existing_health, parsed.existing_spouse_name,
      parsed.existing_mortgage_balance, parsed.existing_coverage_subject,
      parsed.bot_name, parsed.agent_name, parsed.agent_phone, parsed.agent_business_card_url,
      parsed.calendar_link_fx, parsed.calendar_link_mp, parsed.loom_video_fx, parsed.loom_video_mp, parsed.meeting_type,
      parsed.ghl_token, parsed.ghl_message_history, parsed.offer, parsed.offer_short, parsed.language, parsed.marketplace_type, parsed.consent_status,
      is_sandbox
    ]
  );
  return res.rows[0];
}

async function appendMessageHistory(conversationId, role, content) {
  await db.query(
    `UPDATE conversations
     SET messages = messages || $1::jsonb,
         last_message_at = NOW(),
         updated_at = NOW()
     WHERE id = $2`,
    [JSON.stringify([{ role, content, timestamp: new Date().toISOString() }]), conversationId]
  );
}

async function logMessage({ conversationId, contactId, locationId, direction, content, messageType, segments }) {
  const res = await db.query(
    `INSERT INTO messages (conversation_id, contact_id, location_id, direction, content, char_count, message_type, segments)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, created_at`,
    [conversationId, contactId, locationId, direction, content, content?.length || 0, messageType || null, segments || null]
  );
  return res.rows[0];
}

async function updateTokenCounts(conversationId, inputTokens, outputTokens) {
  await db.query(
    `UPDATE conversations
     SET input_tokens = COALESCE(input_tokens, 0) + $1,
         output_tokens = COALESCE(output_tokens, 0) + $2,
         updated_at = NOW()
     WHERE id = $3`,
    [inputTokens || 0, outputTokens || 0, conversationId]
  );
}

async function markReplyToPreviousOutbound(conversationId) {
  await db.query(
    `UPDATE messages m
     SET got_reply = TRUE,
         reply_time_seconds = GREATEST(0, EXTRACT(EPOCH FROM (NOW() - m.created_at))::int)
     WHERE m.id = (
       SELECT id FROM messages
       WHERE conversation_id = $1 AND direction = 'outbound' AND got_reply = FALSE
       ORDER BY created_at DESC LIMIT 1
     )`,
    [conversationId]
  );
}

async function applyCollectedData(conversationId, collected) {
  if (!collected || typeof collected !== 'object') return;
  const sets = [];
  const values = [];
  let idx = 1;
  let any = false;
  for (const [key, value] of Object.entries(collected)) {
    if (value === null || value === undefined || value === '') continue;
    const column = COLLECTED_FIELD_MAP[key];
    if (!column) continue;
    sets.push(`${column} = $${idx++}`);
    values.push(value);
    any = true;
  }
  if (!any) return;
  sets.push(`fields_dirty = TRUE`);
  sets.push(`updated_at = NOW()`);
  values.push(conversationId);
  await db.query(
    `UPDATE conversations SET ${sets.join(', ')} WHERE id = $${idx}`,
    values
  );
}

async function setTerminalOutcome(conversationId, outcome) {
  await db.query(
    `UPDATE conversations SET terminal_outcome = $1, is_active = FALSE, updated_at = NOW() WHERE id = $2`,
    [outcome, conversationId]
  );
}

async function reactivateConversation(conversationId) {
  await db.query(
    `UPDATE conversations SET terminal_outcome = NULL, is_active = TRUE, updated_at = NOW() WHERE id = $1`,
    [conversationId]
  );
}

async function deleteSandboxConversation() {
  const res = await db.query(
    `DELETE FROM conversations WHERE contact_id = 'sandbox_user' AND location_id = 'sandbox_location' RETURNING id`
  );
  return res.rowCount > 0;
}

module.exports = {
  upsertConversation,
  appendMessageHistory,
  logMessage,
  markReplyToPreviousOutbound,
  applyCollectedData,
  setTerminalOutcome,
  reactivateConversation,
  deleteSandboxConversation,
  updateTokenCounts
};
