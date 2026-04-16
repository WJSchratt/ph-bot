const axios = require('axios');
const logger = require('./logger');

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

// GSM-7 charset check for SMS segment calculation
const GSM7_BASIC = new Set('@\u00a3$\u00a5\u00e8\u00e9\u00f9\u00ec\u00f2\u00c7\n\u00d8\u00f8\r\u00c5\u00e5\u0394_\u03a6\u0393\u039b\u03a9\u03a0\u03a8\u03a3\u0398\u039e \u00c6\u00e6\u00df\u00c9 !"#\u00a4%&\'()*+,-./0123456789:;<=>?\u00a1ABCDEFGHIJKLMNOPQRSTUVWXYZ\u00c4\u00d6\u00d1\u00dc\u00a7\u00bfabcdefghijklmnopqrstuvwxyz\u00e4\u00f6\u00f1\u00fc\u00e0');
function isGsm7(text) {
  for (const ch of text) { if (!GSM7_BASIC.has(ch) && ch !== '{' && ch !== '}' && ch !== '[' && ch !== ']' && ch !== '\\' && ch !== '~' && ch !== '^' && ch !== '|' && ch !== '\u20ac') return false; }
  return true;
}
function calculateSegments(message) {
  if (!message) return 1;
  const gsm = isGsm7(message);
  const len = message.length;
  if (gsm) return len <= 160 ? 1 : Math.ceil(len / 153);
  return len <= 70 ? 1 : Math.ceil(len / 67);
}

async function sendSms(token, contactId, message) {
  return axios.post(
    `${GHL_BASE}/conversations/messages`,
    { type: 'SMS', contactId, message },
    { headers: authHeaders(token), timeout: 15000 }
  );
}

async function sendMessagesSequentially(token, contactId, messages, contact_id_for_log) {
  const cid = contact_id_for_log || contactId;
  logger.log('ghl_send', 'info', cid, 'Sending to GHL', { message_count: messages.length });
  const results = [];
  for (let i = 0; i < messages.length; i++) {
    if (i > 0) await sleep(2000);
    try {
      const res = await sendSms(token, contactId, messages[i]);
      results.push({ ok: true, status: res.status });
    } catch (err) {
      logger.log('error', 'error', cid, 'GHL send failed', { error: err.response?.data || err.message, message_index: i });
      console.error('[ghl] sendSms failed', err.response?.status, err.response?.data || err.message);
      results.push({ ok: false, error: err.response?.data || err.message });
    }
  }
  return results;
}

const SENTIMENT_OPTIONS = new Set(['positive', 'neutral', 'skeptical', 'hostile']);
const OBJECTION_OPTIONS = new Set([
  'not interested', 'too expensive', 'already covered',
  'need to think', 'talk to spouse', 'bad timing', 'other'
]);
const DEACTIVATING_OUTCOMES = new Set(['dnc', 'opted_out', 'opt_out', 'stop_requested']);

const TERMINAL_TO_APPT_OUTCOME = {
  appointment_booked: 'set',
  dnc: 'DNC',
  opted_out: 'DNC',
  opt_out: 'DNC',
  stop_requested: 'DNC',
  human_handoff: 'callback',
  handoff_requested: 'callback',
  fex_immediate: 'callback',
  mp_immediate: 'callback'
};

function toBooleanString(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const s = String(value).toLowerCase().trim();
  if (['true', 'yes', 'y', '1'].includes(s)) return 'true';
  if (['false', 'no', 'n', '0'].includes(s)) return 'false';
  return null;
}

function normalizeSmoker(value) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).toLowerCase().trim();
  if (['no', 'n', 'false', 'non-smoker', 'nonsmoker', 'non smoker', 'never'].includes(s)) return 'no';
  if (['yes', 'y', 'true', 'smoker', 'occasionally', 'socially'].includes(s)) return 'yes';
  return null;
}

function normalizeSentiment(value) {
  if (!value) return null;
  const s = String(value).toLowerCase().trim();
  return SENTIMENT_OPTIONS.has(s) ? s : null;
}

function normalizeObjection(value) {
  if (!value) return null;
  const s = String(value).toLowerCase().trim();
  if (OBJECTION_OPTIONS.has(s)) return s;
  if (s.includes('interest')) return 'not interested';
  if (s.includes('expensive') || s.includes('price') || s.includes('cost')) return 'too expensive';
  if (s.includes('covered') || s.includes('already have')) return 'already covered';
  if (s.includes('think')) return 'need to think';
  if (s.includes('spouse') || s.includes('partner') || s.includes('wife') || s.includes('husband')) return 'talk to spouse';
  if (s.includes('timing') || s.includes('busy')) return 'bad timing';
  return 'other';
}

function normalizeLanguage(value) {
  if (!value) return null;
  const s = String(value).toLowerCase().trim();
  if (['english', 'en', 'eng'].includes(s)) return 'English';
  if (['spanish', 'es', 'esp', 'español', 'espanol'].includes(s)) return 'Spanish';
  return null;
}

