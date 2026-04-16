const express = require('express');
const db = require('../db');
const router = express.Router();

router.get('/pipeline', async (req, res) => {
  try {
    const { location_id, days = 30 } = req.query;
    const params = [];
    const filters = ['is_sandbox = FALSE'];
    params.push(parseInt(days, 10) || 30);
    filters.push(`created_at >= NOW() - ($${params.length} || ' days')::interval`);
    if (location_id) { params.push(location_id); filters.push(`location_id = $${params.length}`); }
    const where = `WHERE ${filters.join(' AND ')}`;

    // Funnel by contact_stage + terminal_outcome
    const stageRes = await db.query(
      `SELECT
         contact_stage,
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE is_active)::int AS active,
         COUNT(*) FILTER (WHERE terminal_outcome = 'appointment_booked')::int AS booked,
         COUNT(*) FILTER (WHERE terminal_outcome = 'fex_immediate')::int AS fex_immediate,
         COUNT(*) FILTER (WHERE terminal_outcome = 'mp_immediate')::int AS mp_immediate,
         COUNT(*) FILTER (WHERE terminal_outcome = 'human_handoff')::int AS handoff,
         COUNT(*) FILTER (WHERE terminal_outcome = 'dnc')::int AS dnc,
         COUNT(*) FILTER (WHERE terminal_outcome IS NOT NULL AND terminal_outcome NOT IN ('appointment_booked','fex_immediate','mp_immediate','human_handoff','dnc'))::int AS other_terminal
       FROM conversations ${where}
       GROUP BY contact_stage
       ORDER BY CASE contact_stage
         WHEN 'lead' THEN 1
         WHEN 'application' THEN 2
         WHEN 'client' THEN 3
         ELSE 4
       END`,
      params
    );

    // Outcome breakdown for pipeline funnel
    const outcomeRes = await db.query(
      `SELECT
         COALESCE(terminal_outcome, 'active') AS stage,
         COUNT(*)::int AS count
       FROM conversations ${where}
       GROUP BY 1
       ORDER BY count DESC`,
      params
    );

    res.json({
      stages: stageRes.rows,
      outcomes: outcomeRes.rows
    });
  } catch (err) {
    console.error('[pipeline] error', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
