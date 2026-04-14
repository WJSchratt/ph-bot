const express = require('express');
const { parseInboundPayload } = require('../utils/parser');
const store = require('../services/conversationStore');
const claude = require('../services/claude');
const ghl = require('../services/ghl');
const { firePostCallRouter } = require('../services/postCallRouter');

const router = express.Router();

const TERMINAL_COOLDOWN_MS = 24 * 60 * 60 * 1000;

router.post('/inbound', async (req, res) => {
  const startedAt = Date.now();
  try {
    const parsed = parseInboundPayload(req.body);

    if (!parsed.contact_id || !parsed.location_id) {
      return res.status(400).json({ error: 'missing contact_id or location_id' });
    }
    if (!parsed.messageBody) {
      return res.status(200).json({ ok: true, skipped: 'empty message' });
    }

    const conv = await store.upsertConversation(parsed);

    // Terminal cooldown handling
    if (!conv.is_active && conv.terminal_outcome) {
      const lastMsgAt = conv.last_message_at ? new Date(conv.last_message_at).getTime() : 0;
      const elapsed = Date.now() - lastMsgAt;
      if (elapsed < TERMINAL_COOLDOWN_MS) {
        const shortReply = `hey ${conv.first_name || 'there'}, ${conv.agent_name || 'our agent'} will be with you shortly`;
        await store.logMessage({
          conversationId: conv.id,
          contactId: conv.contact_id,
          locationId: conv.location_id,
          direction: 'inbound',
          content: parsed.messageBody,
          messageType: 'post_terminal'
        });
        if (parsed.ghl_token) {
          await ghl.sendMessagesSequentially(parsed.ghl_token, conv.contact_id, [shortReply]);
        }
        await store.logMessage({
          conversationId: conv.id,
          contactId: conv.contact_id,
          locationId: conv.location_id,
          direction: 'outbound',
          content: shortReply,
          messageType: 'post_terminal'
        });
        return res.status(200).json({ ok: true, cooldown: true });
      }
      await store.reactivateConversation(conv.id);
      conv.is_active = true;
      conv.terminal_outcome = null;
    }

    // Log inbound
    await store.markReplyToPreviousOutbound(conv.id);
    await store.logMessage({
      conversationId: conv.id,
      contactId: conv.contact_id,
      locationId: conv.location_id,
      direction: 'inbound',
      content: parsed.messageBody
    });

    // Build history for Claude from stored messages jsonb (exclude the brand new inbound)
    const history = Array.isArray(conv.messages) ? conv.messages : [];

    // Call Claude
    const claudeResult = await claude.generateResponse(conv, history, parsed.messageBody);

    // Persist inbound+outbound into JSONB history
    await store.appendMessageHistory(conv.id, 'user', parsed.messageBody);
    await store.appendMessageHistory(conv.id, 'assistant', claudeResult.rawAssistantContent);

    // Apply collected data
    await store.applyCollectedData(conv.id, claudeResult.collected_data);

    // Send SMS via GHL
    if (parsed.ghl_token) {
      await ghl.sendMessagesSequentially(parsed.ghl_token, conv.contact_id, claudeResult.messages);
    } else {
      console.warn('[webhook] no ghl_token, skipping SMS send for', conv.contact_id);
    }

    // Log each outbound message
    for (const msg of claudeResult.messages) {
      await store.logMessage({
        conversationId: conv.id,
        contactId: conv.contact_id,
        locationId: conv.location_id,
        direction: 'outbound',
        content: msg,
        messageType: claudeResult.message_type
      });
    }

    // Terminal outcome handling
    if (claudeResult.terminal_outcome) {
      await store.setTerminalOutcome(conv.id, claudeResult.terminal_outcome);
      // Re-fetch updated conv for PCR payload
      const fresh = { ...conv, ...claudeResult.collected_data, terminal_outcome: claudeResult.terminal_outcome };
      // Handle DNC immediately
      if (claudeResult.terminal_outcome === 'dnc' && parsed.ghl_token) {
        await ghl.setContactDnd(parsed.ghl_token, conv.contact_id);
      }
      await firePostCallRouter(fresh, claudeResult.terminal_outcome);
    }

    return res.status(200).json({
      ok: true,
      outcome: claudeResult.terminal_outcome,
      message_type: claudeResult.message_type,
      elapsed_ms: Date.now() - startedAt
    });
  } catch (err) {
    console.error('[webhook/inbound] error', err);
    return res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

module.exports = router;
