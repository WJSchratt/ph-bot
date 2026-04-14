const express = require('express');
const db = require('../db');

const router = express.Router();

function dateRangeClause(startDate, endDate, alias = '') {
  const col = alias ? `${alias}.created_at` : 'created_at';
  const params = [];
  const clauses = [];
  if (startDate) { params.push(startDate); clauses.push(`${col} >= $${params.length}`); }
  if (endDate) { params.push(endDate); clauses.push(`${col} <= $${params.length}`); }
  return { sql: clauses.length ? clauses.join(' AND ') : '', params };
}

router.get('/analytics', async (req, res) => {
  try {
    const { location_id, start_date, end_date } = req.query;

    const params = [];
    const filters = [];
    if (location_id) { params.push(location_id); filters.push(`location_id = $${params.length}`); }
    if (start_date) { params.push(start_date); filters.push(`created_at >= $${params.length}`); }
    if (end_date) { params.push(end_date); filters.push(`created_at <= $${params.length}`); }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const summary = await db.query(
      `SELECT
         COUNT(*)::int AS total_conversations,
         COUNT(*) FILTER (WHERE terminal_outcome = 'appointment_booked')::int AS appointments_booked,
         COUNT(*) FILTER (WHERE terminal_outcome = 'fex_immediate')::int AS fex_immediate,
         COUNT(*) FILTER (WHERE terminal_outcome = 'mp_immediate')::int AS mp_immediate,
         COUNT(*) FILTER (WHERE terminal_outcome = 'human_handoff')::int AS human_handoffs,
         COUNT(*) FILTER (WHERE terminal_outcome = 'dnc')::int AS dnc_count,
         COUNT(*) FILTER (WHERE terminal_outcome IS NOT NULL)::int AS completed
       FROM conversations ${where}`,
      params
    );

    const msgAgg = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE direction = 'inbound')::int AS inbound,
         COUNT(*) FILTER (WHERE direction = 'outbound')::int AS outbound,
         AVG(reply_time_seconds) FILTER (WHERE direction = 'outbound' AND got_reply) AS avg_response_time_seconds
       FROM messages ${where.replace(/created_at/g, 'created_at')}`,
      params
    );

    const perConv = await db.query(
      `SELECT AVG(cnt)::float AS avg_messages_per_conversation FROM (
         SELECT conversation_id, COUNT(*)::int AS cnt
         FROM messages ${where}
         GROUP BY conversation_id
       ) t`,
      params
    );

    const s = summary.rows[0];
    const totalConv = s.total_conversations || 0;
    const appointmentRate = totalConv ? (s.appointments_booked / totalConv) : 0;
    const optOutRate = totalConv ? (s.dnc_count / totalConv) : 0;

    let perLocation = [];
    if (!location_id) {
      const locRes = await db.query(
        `SELECT location_id,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE terminal_outcome = 'appointment_booked')::int AS appointments,
           COUNT(*) FILTER (WHERE terminal_outcome = 'dnc')::int AS dnc
         FROM conversations ${where}
         GROUP BY location_id
         ORDER BY total DESC`,
        params
      );
      perLocation = locRes.rows;
    }

    res.json({
      summary: {
        total_conversations: totalConv,
        conversations_completed: s.completed,
        appointments_booked: s.appointments_booked,
        fex_immediate: s.fex_immediate,
        mp_immediate: s.mp_immediate,
        human_handoffs: s.human_handoffs,
        dnc_count: s.dnc_count,
        appointment_rate: appointmentRate,
        opt_out_rate: optOutRate,
        total_inbound_messages: msgAgg.rows[0].inbound,
        total_outbound_messages: msgAgg.rows[0].outbound,
        avg_messages_per_conversation: perConv.rows[0].avg_messages_per_conversation || 0,
        avg_response_time_seconds: msgAgg.rows[0].avg_response_time_seconds || 0
      },
      per_location: perLocation
    });
  } catch (err) {
    console.error('[analytics] error', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/conversations', async (req, res) => {
  try {
    const { location_id, status, outcome, page = 1, limit = 50 } = req.query;
    const params = [];
    const filters = [];
    if (location_id) { params.push(location_id); filters.push(`location_id = $${params.length}`); }
    if (status === 'active') { filters.push('is_active = TRUE'); }
    else if (status === 'completed') { filters.push('is_active = FALSE'); }
    if (outcome) { params.push(outcome); filters.push(`terminal_outcome = $${params.length}`); }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const lim = Math.min(parseInt(limit, 10) || 50, 200);
    const off = (Math.max(parseInt(page, 10) || 1, 1) - 1) * lim;
    params.push(lim); const limIdx = params.length;
    params.push(off); const offIdx = params.length;

    const rows = await db.query(
      `SELECT id, contact_id, location_id, phone, first_name, last_name, state, product_type,
              contact_stage, terminal_outcome, is_active, last_message_at, created_at,
              jsonb_array_length(messages) AS message_count
       FROM conversations ${where}
       ORDER BY last_message_at DESC NULLS LAST
       LIMIT $${limIdx} OFFSET $${offIdx}`,
      params
    );
    res.json({ conversations: rows.rows });
  } catch (err) {
    console.error('[conversations] error', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/conversations/:contact_id/:location_id', async (req, res) => {
  try {
    const { contact_id, location_id } = req.params;
    const convRes = await db.query(
      `SELECT * FROM conversations WHERE contact_id = $1 AND location_id = $2`,
      [contact_id, location_id]
    );
    if (!convRes.rows.length) return res.status(404).json({ error: 'not found' });
    const msgs = await db.query(
      `SELECT id, direction, content, message_type, got_reply, reply_time_seconds, created_at
       FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [convRes.rows[0].id]
    );
    res.json({ conversation: convRes.rows[0], messages: msgs.rows });
  } catch (err) {
    console.error('[conversation detail] error', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/message-performance', async (req, res) => {
  try {
    const { location_id, start_date, end_date } = req.query;
    const params = [];
    const filters = [`direction = 'outbound'`];
    if (location_id) { params.push(location_id); filters.push(`location_id = $${params.length}`); }
    if (start_date) { params.push(start_date); filters.push(`created_at >= $${params.length}`); }
    if (end_date) { params.push(end_date); filters.push(`created_at <= $${params.length}`); }
    const where = `WHERE ${filters.join(' AND ')}`;

    const result = await db.query(
      `SELECT
         COALESCE(message_type, 'unknown') AS message_type,
         COUNT(*)::int AS total_sent,
         COUNT(*) FILTER (WHERE got_reply)::int AS replies,
         (COUNT(*) FILTER (WHERE got_reply)::float / NULLIF(COUNT(*), 0)) AS reply_rate,
         AVG(reply_time_seconds) FILTER (WHERE got_reply)::float AS avg_reply_time_seconds
       FROM messages ${where}
       GROUP BY 1
       ORDER BY total_sent DESC`,
      params
    );
    res.json({ performance: result.rows });
  } catch (err) {
    console.error('[message-performance] error', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/sync-status', async (req, res) => {
  try {
    const pending = await db.query(
      `SELECT COUNT(*)::int AS pending FROM conversations WHERE fields_dirty = TRUE`
    );
    const lastSync = await db.query(
      `SELECT MAX(last_synced_at) AS last_synced_at FROM conversations`
    );
    res.json({
      pending_syncs: pending.rows[0].pending,
      last_synced_at: lastSync.rows[0].last_synced_at
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
