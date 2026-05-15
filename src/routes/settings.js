const express = require('express');
const db = require('../db');
const router = express.Router();

const VALID_SECTIONS = ['claude_config', 'system_prompt', 'knowledge_base', 'bot_instructions', 'webhooks', 'notifications', 'cost_config'];

const SECTION_DEFAULTS = {
  claude_config: {
    model: 'claude-sonnet-4-6',
    max_tokens: '1024',
    temperature: '1.0'
  },
  cost_config: {
    // Signal House rates via GHL's LC Phone integration. GHL bills clients
    // separately; these are the underlying carrier costs only.
    carrier_cost_per_segment_outbound: '0.01',
    carrier_cost_per_segment_inbound: '0.01',
    carrier_cost_mms_outbound: '0.04',
    carrier_cost_mms_inbound: '0.04',
    // GHL premium inbound_webhook trigger (e.g. post-call router fires).
    // First 100/month are free, then $0.01 each. GHL does NOT charge per SMS —
    // SMS cost is only the underlying Signal House carrier rate above.
    webhook_free_tier_per_month: '100',
    webhook_cost_per_event: '0.01',
    // GHL emails (calendar confirmations, follow-ups, etc.)
    email_cost_per_send: '0.000675',
    input_token_cost_per_million: '3',
    output_token_cost_per_million: '15',
    // BotPress AI cost — average per OUTBOUND bot message. Calculate from
    // BotPress dashboard: total monthly AI spend ÷ total messages.
    botpress_ai_cost_per_message: '0.0186'
  }
};

// Get settings for a section
router.get('/settings/:section', async (req, res) => {
  try {
    const { section } = req.params;
    if (!VALID_SECTIONS.includes(section)) {
      return res.status(400).json({ error: `Invalid section. Valid: ${VALID_SECTIONS.join(', ')}` });
    }
    const result = await db.query(
      `SELECT key, value FROM app_settings WHERE section = $1 ORDER BY key`,
      [section]
    );
    const settings = { ...(SECTION_DEFAULTS[section] || {}) };
    for (const row of result.rows) {
      settings[row.key] = row.value;
    }
    res.json({ section, settings });
  } catch (err) {
    console.error('[settings/get] error', err);
    res.status(500).json({ error: err.message });
  }
});

// Get all settings across all sections
router.get('/settings', async (req, res) => {
  try {
    const result = await db.query(`SELECT section, key, value FROM app_settings ORDER BY section, key`);
    const grouped = {};
    for (const row of result.rows) {
      if (!grouped[row.section]) grouped[row.section] = {};
      grouped[row.section][row.key] = row.value;
    }
    res.json({ settings: grouped });
  } catch (err) {
    console.error('[settings/getAll] error', err);
    res.status(500).json({ error: err.message });
  }
});

// Update settings for a section (upsert key/value pairs)
router.put('/settings/:section', async (req, res) => {
  try {
    const { section } = req.params;
    if (!VALID_SECTIONS.includes(section)) {
      return res.status(400).json({ error: `Invalid section. Valid: ${VALID_SECTIONS.join(', ')}` });
    }
    const data = req.body;
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'Body must be a JSON object of key/value pairs' });
    }

    const entries = Object.entries(data);
    for (const [key, value] of entries) {
      await db.query(
        `INSERT INTO app_settings (section, key, value, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (section, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [section, key, typeof value === 'string' ? value : JSON.stringify(value)]
      );
    }

    res.json({ ok: true, section, keys_updated: entries.length });
  } catch (err) {
    console.error('[settings/put] error', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
