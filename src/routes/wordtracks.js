const express = require('express');
const db = require('../db');
const router = express.Router();

router.get('/wordtracks', async (req, res) => {
  try {
    const { location_id, location_ids, days = 30, sort_by = 'total_sent', sort_dir = 'desc' } = req.query;
    const params = [];
    const filters = [`m.direction = 'outbound'`];
    params.push(parseInt(days, 10) || 30);
    filters.push(`m.created_at >= NOW() - ($${params.length} || ' days')::interval`);
    const locIds = location_ids ? location_ids.split(',').map(s => s.trim()).filter(Boolean) : (location_id ? [location_id] : []);
    if (locIds.length) { params.push(locIds); filters.push(`m.location_id = ANY($${params.length})`); }
    const where = `WHERE ${filters.join(' AND ')}`;

    const allowedSorts = ['total_sent', 'replies', 'reply_rate', 'opt_outs', 'opt_out_rate', 'bookings', 'booking_rate', 'avg_reply_time'];
    const sortCol = allowedSorts.includes(sort_by) ? sort_by : 'total_sent';
    const dir = sort_dir === 'asc' ? 'ASC' : 'DESC';

    const result = await db.query(
      `SELECT
         COALESCE(m.message_type, 'unknown') AS message_type,
         COUNT(*)::int AS total_sent,
         COUNT(*) FILTER (WHERE m.got_reply)::int AS replies,
         (COUNT(*) FILTER (WHERE m.got_reply)::float / NULLIF(COUNT(*), 0)) AS reply_rate,
         AVG(m.reply_time_seconds) FILTER (WHERE m.got_reply)::float AS avg_reply_time,
         COUNT(DISTINCT CASE WHEN c.terminal_outcome = 'dnc' THEN m.conversation_id END)::int AS opt_outs,
         (COUNT(DISTINCT CASE WHEN c.terminal_outcome = 'dnc' THEN m.conversation_id END)::float / NULLIF(COUNT(DISTINCT m.conversation_id), 0)) AS opt_out_rate,
         COUNT(DISTINCT CASE WHEN c.terminal_outcome = 'appointment_booked' THEN m.conversation_id END)::int AS bookings,
         (COUNT(DISTINCT CASE WHEN c.terminal_outcome = 'appointment_booked' THEN m.conversation_id END)::float / NULLIF(COUNT(DISTINCT m.conversation_id), 0)) AS booking_rate,
         COUNT(DISTINCT CASE WHEN c.terminal_outcome = 'human_handoff' THEN m.conversation_id END)::int AS transfers,
         (COUNT(DISTINCT CASE WHEN c.terminal_outcome = 'human_handoff' THEN m.conversation_id END)::float / NULLIF(COUNT(DISTINCT m.conversation_id), 0)) AS transfer_rate,
         COUNT(DISTINCT m.conversation_id)::int AS unique_conversations,
         COALESCE(SUM(m.segments), 0)::int AS total_segments
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id AND c.is_sandbox = FALSE
       ${where}
       GROUP BY 1
       ORDER BY ${sortCol} ${dir}`,
      params
    );

    res.json({ wordtracks: result.rows });
  } catch (err) {
    console.error('[wordtracks] error', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
