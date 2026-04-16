const express = require('express');
const db = require('../db');
const logger = require('../services/logger');

const router = express.Router();

router.get('/pending-changes', async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    const q = await db.query(
      `SELECT id, source, change_type, description, example_conversation_id,
              proposed_by, status, created_at, resolved_at
       FROM pending_prompt_changes
       WHERE status = $1
       ORDER BY created_at DESC LIMIT 200`,
      [status]
    );

    const byStatusQ = await db.query(
      `SELECT status, COUNT(*)::int AS count FROM pending_prompt_changes GROUP BY status`
    );
    const counts = { pending: 0, applied: 0, rejected: 0 };
    for (const r of byStatusQ.rows) counts[r.status] = r.count;

    const bySourceQ = await db.query(
      `SELECT source, COUNT(*)::int AS count FROM pending_prompt_changes
       WHERE status = 'pending' GROUP BY source`
    );
    const bySource = {};
    for (const r of bySourceQ.rows) bySource[r.source || 'unknown'] = r.count;

    res.json({ changes: q.rows, counts, pending_by_source: bySource });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/pending-changes', async (req, res) => {
  try {
    const { source, change_type, description, example_conversation_id } = req.body || {};
    if (!description) return res.status(400).json({ error: 'description required' });
    const q = await db.query(
      `INSERT INTO pending_prompt_changes (source, change_type, description, example_conversation_id, proposed_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at`,
      [source || null, change_type || null, description, example_conversation_id || null, req.session?.username || null]
    );
    logger.log('pending_changes', 'info', null, 'Pending change added', {
      source, change_type, by: req.session?.username, id: q.rows[0].id
    });
    res.json({ ok: true, id: q.rows[0].id, created_at: q.rows[0].created_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/pending-changes/:id/resolve', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { status } = req.body || {};
    if (!['applied', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'status must be applied or rejected' });
    }
    const q = await db.query(
      `UPDATE pending_prompt_changes SET status = $1, resolved_at = NOW() WHERE id = $2
       RETURNING id, status`,
      [status, id]
    );
    if (!q.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/pending-changes/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const q = await db.query(`DELETE FROM pending_prompt_changes WHERE id = $1 RETURNING id`, [id]);
    if (!q.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
