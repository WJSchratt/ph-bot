const db = require('../db');

function normalizePhone(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s.startsWith('+')) return s;
  const digits = s.replace(/\D+/g, '');
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

function parsePayload(body) {
  const data = body && body.data ? body.data : body;
  const type = (body && body.type) || null;
  return { data: data || {}, type };
}

function extractRow(payload) {
  const data = payload || {};
  const meta = data.metadata || {};
  // phone_call lives inside metadata in the real ElevenLabs payload; some older
  // docs (and our prompt) showed it at the top. Accept either to be safe.
  const phone = meta.phone_call || data.phone_call || {};
  const analysis = data.analysis || {};
  const cic = data.conversation_initiation_client_data || {};

  const startSecs = meta.start_time_unix_secs;
  const startTime = startSecs ? new Date(startSecs * 1000).toISOString() : null;

  return {
    conversation_id: data.conversation_id,
    agent_id: data.agent_id || null,
    agent_name: data.agent_name || null,
    status: data.status || null,
    call_direction: phone.direction || null,
    external_number: normalizePhone(phone.external_number),
    agent_number: normalizePhone(phone.agent_number),
    call_sid: phone.call_sid || null,
    start_time: startTime,
    duration_secs: meta.call_duration_secs ?? null,
    cost_credits: meta.cost ?? null,
    termination_reason: data.termination_reason || null,
    call_successful: analysis.call_successful || null,
    transcript_summary: analysis.transcript_summary || null,
    call_summary_title: analysis.call_summary_title || null,
    evaluation_criteria: analysis.evaluation_criteria_results || null,
    transcript: data.transcript || null,
    dynamic_variables: cic.dynamic_variables || null,
    has_audio: !!data.has_audio
  };
}

async function upsertBase(row, rawPayload) {
  const sql = `
    INSERT INTO elevenlabs_calls (
      conversation_id, agent_id, agent_name, status,
      call_direction, external_number, agent_number, call_sid,
      start_time, duration_secs, cost_credits, termination_reason,
      call_successful, transcript_summary, call_summary_title,
      evaluation_criteria, transcript, dynamic_variables, raw_payload,
      has_audio
    ) VALUES (
      $1,$2,$3,$4,
      $5,$6,$7,$8,
      $9,$10,$11,$12,
      $13,$14,$15,
      $16,$17,$18,$19,
      $20
    )
    ON CONFLICT (conversation_id) DO UPDATE SET
      agent_id            = EXCLUDED.agent_id,
      agent_name          = EXCLUDED.agent_name,
      status              = EXCLUDED.status,
      call_direction      = EXCLUDED.call_direction,
      external_number     = EXCLUDED.external_number,
      agent_number        = EXCLUDED.agent_number,
      call_sid            = EXCLUDED.call_sid,
      start_time          = EXCLUDED.start_time,
      duration_secs       = EXCLUDED.duration_secs,
      cost_credits        = EXCLUDED.cost_credits,
      termination_reason  = EXCLUDED.termination_reason,
      call_successful     = EXCLUDED.call_successful,
      transcript_summary  = EXCLUDED.transcript_summary,
      call_summary_title  = EXCLUDED.call_summary_title,
      evaluation_criteria = EXCLUDED.evaluation_criteria,
      transcript          = EXCLUDED.transcript,
      dynamic_variables   = EXCLUDED.dynamic_variables,
      raw_payload         = EXCLUDED.raw_payload,
      has_audio           = EXCLUDED.has_audio,
      updated_at          = NOW()
    RETURNING *`;
  const params = [
    row.conversation_id, row.agent_id, row.agent_name, row.status,
    row.call_direction, row.external_number, row.agent_number, row.call_sid,
    row.start_time, row.duration_secs, row.cost_credits, row.termination_reason,
    row.call_successful, row.transcript_summary, row.call_summary_title,
    row.evaluation_criteria ? JSON.stringify(row.evaluation_criteria) : null,
    row.transcript ? JSON.stringify(row.transcript) : null,
    row.dynamic_variables ? JSON.stringify(row.dynamic_variables) : null,
    rawPayload ? JSON.stringify(rawPayload) : null,
    row.has_audio
  ];
  const r = await db.query(sql, params);
  return r.rows[0];
}

