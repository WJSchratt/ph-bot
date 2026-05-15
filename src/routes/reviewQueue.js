const express = require('express');
const db = require('../db');
const logger = require('../services/logger');
const { callAnthropic } = require('../services/anthropic');
const router = express.Router();

const NEGATIVE_RE = /\b(stop|unsubscribe|remove me|take me off|leave me alone|fuck|shit|damn|bitch|asshole|pissed|fuck off)\b/i;
function isNegativeReply(text) {
  if (!text) return false;
  return NEGATIVE_RE.test(text);
}

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

// Auto-populate the queue: find conversations where the lead replied negatively
// (expletives / stop / etc.) OR dropped off for 24+h after a bot message.
router.post('/review-queue/auto-populate', async (req, res) => {
  try {
    const flagged = [];

    // Claude bot: find outbound messages followed by a negative inbound reply
    const negQ = await db.query(
      `SELECT m1.id AS out_id, m1.conversation_id, m1.content AS bot_text, m1.message_type,
              m2.content AS reply_text, c.first_name, c.last_name, c.location_id
       FROM messages m1
       JOIN messages m2 ON m2.conversation_id = m1.conversation_id
         AND m2.direction = 'inbound' AND m2.created_at > m1.created_at
       JOIN conversations c ON c.id = m1.conversation_id
       WHERE m1.direction = 'outbound' AND c.is_sandbox = FALSE
         AND m1.created_at >= NOW() - INTERVAL '30 days'
       ORDER BY m1.created_at DESC LIMIT 1000`
    );
    for (const row of negQ.rows) {
      if (!isNegativeReply(row.reply_text)) continue;
      // Dedupe: skip if already queued
      const already = await db.query(
        `SELECT id FROM ai_review_queue WHERE message_id = $1 AND origin = 'auto_negative'`,
        [row.out_id]
      );
      if (already.rows[0]) continue;
      const insert = await db.query(
        `INSERT INTO ai_review_queue (conversation_id, message_id, message_type, current_text, proposed_text, ai_reason, origin, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'auto_negative', 'pending')
         RETURNING id`,
        [row.conversation_id, row.out_id, row.message_type || 'general', row.bot_text, row.bot_text, `Lead replied negatively: "${String(row.reply_text).slice(0, 120)}"`]
      );
      flagged.push({ queue_id: insert.rows[0].id, conversation_id: row.conversation_id, trigger: 'negative_reply' });
    }

    // Drop-offs: last message outbound, no inbound for 24h+
    const dropQ = await db.query(
      `SELECT m1.id AS out_id, m1.conversation_id, m1.content AS bot_text, m1.message_type,
              c.first_name, c.last_name
       FROM messages m1
       JOIN conversations c ON c.id = m1.conversation_id
       WHERE m1.direction = 'outbound' AND c.is_sandbox = FALSE
         AND m1.created_at >= NOW() - INTERVAL '30 days'
         AND m1.created_at < NOW() - INTERVAL '24 hours'
         AND NOT EXISTS (
           SELECT 1 FROM messages m2 WHERE m2.conversation_id = m1.conversation_id
             AND m2.created_at > m1.created_at
         )
         AND c.terminal_outcome IS NULL
       ORDER BY m1.created_at DESC LIMIT 200`
    );
    for (const row of dropQ.rows) {
      const already = await db.query(
        `SELECT id FROM ai_review_queue WHERE message_id = $1 AND origin = 'auto_dropoff'`,
        [row.out_id]
      );
      if (already.rows[0]) continue;
      const insert = await db.query(
        `INSERT INTO ai_review_queue (conversation_id, message_id, message_type, current_text, proposed_text, ai_reason, origin, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'auto_dropoff', 'pending')
         RETURNING id`,
        [row.conversation_id, row.out_id, row.message_type || 'general', row.bot_text, row.bot_text, `Lead dropped off after this message — no reply for 24h+`]
      );
      flagged.push({ queue_id: insert.rows[0].id, conversation_id: row.conversation_id, trigger: 'dropoff' });
    }

    logger.log('review_queue', 'info', null, 'Auto-populate run', { flagged_count: flagged.length });
    res.json({ flagged: flagged.length, items: flagged });
  } catch (err) {
    logger.log('review_queue', 'error', null, 'auto-populate failed', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

// Generate 2-3 alternative bot responses for a flagged message, using Claude.
router.post('/review-queue/:id/generate-alternatives', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const q = await db.query(`SELECT * FROM ai_review_queue WHERE id = $1`, [id]);
    const item = q.rows[0];
    if (!item) return res.status(404).json({ error: 'not found' });

    // Pull up to 6 prior messages for context + conversation's location_id.
    let context = '';
    let locationId = null;
    if (item.conversation_id) {
      const msgsQ = await db.query(
        `SELECT direction, content, message_type FROM messages WHERE conversation_id = $1 AND created_at <= (SELECT created_at FROM messages WHERE id = $2) ORDER BY created_at DESC LIMIT 6`,
        [item.conversation_id, item.message_id]
      );
      const ctxLines = msgsQ.rows.reverse().map((m) => `${m.direction === 'outbound' ? 'BOT' : 'LEAD'}: ${m.content}`).join('\n');
      context = ctxLines;
      const locQ = await db.query(`SELECT location_id FROM conversations WHERE id = $1`, [item.conversation_id]);
      locationId = locQ.rows[0]?.location_id || null;
    }

    const system = `You are improving a problematic SMS bot message. The current message triggered a negative or drop-off reply. Produce 3 alternative replacements that might have worked better — short, lowercase, conversational (match the bot's tone). Output ONLY valid JSON: { "alternatives": [{"text": "...", "reason": "why this is better"}, ...] }`;
    const resp = await callAnthropic(
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 1200,
        system,
        messages: [{ role: 'user', content: `Prior context:\n${context || '(none)'}\n\nCurrent (problematic) bot message:\n"${item.current_text}"\n\nWhy it was flagged: ${item.ai_reason || 'unknown'}\n\nMessage type: ${item.message_type || 'general'}` }]
      },
      {
        category: 'qc_generate_samples',
        location_id: locationId,
        meta: { review_queue_id: id, conversation_id: item.conversation_id || null }
      }
    );
    const text = (resp.content.find((b) => b.type === 'text')?.text || '').trim();
    let parsed = null;
    try {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    } catch {}
    res.json({
      id, current_text: item.current_text, alternatives: parsed?.alternatives || [],
      raw: parsed ? null : text,
      input_tokens: resp.usage?.input_tokens || 0,
      output_tokens: resp.usage?.output_tokens || 0
    });
  } catch (err) {
    logger.log('review_queue', 'error', null, 'generate-alternatives failed', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

// Approve an alternative — stores it as a pending prompt change.
router.post('/review-queue/:id/approve-alternative', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { text, reason } = req.body || {};
    if (!text) return res.status(400).json({ error: 'text required' });
    const q = await db.query(`SELECT conversation_id, message_type, current_text FROM ai_review_queue WHERE id = $1`, [id]);
    if (!q.rows[0]) return res.status(404).json({ error: 'not found' });
    const item = q.rows[0];

    await db.query(
      `INSERT INTO pending_prompt_changes (source, change_type, description, example_conversation_id, proposed_by)
       VALUES ('ai_review', 'improvement', $1, $2, $3)`,
      [
        `Prefer this phrasing in ${item.message_type || 'general'} turns: "${String(text).slice(0, 300)}" instead of: "${String(item.current_text).slice(0, 200)}". ${reason ? 'Reason: ' + reason : ''}`,
        item.conversation_id || null,
        req.session?.username || null
      ]
    );
    await db.query(
      `UPDATE ai_review_queue SET status = 'approved', reviewed_by = $1, reviewed_at = NOW(), proposed_text = $2
       WHERE id = $3`,
      [req.session?.username || 'admin', text, id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
