const axios = require('axios');
const store = require('./elevenlabsStore');
const logger = require('./logger');

const EP_AGENT_ID = 'agent_2001kpf1b4vme47vjawagajw23e4';
const EP_AGENT_NAME_HINT = 'after hours research caller';

const PH_MAIN_LOCATION_ID = process.env.PH_MAIN_LOCATION_ID || 'K9xKBbQkhSOUZs6KzTAy';
const PH_MAIN_PIT = process.env.PH_MAIN_PIT || process.env.PH_MAIN_PIT_TOKEN || 'pit-4bfd7709-87ff-49ba-acf3-96853845ac26';
const EP_CUSTOM_FIELD_FOLDER_ID = 'mUU1VNIjwVXTbevAtRen';

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

// Call-result priority: we always write the DB row, but only let the *worst*
// outcome update GHL. Voicemail is the juiciest for Jeremiah's VSL, so it
// wins; unknown never wins over a real result.
const RESULT_PRIORITY = { voicemail: 3, dispatcher_blown: 2, live_pickup: 1, unknown: 0, null: 0 };

function isEpCall(agentId, agentName) {
  if (agentId === EP_AGENT_ID) return true;
  if (agentName && String(agentName).toLowerCase().includes(EP_AGENT_NAME_HINT)) return true;
  return false;
}

function deriveCallResult(evaluation) {
  if (!evaluation || typeof evaluation !== 'object') return 'unknown';
  const vm = evaluation.VOICEMAIL_HIT?.result;
  const db = evaluation.DISPATCHER_BLOWN?.result;
  const lp = evaluation.LIVE_PICKUP?.result;
  if (vm === 'success') return 'voicemail';
  if (db === 'success') return 'dispatcher_blown';
  if (lp === 'success') return 'live_pickup';
  return 'unknown';
}

function dayOfWeekFromUnix(unixSecs, tz) {
  if (!unixSecs) return null;
  try {
    const d = new Date(unixSecs * 1000);
    const fmt = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: tz || 'America/Chicago' });
    return fmt.format(d);
  } catch {
    return new Date(unixSecs * 1000).toLocaleDateString('en-US', { weekday: 'long' });
  }
}

function authHeaders() {
  return {
    Authorization: `Bearer ${PH_MAIN_PIT}`,
    Version: GHL_VERSION,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
}

// GHL requires a +E164 phone lookup. We normalize upstream in the store.
async function lookupContactByPhone(phone) {
  if (!phone) return null;
  try {
    const res = await axios.get(`${GHL_BASE}/contacts/search/duplicate`, {
      headers: authHeaders(),
      params: { locationId: PH_MAIN_LOCATION_ID, number: phone },
      timeout: 15000
    });
    return res.data?.contact || null;
  } catch (err) {
    // 404 is a legitimate "no match" response from GHL; don't noise the log
    const s = err.response?.status;
    if (s !== 404) {
      logger.log('ep', 'warn', null, 'GHL contact lookup failed', {
        phone, status: s, error: err.response?.data || err.message
      });
    }
    return null;
  }
}

async function listEpFolderFields() {
  try {
    const res = await axios.get(`${GHL_BASE}/locations/${PH_MAIN_LOCATION_ID}/customFields`, {
      headers: authHeaders(),
      timeout: 15000
    });
    const all = res.data?.customFields || [];
    return all.filter((f) => (f.parentId || f.folderId) === EP_CUSTOM_FIELD_FOLDER_ID);
  } catch (err) {
    logger.log('ep', 'warn', null, 'GHL listCustomFields failed', {
      status: err.response?.status, error: err.response?.data || err.message
    });
    return [];
  }
}

// Best-effort name→field matcher. GHL field names vary by tenant; we match
// against substrings so e.g. "EP Call Result" and "call_result" both resolve.
const FIELD_NAME_HINTS = {
  call_result:      ['call result', 'call outcome', 'ep result'],
  call_duration:    ['call duration', 'duration', 'duraction', 'recording duraction', 'recording duration'],
  call_date:        ['call date', 'day called', 'date called', 'call timestamp', 'timestamp'],
  day_of_week:      ['day of week', 'dow', 'day / time of call', 'day of call', 'day / time'],
  call_recording:   ['call recording', 'recording url', 'audio url', 'audio link'],
  call_summary:     ['call summary', 'transcript summary', 'transcript', 'summary'],
  conversation_id:  ['conversation id', 'conv id', 'elevenlabs id'],
  concurrent_call:  ['concurrent call', 'concurrent calls', 'concurrent', 'multi call', 'multi-call', 'burst'],
  call_number:      ['call number', 'call #', 'call count', 'attempt number', 'attempt #', 'nth call']
};

function pickFieldIdByHints(fields, hints) {
  if (!fields?.length) return null;
  const lower = (s) => String(s || '').toLowerCase();
  for (const h of hints) {
    const match = fields.find((f) => lower(f.name).includes(h) || lower(f.key).includes(h.replace(/\s+/g, '_')));
    if (match) return { id: match.id, name: match.name, key: match.key };
  }
  return null;
}

function buildFieldMapping(fields) {
  const map = {};
  for (const [logical, hints] of Object.entries(FIELD_NAME_HINTS)) {
    const hit = pickFieldIdByHints(fields, hints);
    if (hit) map[logical] = hit;
  }
  return map;
}

async function updateContactCustomFields(contactId, customFields) {
  try {
    const res = await axios.put(
      `${GHL_BASE}/contacts/${contactId}`,
      { customFields },
      { headers: authHeaders(), timeout: 15000 }
    );
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, status: err.response?.status, error: err.response?.data || err.message };
  }
}

