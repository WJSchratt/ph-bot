function safeJsonParse(value) {
  if (!value || typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

function pickField(body, field) {
  const candidates = [
    body?.customData?.[field],
    body?.[field],
    body?.body?.[field],
  ];
  for (const v of candidates) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return '';
}

function extractMessageBody(payload) {
  if (payload?.message?.body && typeof payload.message.body === 'string') {
    return payload.message.body.trim();
  }
  if (typeof payload?.message === 'string') {
    return payload.message.trim();
  }
  const bodyMessage = payload?.body?.message;
  if (typeof bodyMessage === 'string') {
    const parsed = safeJsonParse(bodyMessage);
    if (parsed?.body) return String(parsed.body).trim();
    return bodyMessage.trim();
  }
  // GHL puts the message text inside customData.message
  const customMsg = payload?.customData?.message;
  if (typeof customMsg === 'string' && customMsg.trim()) {
    return customMsg.trim();
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
  const body = (raw?.body && typeof raw.body === 'object') ? raw.body : (raw || {});
  const messageBody = extractMessageBody(body);
  const tagList = parseTags(pickField(body, 'tags'));

  const locationId = pickField(body, 'ghl_location_id') || body?.location?.id || '';
  const state = pickField(body, 'state');
  const offer = pickField(body, 'offer');

  return {
    raw,
    messageBody,
    contact_id: pickField(body, 'contact_id'),
    location_id: locationId,
    phone: pickField(body, 'phone'),
    first_name: pickField(body, 'first_name'),
    last_name: pickField(body, 'last_name'),
    state: state,
    product_type: determineProductType(offer),
    contact_stage: determineContactStage(tagList),
    is_ca: determineIsCa(state),

    existing_dob: pickField(body, 'date_of_birth'),
    existing_age: pickField(body, 'age_range'),
    existing_smoker: pickField(body, 'tobacco_use'),
    existing_health: pickField(body, 'health_notes'),
    existing_spouse_name: pickField(body, 'spouse_name'),
    existing_mortgage_balance: pickField(body, 'mortgage_balance'),
    existing_coverage_subject: pickField(body, 'coverage_subject'),

    bot_name: pickField(body, 'bot_name_override') || pickField(body, 'bot_name') || 'Sarah',
    agent_name: pickField(body, 'assigned_agent') || pickField(body, 'agent_name') || 'Jeremiah',
    agent_phone: pickField(body, 'agent_phone'),
    agent_business_card_url: pickField(body, 'agent_business_card_link'),
    calendar_link_fx: pickField(body, 'calendar_link_fx'),
    calendar_link_mp: pickField(body, 'calendar_link_mp'),
    loom_video_fx: pickField(body, 'loom_video_fx'),
    loom_video_mp: pickField(body, 'loom_video_mp'),
    meeting_type: pickField(body, 'meeting_type') || 'Phone',
    ghl_token: pickField(body, 'ghl_token'),
    ghl_message_history: pickField(body, 'ghl_message_history'),
    offer: offer,
    offer_short: pickField(body, 'offer_short'),
    language: (pickField(body, 'language') || '').toLowerCase(),
    marketplace_type: pickField(body, 'marketplace_type'),
    consent_status: pickField(body, 'consent_status'),
    bot_vertical: (pickField(body, 'bot_vertical') || 'insurance').toLowerCase().trim(),
    doctor_name: pickField(body, 'doctor_name'),
    practice_name: pickField(body, 'practice_name'),
    office_hours: pickField(body, 'office_hours'),
    chiro_calendar_link: pickField(body, 'calendar_link'),
    tags: tagList
  };
}

module.exports = { parseInboundPayload, parseTags, safeJsonParse, determineContactStage, determineProductType, determineIsCa };
