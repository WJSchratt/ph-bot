const express = require('express');
const { parseInboundPayload } = require('../utils/parser');
const store = require('../services/conversationStore');
const claude = require('../services/claude');
const ghl = require('../services/ghl');
const { firePostCallRouter } = require('../services/postCallRouter');
const logger = require('../services/logger');

const router = express.Router();

const TERMINAL_COOLDOWN_MS = 24 * 60 * 60 * 1000;

router.post('/inbound', async (req, res) => {
  const startedAt = Date.now();
  let contactId = null;
  try {
    logger.log('inbound', 'info', null, 'Webhook received', { raw_body: req.body });

    const parsed = parseInboundPayload(req.body);
    contactId = parsed.contact_id || null;

    logger.log('parse', 'info', contactId, 'Payload parsed', { contact_id: parsed.contact_id, location_id: parsed.location_id, messageBody: parsed.messageBody, product_type: parsed.product_type, contact_stage: parsed.contact_stage, has_ghl_token: !!parsed.ghl_token, ghl_token_preview: parsed.ghl_token ? parsed.ghl_token.slice(0, 8) + '...' : null });

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
    const claudeStarted = Date.now();
    const claudeResult = await claude.generateResponse(conv, history, parsed.messageBody, contactId);
    const claudeElapsed = Date.now() - claudeStarted;

    logger.log('claude', 'info', contactId, 'Claude responded', {
      messages: claudeResult.messages,
      collected_data: claudeResult.collected_data,
      terminal_outcome: claudeResult.terminal_outcome,
      message_type: claudeResult.message_type,
      elapsed_ms: claudeElapsed
    });

    // Persist inbound+outbound into JSONB history
    await store.appendMessageHistory(conv.id, 'user', parsed.messageBody);
    await store.appendMessageHistory(conv.id, 'assistant', claudeResult.rawAssistantContent);

    // Apply collected data
    await store.applyCollectedData(conv.id, claudeResult.collected_data);

    // Store token usage
    await store.updateTokenCounts(conv.id, claudeResult.input_tokens, claudeResult.output_tokens);

    // Send SMS via GHL
    let sendResult = null;
    if (parsed.ghl_token) {
      try {
        sendResult = await ghl.sendMessagesSequentially(parsed.ghl_token, conv.contact_id, claudeResult.messages, contactId);
        logger.log('ghl_send', 'info', contactId, 'Messages sent to GHL', { send_result: sendResult });
      } catch (ghlErr) {
        logger.log('ghl_send', 'error', contactId, 'GHL send failed', { error: ghlErr.message });
      }
    } else {
      logger.log('ghl_send', 'warn', contactId, 'No ghl_token, skipping SMS send');
    }

    // Log each outbound message with segment counts
    for (const msg of claudeResult.messages) {
      await store.logMessage({
        conversationId: conv.id,
        contactId: conv.contact_id,
        locationId: conv.location_id,
        direction: 'outbound',
        content: msg,
        messageType: claudeResult.message_type,
        segments: ghl.calculateSegments(msg)
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
      logger.log('webhook_fire', 'info', contactId, 'Post-call router fired', { outcome: claudeResult.terminal_outcome, url: process.env.GHL_POST_CALL_ROUTER_URL });
    }

    return res.status(200).json({
      ok: true,
      outcome: claudeResult.terminal_outcome,
      message_type: claudeResult.message_type,
      elapsed_ms: Date.now() - startedAt
    });
  } catch (err) {
    logger.log('error', 'error', contactId, err.message, { stack: err.stack });
    console.error('[webhook/inbound] error', err);
    return res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

module.exports = router;