// Given pre-fetched siblings (same phone, last 10 min, self excluded), decide
// whether the current call's result should overwrite the existing GHL update.
// Voicemail beats live_pickup beats unknown, etc. On ties, the shorter
// duration wins — a shorter voicemail is more awkward/raw in the VSL video,
// which Jeremiah wants to feature. Strict tie goes to the existing update
// so we don't thrash for identical-duration pairs.
function shouldProceedGivenSiblings(callResult, currentDurationSecs, siblings) {
  if (!siblings.length) return true;
  const myRank = RESULT_PRIORITY[callResult] ?? 0;
  const existingUpdates = siblings.filter((s) => s.ghl_update_status === 'success');
  if (!existingUpdates.length) return true;
  const highestExisting = Math.max(...existingUpdates.map((s) => RESULT_PRIORITY[s.call_result] ?? 0));
  if (myRank > highestExisting) return true;
  if (myRank < highestExisting) return false;
  // Tied on result rank: pick shortest duration for VSL impact.
  const peers = existingUpdates.filter((s) => (RESULT_PRIORITY[s.call_result] ?? 0) === myRank);
  const shortestPeer = peers.reduce((min, s) => {
    const d = Number(s.duration_secs);
    if (!Number.isFinite(d)) return min;
    return min === null || d < min ? d : min;
  }, null);
  const myDur = Number(currentDurationSecs);
  if (!Number.isFinite(myDur)) return false;
  if (shortestPeer === null) return true;
  return myDur < shortestPeer;
}

