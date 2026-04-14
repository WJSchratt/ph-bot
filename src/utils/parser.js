function safeJsonParse(value) {
  if (!value || typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

function extractMessageBody(payload) {
  if (payload?.message?.body && typeof payload.message.body === 'string') {
    return payload.message.body.trim();
  }
  const bodyMessage = payload?.body?.message;
  if (typeof bodyMessage === 'string') {
    const parsed = safeJsonParse(bodyMessage);
    if (parsed?.body) return String(parsed.body).trim();
    return bodyMessage.trim();
  }
  return '';
}

function parseTags(tags) {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.map((t) => String(t).toLowerCase().trim());
  if (typeof tags === 'string') {
    const parsed = safeJsonParse(tags);
    if (Array.isArray(parsed)) return parsed.map((t) => String(t).toLowerCase().trim());
    return tags.split(',').map((t) => t.toLowerCase().trim()).filter(Boolean);
  }
  return [];
}

function determineContactStage(tagList) {
  const hasClient = tagList.some((t) => t === 'fx client' || t === 'mp client');
  if (hasClient) return 'client';
  if (tagList.includes('app-review-pending')) return 'application';
  return 'lead';
}

function determineProductType(offer) {
  if (!offer) return '';
  const lower = String(offer).toLowerCase();
  if (lower.includes('mortgage')) return 'mp';
  if (lower.includes('final expense') || lower.includes('fex')) return 'fex';
  return '';
}

function determineIsCa(state) {
  if (!state) return false;
  const lower = String(state).toLowerCase().trim();
  return lower === 'ca' || lower === 'california';
}

function parseInboundPayload(raw) {
  const body = raw?.body || {};
  const messageBody = extractMessageBody(raw);
  const tagList = parseTags(body.tags);

  return {
    raw,
    messageBody,
    contact_id: body.contact_id,
    location_id: body.ghl_location_id || raw?.location?.id,
    phone: body.phone,
    first_name: body.first_name || '',
    last_name: body.last_name || '',
    state: body.state || '',
    product_type: determineProductType(body.offer),
    contact_stage: determineContactStage(tagList),
    is_ca: determineIsCa(body.state),

    existing_dob: body.date_of_birth || '',
    existing_age: body.age_range || '',
    existing_smoker: body.tobacco_use || '',
    existing_health: body.health_notes || '',
    existing_spouse_name: body.spouse_name || '',
    existing_mortgage_balance: body.mortgage_balance || '',
    existing_coverage_subject: body.coverage_subject || '',

    bot_name: body.bot_name_override || body.bot_name || 'Sarah',
    agent_name: body.assigned_agent || 'Jeremiah',
    agent_phone: body.agent_phone || '',
    agent_business_card_url: body.agent_business_card_link || '',
    calendar_link_fx: body.calendar_link_fx || '',
    calendar_link_mp: body.calendar_link_mp || '',
    loom_video_fx: body.loom_video_fx || '',
    loom_video_mp: body.loom_video_mp || '',
    meeting_type: body.meeting_type || 'Phone',
    ghl_token: body.ghl_token || '',
    ghl_message_history: body.ghl_message_history || '',
    offer: body.offer || '',
    offer_short: body.offer_short || '',
    language: (body.language || '').toLowerCase(),
    marketplace_type: body.marketplace_type || '',
    consent_status: body.consent_status || '',
    tags: tagList
  };
}

module.exports = { parseInboundPayload, parseTags, safeJsonParse };