function buildCustomFieldsFromConversation(conv) {
  const fields = [];
  const push = (key, value) => {
    if (value === null || value === undefined) return;
    const str = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value).trim();
    if (str === '') return;
    fields.push({ key, field_value: str });
  };

  // TEXT
  push('contact.age_range', conv.collected_age);
  push('contact.health_notes', conv.collected_health);
  push('contact.coverage_subject', conv.collected_coverage_for);
  push('contact.mortgage_balance', conv.collected_coverage_amount);
  push('contact.spouse_name', conv.collected_spouse_name);
  push('contact.appointment_time', conv.collected_appointment_time);
  push('contact.call_summary', conv.call_summary);
  push('contact.motivation_level_1', conv.motivation_level_1);

  // SINGLE_OPTIONS — yes/no
  const smoker = normalizeSmoker(conv.collected_smoker);
  if (smoker) push('contact.tobacco_use', smoker);

  // SINGLE_OPTIONS — true/false
  const healthFlag = toBooleanString(conv.health_flag);
  if (healthFlag !== null) push('contact.health_flag', healthFlag);
  const aiConsent = toBooleanString(conv.ai_voice_consent);
  if (aiConsent !== null) push('contact.ai_voice_consent', aiConsent);
  const dmConfirmed = toBooleanString(conv.decision_maker_confirmed);
  if (dmConfirmed !== null) push('contact.decision_maker_confirmed', dmConfirmed);

  // SINGLE_OPTIONS — picklist values
  const sentiment = normalizeSentiment(conv.call_sentiment);
  if (sentiment) push('contact.call_sentiment', sentiment);
  const objection = normalizeObjection(conv.objection_type);
  if (objection) push('contact.objection_type', objection);

  // MULTIPLE_OPTIONS
  const lang = normalizeLanguage(conv.conversation_language);
  if (lang) push('contact.language', lang);

  // Derived: dnc_requested from terminal_outcome
  if (DEACTIVATING_OUTCOMES.has(conv.terminal_outcome)) {
    push('contact.dnc_requested', 'true');
  }

  // Derived: appointment_outcome from terminal_outcome
  const apptOutcome = conv.terminal_outcome ? TERMINAL_TO_APPT_OUTCOME[conv.terminal_outcome] : null;
  if (apptOutcome) push('contact.appointment_outcome', apptOutcome);

  return fields;
}

async function updateContactFields(token, contactId, conv, contactIdForLog) {
  const customFields = buildCustomFieldsFromConversation(conv);
  const cid = contactIdForLog || contactId;
  if (!customFields.length) {
    logger.log('field_sync', 'info', cid, 'No fields to sync (all empty)', {});
    return { ok: true, skipped: true, fields_count: 0 };
  }

  logger.log('field_sync', 'info', cid, 'Sending fields to GHL', { fields: customFields });

  try {
    const res = await axios.put(
      `${GHL_BASE}/contacts/${contactId}`,
      { customFields },
      { headers: authHeaders(token), timeout: 15000 }
    );
    logger.log('field_sync', 'info', cid, 'Contact fields synced to GHL', {
      fields_count: customFields.length,
      status: res.status
    });
    return { ok: true, status: res.status, fields_count: customFields.length, fields: customFields };
  } catch (err) {
    logger.log('field_sync', 'error', cid, 'Field sync failed', {
      status: err.response?.status,
      error: err.response?.data || err.message,
      fields_count: customFields.length
    });
    return { ok: false, error: err.response?.data || err.message, status: err.response?.status };
  }
}

async function clearContactDnd(token, contactId, contactIdForLog) {
  const cid = contactIdForLog || contactId;
  try {
    const res = await axios.put(
      `${GHL_BASE}/contacts/${contactId}`,
      {
        dnd: false,
        dndSettings: {
          SMS: { status: 'inactive', message: '', code: '' }
        }
      },
      { headers: authHeaders(token), timeout: 15000 }
    );
    logger.log('ghl_send', 'info', cid, 'Contact DND cleared', { status: res.status });
    return { ok: true, status: res.status };
  } catch (err) {
    logger.log('ghl_send', 'error', cid, 'clearContactDnd failed', {
      status: err.response?.status,
      error: err.response?.data || err.message
    });
    return { ok: false, error: err.response?.data || err.message };
  }
}

async function removeContactTags(token, contactId, tags, contactIdForLog) {
  const cid = contactIdForLog || contactId;
  try {
    const res = await axios.delete(
      `${GHL_BASE}/contacts/${contactId}/tags`,
      { headers: authHeaders(token), data: { tags }, timeout: 15000 }
    );
    logger.log('ghl_send', 'info', cid, 'Contact tags removed', { tags, status: res.status });
    return { ok: true, status: res.status };
  } catch (err) {
    logger.log('ghl_send', 'error', cid, 'removeContactTags failed', {
      tags,
      status: err.response?.status,
      error: err.response?.data || err.message
    });
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
  buildCustomFieldsFromConversation,
  setContactDnd,
  clearContactDnd,
  removeContactTags,
  calculateSegments,
  sleep
};
