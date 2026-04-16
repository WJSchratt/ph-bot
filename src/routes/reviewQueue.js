const express = require('express');
const db = require('../db');
const router = express.Router();

// List review queue items
router.get('/review-queue', async (req, res) => {
  try {
    const { status = 'pending', page = 1, limit = 20 } = req.query;
    const lim = Math.min(parseInt(limit, 10) || 20, 100);
    const off = (Math.max(parseInt(page, 10) || 1, 1) - 1) * lim;

    const result = await db.query(
      `SELECT rq.*,
              c.first_name, c.last_name, c.product_type, c.contact_stage
       FROM ai_review_queue rq
       LEFT JOIN conversations c ON c.id = rq.conversation_id
       WHERE rq.status = $1
       ORDER BY rq.created_at DESC
       LIMIT $2 OFFSET $3`,
      [status, lim, off]
    );

    const countRes = await db.query(
      `SELECT COUNT(*)::int AS total FROM ai_review_queue WHERE status = $1`,
      [status]
    );

    res.json({
      items: result.rows,
      total: countRes.rows[0].total,
      page: parseInt(page, 10) || 1,
      limit: lim
    });
  } catch (err) {
    console.error('[review-queue] error', err);
    res.status(500).json({ error: err.message });
  }
});

// Take action on a review queue item
router.post('/review-queue/:id/action', async (req, res) => {
  try {
    const { id } = req.params;
    const { action, reviewed_by, modified_text } = req.body;
    if (!action || !['approve', 'deny'].includes(action)) {
      return res.status(400).json({ error: 'action must be approve or deny' });
    }

    const status = action === 'approve' ? 'approved' : 'denied';
    const updates = modified_text
      ? `status = $1, reviewed_by = $2, reviewed_at = NOW(), proposed_text = $3`
      : `status = $1, reviewed_by = $2, reviewed_at = NOW()`;
    const params = modified_text
      ? [status, reviewed_by || 'admin', modified_text, id]
      : [status, reviewed_by || 'admin', id];
    const idIdx = modified_text ? 4 : 3;

    const result = await db.query(
      `UPDATE ai_review_queue SET ${updates} WHERE id = $${idIdx} RETURNING *`,
      params
    );

    if (!result.rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, item: result.rows[0] });
  } catch (err) {
    console.error('[review-queue/action] error', err);
    res.status(500).json({ error: err.message });
  }
});

// Create a review queue item (from sandbox or manual)
router.post('/review-queue', async (req, res) => {
  try {
    const { conversation_id, message_id, message_type, current_text, proposed_text, ai_reason, ai_confidence, origin } = req.body;
    if (!current_text || !proposed_text) {
      return res.status(400).json({ error: 'current_text and proposed_text are required' });
    }

    const result = await db.query(
      `INSERT INTO ai_review_queue (conversation_id, message_id, message_type, current_text, proposed_text, ai_reason, ai_confidence, origin)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [conversation_id || null, message_id || null, message_type || null, current_text, proposed_text, ai_reason || null, ai_confidence || null, origin || 'manual']
    );

    res.json({ ok: true, item: result.rows[0] });
  } catch (err) {
    console.error('[review-queue/create] error', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
