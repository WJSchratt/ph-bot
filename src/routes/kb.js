const express = require('express');
const db = require('../db');
const logger = require('../services/logger');

const router = express.Router();

router.get('/kb/:locationId', async (req, res) => {
  try {
    const q = await db.query(
      `SELECT id, location_id, title, content, tag, created_at, updated_at
       FROM subaccount_knowledge_base
       WHERE location_id = $1
       ORDER BY updated_at DESC`,
      [req.params.locationId]
    );
    res.json({ location_id: req.params.locationId, entries: q.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/kb/:locationId', async (req, res) => {
  try {
    const { title, content, tag } = req.body || {};
    if (!content) return res.status(400).json({ error: 'content required' });
    const q = await db.query(
      `INSERT INTO subaccount_knowledge_base (location_id, title, content, tag)
       VALUES ($1, $2, $3, $4)
       RETURNING id, location_id, title, content, tag, created_at`,
      [req.params.locationId, title || null, content, tag || null]
    );
    logger.log('kb', 'info', null, 'KB entry created', { location_id: req.params.locationId, id: q.rows[0].id, by: req.session?.username });
    res.json({ ok: true, entry: q.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/kb/:locationId/:id', async (req, res) => {
  try {
    const { title, content, tag } = req.body || {};
    const sets = [];
    const params = [];
    if (title !== undefined) { params.push(title); sets.push(`title = $${params.length}`); }
    if (content !== undefined) { params.push(content); sets.push(`content = $${params.length}`); }
    if (tag !== undefined) { params.push(tag); sets.push(`tag = $${params.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'no fields to update' });
    sets.push('updated_at = NOW()');
    params.push(parseInt(req.params.id, 10));
    params.push(req.params.locationId);
    const q = await db.query(
      `UPDATE subaccount_knowledge_base SET ${sets.join(', ')}
       WHERE id = $${params.length - 1} AND location_id = $${params.length}
       RETURNING id, title, content, tag, updated_at`,
      params
    );
    if (!q.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, entry: q.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/kb/:locationId/:id', async (req, res) => {
  try {
    const q = await db.query(
      `DELETE FROM subaccount_knowledge_base WHERE id = $1 AND location_id = $2 RETURNING id`,
      [parseInt(req.params.id, 10), req.params.locationId]
    );
    if (!q.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