async function processEpCall({ payload, row, conversationId, dryRun }) {
  const evaluation = row.evaluation_criteria;
  const callResult = deriveCallResult(evaluation);
  const tz = row.dynamic_variables?.system__timezone || 'America/Chicago';
  const startSecs = payload?.metadata?.start_time_unix_secs;
  const dow = dayOfWeekFromUnix(startSecs, tz);

  const siblings = row.external_number
    ? await store.findRecentByPhone(row.external_number, 10, conversationId)
    : [];
  const concurrentCall = siblings.length > 0 ? 'yes' : 'no';
  const callNumber = siblings.length + 1;

  await store.setEpMetadata(conversationId, {
    is_ep: true,
    call_result: callResult,
    day_of_week_called: dow,
    call_number: callNumber
  });

  if (dryRun) {
    logger.log('ep', 'info', conversationId, 'EP dryRun — skipping GHL lookup/update', {
      call_result: callResult, day_of_week_called: dow, phone: row.external_number,
      concurrent_call: concurrentCall, call_number: callNumber
    });
    await store.setGhlContact(conversationId, null, 'skipped_dry_run');
    return { dryRun: true, call_result: callResult, day_of_week_called: dow, concurrent_call: concurrentCall, call_number: callNumber };
  }

  const contact = await lookupContactByPhone(row.external_number);
  if (!contact || !contact.id) {
    logger.log('ep', 'info', conversationId, 'No GHL contact matched', { phone: row.external_number });
    await store.setGhlContact(conversationId, null, 'skipped_no_contact');
    return { contact: null, call_result: callResult, day_of_week_called: dow };
  }

  await store.setGhlContact(conversationId, contact.id, 'pending');

  const folderFields = await listEpFolderFields();
  const fieldMap = buildFieldMapping(folderFields);

  const proceed = shouldProceedGivenSiblings(callResult, row.duration_secs, siblings);
  if (!proceed) {
    logger.log('ep', 'info', conversationId, 'Skipping main GHL update — sibling with better result already synced', {
      phone: row.external_number, call_result: callResult
    });
    // Still push concurrent_call=yes so a late-arriving low-priority call doesn't
    // leave the contact marked as non-concurrent when it actually was a burst.
    if (fieldMap.concurrent_call) {
      const flagRes = await updateContactCustomFields(contact.id, [
        { id: fieldMap.concurrent_call.id, key: fieldMap.concurrent_call.key, field_value: 'yes' }
      ]);
      if (!flagRes.ok) {
        logger.log('ep', 'warn', conversationId, 'concurrent_call-only GHL update failed', {
          contact_id: contact.id, status: flagRes.status, error: flagRes.error
        });
      }
    }
    await store.setGhlContact(conversationId, contact.id, 'skipped_dedup');
    return { contact, call_result: callResult, day_of_week_called: dow, dedup: true, concurrent_call: concurrentCall };
  }

  const customFields = [];
  const unmatched = [];
  const push = (logical, value) => {
    if (value === null || value === undefined || value === '') return;
    const hit = fieldMap[logical];
    if (!hit) { unmatched.push({ logical, value }); return; }
    customFields.push({ id: hit.id, key: hit.key, field_value: String(value) });
  };

  push('call_result', callResult);
  push('call_duration', row.duration_secs);
  push('call_date', row.start_time);
  push('day_of_week', dow);
  push('call_summary', row.transcript_summary);
  push('conversation_id', conversationId);
  push('concurrent_call', concurrentCall);
  push('call_number', callNumber);
  // call_recording populated later by elevenlabsAudio.finalizeEpRecording

  if (unmatched.length) {
    logger.log('ep', 'warn', conversationId, 'Unmatched EP custom fields', { unmatched });
  }

  if (!customFields.length) {
    await store.setGhlContact(conversationId, contact.id, 'skipped_no_fields');
    return { contact, call_result: callResult, day_of_week_called: dow, concurrent_call: concurrentCall, unmatched };
  }

  const res = await updateContactCustomFields(contact.id, customFields);
  if (res.ok) {
    await store.setGhlContact(conversationId, contact.id, 'success');
    logger.log('ep', 'info', conversationId, 'GHL custom fields updated', {
      contact_id: contact.id, fields: customFields.length
    });
  } else {
    await store.setGhlContact(conversationId, contact.id, 'failed');
    logger.log('ep', 'error', conversationId, 'GHL custom-field update failed', {
      contact_id: contact.id, status: res.status, error: res.error
    });
  }
  return { contact, call_result: callResult, day_of_week_called: dow, concurrent_call: concurrentCall, ghlResult: res, unmatched };
}

async function finalizeEpRecording(conversationId, audioUrl) {
  const row = await store.getByConversationId(conversationId);
  if (!row || !row.is_ep || !row.ghl_contact_id || row.ghl_update_status !== 'success') return;
  const folderFields = await listEpFolderFields();
  const fieldMap = buildFieldMapping(folderFields);
  const recHit = fieldMap.call_recording;
  if (!recHit) {
    logger.log('ep', 'warn', conversationId, 'No call_recording custom field in EP folder; skipping GHL recording update', {});
    return;
  }
  // Use the public /recording/ path so prospects can play the audio from
  // the outreach email without needing dashboard auth.
  const base = (process.env.PUBLIC_BASE_URL || 'https://web-production-f3109.up.railway.app').replace(/\/$/, '');
  const publicUrl = `${base}/recording/${encodeURIComponent(conversationId)}`;
  const res = await updateContactCustomFields(row.ghl_contact_id, [
    { id: recHit.id, key: recHit.key, field_value: publicUrl }
  ]);
  if (!res.ok) {
    logger.log('ep', 'error', conversationId, 'GHL recording-url update failed', {
      contact_id: row.ghl_contact_id, status: res.status, error: res.error
    });
  }
}

module.exports = {
  EP_AGENT_ID,
  isEpCall,
  deriveCallResult,
  dayOfWeekFromUnix,
  processEpCall,
  finalizeEpRecording
};
