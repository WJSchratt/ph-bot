const express = require('express');
const store = require('../services/conversationStore');
const claude = require('../services/claude');
const { parseTags, determineContactStage, determineProductType, determineIsCa } = require('../utils/parser');

const router = express.Router();

const SANDBOX_CONTACT_ID = 'sandbox_user';
const SANDBOX_LOCATION_ID = 'sandbox_location';

function buildSandboxParsed(variables) {
  const v = variables || {};
  const tagList = parseTags(v.tags);
  const offer = v.offer || '';

  return {
    contact_id: SANDBOX_CONTACT_ID,
    location_id: SANDBOX_LOCATION_ID,
    phone: '',
    first_name: v.first_name || 'Walt',
    last_name: '',
    state: v.state || 'FL',
    product_type: determineProductType(offer),
    contact_stage: v.contact_stage || determineContactStage(tagList),
    is_ca: determineIsCa(v.state),
    existing_dob: '',
    existing_age: v.existing_age || '',
    existing_smoker: v.existing_smoker || '',
    existing_health: v.existing_health || '',
    existing_spouse_name: '',
    existing_mortgage_balance: '',
    existing_coverage_subject: '',
    bot_name: v.bot_name || 'Sarah',
    agent_name: v.agent_name || 'Jeremiah',
    agent_phone: '',
    agent_business_card_url: '',
    calendar_link_fx: '',
    calendar_link_mp: '',
    loom_video_fx: '',
    loom_video_mp: '',
    meeting_type: 'Phone',
    ghl_token: '',
    ghl_message_history: '',
    offer: offer,
    offer_short: '',
    language: '',
    marketplace_type: '',
    consent_status: '',
    tags: tagList
  };
}

router.post('/message', async (req, res) => {
  const startedAt = Date.now();
  try {
    const { variables, message } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }

    const parsed = buildSandboxParsed(variables);
    const conv = await store.upsertConversation(parsed, { is_sandbox: true });

    // Reactivate if terminal (sandbox doesn't have cooldown)
    if (!conv.is_active && conv.terminal_outcome) {
      await store.reactivateConversation(conv.id);
      conv.is_active = true;
      conv.terminal_outcome = null;
    }

    // Log inbound
    await store.logMessage({
      conversationId: conv.id,
      contactId: SANDBOX_CONTACT_ID,
      locationId: SANDBOX_LOCATION_ID,
      direction: 'inbound',
      content: message.trim()
    });

    // Build history
    const history = Array.isArray(conv.messages) ? conv.messages : [];

    // Call Claude
    const claudeResult = await claude.generateResponse(conv, history, message.trim());

    // Persist history
    await store.appendMessageHistory(conv.id, 'user', message.trim());
    await store.appendMessageHistory(conv.id, 'assistant', claudeResult.rawAssistantContent);

    // Apply collected data
    await store.applyCollectedData(conv.id, claudeResult.collected_data);

    // Log outbound messages
    for (const msg of claudeResult.messages) {
      await store.logMessage({
        conversationId: conv.id,
        contactId: SANDBOX_CONTACT_ID,
        locationId: SANDBOX_LOCATION_ID,
        direction: 'outbound',
        content: msg,
        messageType: claudeResult.message_type
      });
    }

    // Terminal outcome (just mark it, no GHL/PCR side effects)
    if (claudeResult.terminal_outcome) {
      await store.setTerminalOutcome(conv.id, claudeResult.terminal_outcome);
    }

    return res.json({
      messages: claudeResult.messages,
      collected_data: claudeResult.collected_data,
      terminal_outcome: claudeResult.terminal_outcome,
      message_type: claudeResult.message_type,
      elapsed_ms: Date.now() - startedAt
    });
  } catch (err) {
    console.error('[sandbox/message] error', err);
    return res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

router.post('/reset', async (req, res) => {
  try {
    const deleted = await store.deleteSandboxConversation();
    return res.json({ ok: true, deleted });
  } catch (err) {
    console.error('[sandbox/reset] error', err);
    return res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

module.exports = router;
