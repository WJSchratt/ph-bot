const axios = require('axios');

const GHL_BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-04-15';

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Version: VERSION,
    'Content-Type': 'application/json'
  };
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function sendSms(token, contactId, message) {
  return axios.post(
    `${GHL_BASE}/conversations/messages`,
    { type: 'SMS', contactId, message },
    { headers: authHeaders(token), timeout: 15000 }
  );
}

async function sendMessagesSequentially(token, contactId, messages) {
  const results = [];
  for (let i = 0; i < messages.length; i++) {
    if (i > 0) await sleep(2000);
    try {
      const res = await sendSms(token, contactId, messages[i]);
      results.push({ ok: true, status: res.status });
    } catch (err) {
      console.error('[ghl] sendSms failed', err.response?.status, err.response?.data || err.message);
      results.push({ ok: false, error: err.response?.data || err.message });
    }
  }
  return results;
}

function buildCustomFieldsFromConversation(conv) {
  const fields = [];
  const push = (key, value) => {
    if (value === null || value === undefined) return;
    const str = typeof value === 'boolean' ? String(value) : String(value).trim();
    if (str === '') return;
    fields.push({ key, value: str });
  };
  push('age_range', conv.collected_age);
  push('tobacco_use', conv.collected_smoker);
  push('health_notes', conv.collected_health);
  push('coverage_subject', conv.collected_coverage_for);
  push('spouse_name', conv.collected_spouse_name);
  push('health_flag', conv.health_flag);
  push('ai_voice_consent', conv.ai_voice_consent);
  push('call_sentiment', conv.call_sentiment);
  push('objection_type', conv.objection_type);
  push('call_summary', conv.call_summary);
  push('appointment_time', conv.collected_appointment_time);
  push('decision_maker_confirmed', conv.decision_maker_confirmed);
  push('conversation_language', conv.conversation_language);
  push('motivation_level_1', conv.motivation_level_1);
  return fields;
}

async function updateContactFields(token, contactId, conv) {
  const customFields = buildCustomFieldsFromConversation(conv);
  if (!customFields.length) return { ok: true, skipped: true };
  try {
    const res = await axios.put(
      `${GHL_BASE}/contacts/${contactId}`,
      { customFields },
      { headers: authHeaders(token), timeout: 15000 }
    );
    return { ok: true, status: res.status };
  } catch (err) {
    console.error('[ghl] updateContactFields failed', err.response?.status, err.response?.data || err.message);
    return { ok: false, error: err.response?.data || err.message };
  }
}

async function setContactDnd(token, contactId) {
  try {
    const res = await axios.put(
      `${GHL_BASE}/contacts/${contactId}`,
      {
        dnd: true,
        dndSettings: {
          SMS: { status: 'active', message: 'Opted out via SMS bot', code: 'STOP' }
        },
        tags: ['DNC', 'sms-opt-out']
      },
      { headers: authHeaders(token), timeout: 15000 }
    );
    return { ok: true, status: res.status };
  } catch (err) {
    console.error('[ghl] setContactDnd failed', err.response?.status, err.response?.data || err.message);
    return { ok: false, error: err.response?.data || err.message };
  }
}

module.exports = {
  sendMessagesSequentially,
  updateContactFields,
  setContactDnd,
  sleep
};