async function setEpMetadata(conversationId, { is_ep, call_result, day_of_week_called }) {
  await db.query(
    `UPDATE elevenlabs_calls SET is_ep=$2, call_result=$3, day_of_week_called=$4, updated_at=NOW() WHERE conversation_id=$1`,
    [conversationId, !!is_ep, call_result || null, day_of_week_called || null]
  );
}

async function setGhlContact(conversationId, contactId, status) {
  await db.query(
    `UPDATE elevenlabs_calls SET ghl_contact_id=$2, ghl_update_status=$3, updated_at=NOW() WHERE conversation_id=$1`,
    [conversationId, contactId || null, status]
  );
}

async function setAudio(conversationId, { status, mime, bytes, url }) {
  await db.query(
    `UPDATE elevenlabs_calls
        SET audio_fetch_status=$2, audio_mime=$3, audio_bytes=$4, audio_url=$5,
            audio_fetched_at=NOW(), updated_at=NOW()
      WHERE conversation_id=$1`,
    [conversationId, status, mime || null, bytes || null, url || null]
  );
}

async function findRecentByPhone(externalNumber, windowMinutes = 10, excludeConversationId = null) {
  const sql = `
    SELECT conversation_id, call_result, ghl_update_status, start_time
      FROM elevenlabs_calls
     WHERE external_number = $1
       AND start_time >= NOW() - ($2 || ' minutes')::interval
       ${excludeConversationId ? 'AND conversation_id <> $3' : ''}
     ORDER BY start_time DESC`;
  const params = excludeConversationId
    ? [externalNumber, String(windowMinutes), excludeConversationId]
    : [externalNumber, String(windowMinutes)];
  const r = await db.query(sql, params);
  return r.rows;
}

async function getByConversationId(conversationId) {
  const r = await db.query(`SELECT * FROM elevenlabs_calls WHERE conversation_id = $1`, [conversationId]);
  return r.rows[0] || null;
}

async function getAudioBytes(conversationId) {
  const r = await db.query(
    `SELECT audio_mime, audio_bytes FROM elevenlabs_calls WHERE conversation_id = $1`,
    [conversationId]
  );
  return r.rows[0] || null;
}

async function list({ isEp, agentName, startDate, endDate, limit = 50, offset = 0 } = {}) {
  const params = [];
  const filters = [];
  if (isEp === true) filters.push('is_ep = TRUE');
  if (agentName) { params.push(`%${agentName}%`); filters.push(`agent_name ILIKE $${params.length}`); }
  if (startDate) { params.push(startDate); filters.push(`start_time >= $${params.length}`); }
  if (endDate) { params.push(endDate); filters.push(`start_time <= $${params.length}`); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  params.push(limit); const limIdx = params.length;
  params.push(offset); const offIdx = params.length;
  const sql = `
    SELECT conversation_id, agent_id, agent_name, status, call_direction,
           external_number, agent_number, call_sid, start_time, duration_secs,
           cost_credits, termination_reason, call_successful, transcript_summary,
           call_summary_title, evaluation_criteria, dynamic_variables,
           has_audio, audio_url, audio_fetch_status,
           ghl_contact_id, ghl_update_status,
           is_ep, call_result, day_of_week_called, received_at
      FROM elevenlabs_calls
     ${where}
     ORDER BY start_time DESC NULLS LAST, received_at DESC
     LIMIT $${limIdx} OFFSET $${offIdx}`;
  const countSql = `SELECT COUNT(*)::int AS total FROM elevenlabs_calls ${where}`;
  const [rows, count] = await Promise.all([
    db.query(sql, params),
    db.query(countSql, params.slice(0, params.length - 2))
  ]);
  return { rows: rows.rows, total: count.rows[0].total };
}

async function listAgentNames() {
  const r = await db.query(
    `SELECT agent_name, COUNT(*)::int AS count
       FROM elevenlabs_calls
      WHERE agent_name IS NOT NULL
      GROUP BY agent_name
      ORDER BY MAX(start_time) DESC NULLS LAST`
  );
  return r.rows;
}

module.exports = {
  normalizePhone,
  parsePayload,
  extractRow,
  upsertBase,
  setEpMetadata,
  setGhlContact,
  setAudio,
  findRecentByPhone,
  getByConversationId,
  getAudioBytes,
  list,
  listAgentNames
};
