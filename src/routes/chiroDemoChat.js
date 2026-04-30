const express = require('express');
const router = express.Router();
const store = require('../services/conversationStore');
const claude = require('../services/claude');
const logger = require('../services/logger');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

router.options('/chiro/demo-chat', (req, res) => {
  res.set(CORS_HEADERS).status(204).end();
});

// Public demo endpoint — no auth. Used by ph-chiropractor Vercel site.
// session_id is generated client-side (live-<timestamp>) so each page load gets its own convo.
router.post('/chiro/demo-chat', async (req, res) => {
  res.set(CORS_HEADERS);
  const { message, session_id } = req.body || {};
  if (!message || !String(message).trim()) {
    return res.status(400).json({ error: 'message required' });
  }

  const contactId = session_id || 'demo_chiro_public';
  const locationId = 'demo_chiro_location';

  const parsed = {
    contact_id: contactId,
    location_id: locationId,
    phone: '',
    first_name: 'Demo',
    last_name: '',
    state: 'FL',
    product_type: '',
    contact_stage: 'lead',
    is_ca: false,
    bot_vertical: 'chiro',
    doctor_name: 'Dr. Johnson',
    practice_name: 'our practice',
    office_hours: 'Monday-Friday 8am-6pm',
    calendar_link: '',
    bot_name: 'Aria',
    agent_name: 'Dr. Johnson',
    agent_phone: '',
    agent_business_card_url: '',
    calendar_link_fx: '',
    calendar_link_mp: '',
    loom_video_fx: '',
    loom_video_mp: '',
    meeting_type: 'In-Person',
    ghl_token: '',
    ghl_message_history: '',
    offer: '',
    offer_short: '',
    language: '',
    marketplace_type: '',
    consent_status: '',
    tags: [],
    existing_dob: '',
    existing_age: '',
    existing_smoker: '',
    existing_health: '',
    existing_spouse_name: '',
    existing_mortgage_balance: '',
    existing_coverage_subject: ''
  };

  try {
    const conv = await store.upsertConversation(parsed, { is_sandbox: true });
    const history = Array.isArray(conv.messages) ? conv.messages : [];
    const result = await claude.generateResponse(conv, history, message, null, null);
    await store.appendMessageHistory(conv.id, 'user', message);
    await store.appendMessageHistory(conv.id, 'assistant', result.rawAssistantContent);

    const reply = Array.isArray(result.messages) ? result.messages.join(' ') : (result.messages || '');
    res.json({ reply });
  } catch (err) {
    logger.log('chiro', 'error', null, 'public demo chat failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
