const express = require('express');
const db = require('../db');
const router = express.Router();

// Get pending QC conversations
router.get('/qc/pending', async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const lim = Math.min(parseInt(limit, 10) || 20, 100);
    const off = (Math.max(parseInt(page, 10) || 1, 1) - 1) * lim;

    const result = await db.query(
      `SELECT c.id, c.contact_id, c.location_id, c.first_name, c.last_name, c.product_type,
              c.contact_stage, c.terminal_outcome, c.ai_self_score, c.last_message_at,
              jsonb_array_length(c.messages) AS message_count,
              COALESCE(s.name, c.location_id) AS subaccount_name
       FROM conversations c
       LEFT JOIN subaccounts s ON s.ghl_location_id = c.location_id
       WHERE c.is_sandbox = FALSE AND c.qc_reviewed = FALSE AND c.terminal_outcome IS NOT NULL
       ORDER BY c.last_message_at DESC
       LIMIT $1 OFFSET $2`,
      [lim, off]
    );

    const countRes = await db.query(
      `SELECT COUNT(*)::int AS total FROM conversations
       WHERE is_sandbox = FALSE AND qc_reviewed = FALSE AND terminal_outcome IS NOT NULL`
    );

    res.json({
      conversations: result.rows,
      total: countRes.rows[0].total,
      page: parseInt(page, 10) || 1,
      limit: lim
    });
  } catch (err) {
    console.error('[qc/pending] error', err);
    res.status(500).json({ error: err.message });
  }
});

// QC review statistics
router.get('/qc/stats', async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const result = await db.query(
      `SELECT
         COUNT(*)::int AS total_reviewed,
         COUNT(*) FILTER (WHERE outcome = 'approved')::int AS approved,
         COUNT(*) FILTER (WHERE outcome = 'failed')::int AS failed,
         COUNT(*) FILTER (WHERE outcome = 'modified')::int AS modified
       FROM qc_reviews
       WHERE created_at >= NOW() - ($1 || ' days')::interval`,
      [parseInt(days, 10) || 30]
    );

    const pendingRes = await db.query(
      `SELECT COUNT(*)::int AS pending FROM conversations
       WHERE is_sandbox = FALSE AND qc_reviewed = FALSE AND terminal_outcome IS NOT NULL`
    );

    const stats = result.rows[0];
    const totalReviewed = stats.total_reviewed || 1;
    res.json({
      ...stats,
      pending: pendingRes.rows[0].pending,
      accuracy: ((stats.approved + stats.modified * 0.6) / totalReviewed * 100).toFixed(1)
    });
  } catch (err) {
    console.error('[qc/stats] error', err);
    res.status(500).json({ error: err.message });
  }
});

// Submit a QC review
router.post('/qc/review', async (req, res) => {
  try {
    const { conversation_id, reviewer, outcome, modified_response, notes } = req.body;
    if (!conversation_id || !reviewer || !outcome) {
      return res.status(400).json({ error: 'conversation_id, reviewer, and outcome are required' });
    }
    if (!['approved', 'failed', 'modified'].includes(outcome)) {
      return res.status(400).json({ error: 'outcome must be approved, failed, or modified' });
    }

    const reviewRes = await db.query(
      `INSERT INTO qc_reviews (conversation_id, reviewer, outcome, modified_response, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [conversation_id, reviewer, outcome, modified_response || null, notes || null]
    );

    await db.query(
      `UPDATE conversations SET qc_reviewed = TRUE, updated_at = NOW() WHERE id = $1`,
      [conversation_id]
    );

    res.json({ ok: true, review: reviewRes.rows[0] });
  } catch (err) {
    console.error('[qc/review] error', err);
    res.status(500).json({ error: err.message });
  }
});

// Pull a random unreviewed conversation
router.post('/qc/pull-random', async (req, res) => {
  try {
    const convRes = await db.query(
      `SELECT id, contact_id, location_id FROM conversations
       WHERE is_sandbox = FALSE AND qc_reviewed = FALSE AND terminal_outcome IS NOT NULL
       ORDER BY RANDOM() LIMIT 1`
    );
    if (!convRes.rows.length) {
      return res.json({ conversation: null, messages: [] });
    }
    const conv = convRes.rows[0];
    const fullRes = await db.query(`SELECT * FROM conversations WHERE id = $1`, [conv.id]);
    const msgsRes = await db.query(
      `SELECT id, direction, content, message_type, got_reply, reply_time_seconds, created_at
       FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [conv.id]
    );
    res.json({ conversation: fullRes.rows[0], messages: msgsRes.rows });
  } catch (err) {
    console.error('[qc/pull-random] error', err);
    res.status(500).json({ error: err.message });
  }
});

// Get full conversation by ID (for QC panel)
router.get('/conversations/:id/full', async (req, res) => {
  try {
    const { id } = req.params;
    const convRes = await db.query(`SELECT * FROM conversations WHERE id = $1`, [id]);
    if (!convRes.rows.length) return res.status(404).json({ error: 'not found' });
    const msgsRes = await db.query(
      `SELECT id, direction, content, message_type, got_reply, reply_time_seconds, segments, created_at
       FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [id]
    );
    res.json({ conversation: convRes.rows[0], messages: msgsRes.rows });
  } catch (err) {
    console.error('[conversation/full] error', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
