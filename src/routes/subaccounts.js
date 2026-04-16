const express = require('express');
const db = require('../db');
const router = express.Router();

// List all subaccounts
router.get('/subaccounts', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, ghl_location_id, status, created_at, updated_at,
              CASE WHEN ghl_api_key IS NOT NULL AND ghl_api_key != ''
                   THEN LEFT(ghl_api_key, 8) || '...'
                   ELSE NULL END AS ghl_api_key_preview
       FROM subaccounts ORDER BY name`
    );
    res.json({ subaccounts: result.rows });
  } catch (err) {
    console.error('[subaccounts] error', err);
    res.status(500).json({ error: err.message });
  }
});

// Get single subaccount
router.get('/subaccounts/:id', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, ghl_location_id, status, created_at, updated_at,
              CASE WHEN ghl_api_key IS NOT NULL AND ghl_api_key != ''
                   THEN LEFT(ghl_api_key, 8) || '...'
                   ELSE NULL END AS ghl_api_key_preview
       FROM subaccounts WHERE id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ subaccount: result.rows[0] });
  } catch (err) {
    console.error('[subaccounts/:id] error', err);
    res.status(500).json({ error: err.message });
  }
});

// Create subaccount
router.post('/subaccounts', async (req, res) => {
  try {
    const { name, ghl_location_id, ghl_api_key, status } = req.body;
    if (!name || !ghl_location_id) {
      return res.status(400).json({ error: 'name and ghl_location_id are required' });
    }
    const result = await db.query(
      `INSERT INTO subaccounts (name, ghl_location_id, ghl_api_key, status)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, ghl_location_id, status, created_at`,
      [name, ghl_location_id, ghl_api_key || null, status || 'active']
    );
    res.json({ ok: true, subaccount: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'ghl_location_id already exists' });
    console.error('[subaccounts/create] error', err);
    res.status(500).json({ error: err.message });
  }
});

// Update subaccount
router.put('/subaccounts/:id', async (req, res) => {
  try {
    const { name, ghl_location_id, ghl_api_key, status } = req.body;
    const result = await db.query(
      `UPDATE subaccounts SET
         name = COALESCE($1, name),
         ghl_location_id = COALESCE($2, ghl_location_id),
         ghl_api_key = COALESCE($3, ghl_api_key),
         status = COALESCE($4, status),
         updated_at = NOW()
       WHERE id = $5
       RETURNING id, name, ghl_location_id, status, updated_at`,
      [name || null, ghl_location_id || null, ghl_api_key || null, status || null, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, subaccount: result.rows[0] });
  } catch (err) {
    console.error('[subaccounts/update] error', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete subaccount
router.delete('/subaccounts/:id', async (req, res) => {
  try {
    const result = await db.query(`DELETE FROM subaccounts WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, deleted: true });
  } catch (err) {
    console.error('[subaccounts/delete] error', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
