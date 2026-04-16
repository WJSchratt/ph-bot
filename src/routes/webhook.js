const express = require('express');
const { parseInboundPayload } = require('../utils/parser');
const store = require('../services/conversationStore');
const claude = require('../services/claude');
const ghl = require('../services/ghl');
const calendar = require('../services/calendar');
const { firePostCallRouter } = require('../services/postCallRouter');
const logger = require('../services/logger');

const router = express.Router();

const TERMINAL_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const SLOTS_CACHE_TTL_MS = 60 * 60 * 1000;
const SLOT_LOOKAHEAD_DAYS = 5;

function isSchedulingPhase(conv) {
  if (!conv) return false;
  if (conv.last_outbound_message_type === 'scheduling') return true;
  if (conv.collected_preferred_time && String(conv.collected_preferred_time).trim()) return true;
  return false;
}

async function ensureSlotsForScheduling(conv, parsed, contactId) {
  if (!parsed.ghl_token || !parsed.location_id) return null;

  const timezone = calendar.timezoneForState(conv.state || parsed.state);

  let calendarId = conv.calendar_id;
  let assignedUserId = conv.calendar_assigned_user_id;
  let eventTitle = conv.calendar_event_title;

  if (!calendarId) {
    const calendars = await calendar.getCalendars(parsed.ghl_token, parsed.location_id, contactId);
    const match = calendar.findCalendarByProduct(calendars, conv.product_type || parsed.product_type);
    if (!match) {
      logger.log('calendar', 'warn', contactId, 'No matching calendar found', {
        product_type: conv.product_type || parsed.product_type,
        calendar_count: calendars.length
      });
      return null;
    }
    calendarId = match.id;
    assignedUserId = match.teamMembers?.[0]?.userId || null;
    eventTitle = match.eventTitle || match.name || 'Appointment';
    await store.saveCalendarInfo(conv.id, { calendarId, assignedUserId, eventTitle });
    conv.calendar_id = calendarId;
    conv.calendar_assigned_user_id = assignedUserId;
    conv.calendar_event_title = eventTitle;
  }

  let slots = null;
  const cacheAge = conv.cached_slots_at ? Date.now() - new Date(conv.cached_slots_at).getTime() : Infinity;
  if (Array.isArray(conv.cached_slots) && conv.cached_slots.length && cacheAge < SLOTS_CACHE_TTL_MS) {
    slots = conv.cached_slots;
    logger.log('calendar', 'info', contactId, 'Using cached slots', { slot_count: slots.length, cache_age_ms: cacheAge });
  } else {
    const now = new Date();
    const endDate = new Date(now.getTime() + SLOT_LOOKAHEAD_DAYS * 86400000);
    try {
      slots = await calendar.getFreeSlots(
        parsed.ghl_token,
        calendarId,
        now.getTime(),
        endDate.getTime(),
        timezone,
        contactId
      );
      await store.saveCachedSlots(conv.id, slots);
      conv.cached_slots = slots;
      conv.cached_slots_at = new Date();
    } catch (err) {
      logger.log('calendar', 'error', contactId, 'Failed to fetch slots', { error: err.message });
      return null;
    }
  }

  return { slots, calendarId, assignedUserId, eventTitle, timezone };
}

function buildSchedulingContext(slotInfo) {
  if (!slotInfo || !slotInfo.slots || !slotInfo.slots.length) return '';
  const formatted = calendar.formatSlotsForPrompt(slotInfo.slots, slotInfo.timezone, 40);
  return `---
REAL-TIME CALENDAR AVAILABILITY (timezone: ${slotInfo.timezone}):
The following times are CONFIRMED AVAILABLE on the agent's calendar. When offering times to the lead, ONLY offer slots from this list. When the lead confirms a time, use the EXACT slot time. Do not invent times that are not listed here.

${formatted}

When presenting times, group by day and offer at most 2-3 options per message (per the scheduling script). Prefer slots ~30 min apart when offering multiple.`;
}

function extractAssignedUserName(slotInfo, conv) {
  return conv.agent_name || 'Agent';
}

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

    // If scheduling phase, fetch real calendar slots to inject as context
    let slotInfo = null;
    let schedulingContext = '';
    if (isSchedulingPhase(conv)) {
      try {
        slotInfo = await ensureSlotsForScheduling(conv, parsed, contactId);
        schedulingContext = buildSchedulingContext(slotInfo);
      } catch (schedErr) {
        logger.log('calendar', 'error', contactId, 'Scheduling context setup failed', { error: schedErr.message, stack: schedErr.stack });
      }
    }

    // Call Claude
    const claudeStarted = Date.now();
    const claudeResult = await claude.generateResponse(conv, history, parsed.messageBody, contactId, schedulingContext);
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

    // Persist last outbound message_type for next-turn scheduling detection
    if (claudeResult.message_type) {
      await store.saveLastOutboundMessageType(conv.id, claudeResult.message_type);
    }

    // Terminal outcome handling
    if (claudeResult.terminal_outcome) {
      await store.setTerminalOutcome(conv.id, claudeResult.terminal_outcome);
      const mergedConv = { ...conv, ...claudeResult.collected_data, terminal_outcome: claudeResult.terminal_outcome };

      // Book real appointment when a slot was confirmed
      if (claudeResult.terminal_outcome === 'appointment_booked' && parsed.ghl_token) {
        try {
          const appointmentText = claudeResult.collected_data?.appointment_time || conv.collected_appointment_time;
          let info = slotInfo;
          if (!info) {
            info = await ensureSlotsForScheduling(conv, parsed, contactId);
          }
          if (!info || !info.calendarId) {
            logger.log('calendar', 'warn', contactId, 'Skipping booking — no calendar info', { appointment_text: appointmentText });
          } else {
            let slot = calendar.findSlotMatchingTime(info.slots || [], appointmentText, info.timezone);
            if (!slot) {
              logger.log('calendar', 'warn', contactId, 'No slot matched — re-fetching', { appointment_text: appointmentText });
              const now = new Date();
              const endDate = new Date(now.getTime() + SLOT_LOOKAHEAD_DAYS * 86400000);
              const freshSlots = await calendar.getFreeSlots(parsed.ghl_token, info.calendarId, now.getTime(), endDate.getTime(), info.timezone, contactId);
              slot = calendar.findSlotMatchingTime(freshSlots, appointmentText, info.timezone);
              info.slots = freshSlots;
            }
            if (!slot) {
              logger.log('calendar', 'error', contactId, 'Could not match appointment to any slot', { appointment_text: appointmentText });
            } else {
              const endTime = slot.endTime || calendar.inferEndTime(slot, 30);
              const titleTemplate = info.eventTitle || 'Appointment';
              const contactName = `${conv.first_name || ''} ${conv.last_name || ''}`.trim() || 'Contact';
              const agentDisplayName = conv.agent_name || 'Agent';
              const title = titleTemplate
                .replace(/\{\{\s*contact\.name\s*\}\}/gi, contactName)
                .replace(/\{\{\s*appointment\.user\.name\s*\}\}/gi, agentDisplayName);
              const bookRes = await calendar.bookAppointment(parsed.ghl_token, {
                calendarId: info.calendarId,
                locationId: parsed.location_id,
                contactId: conv.contact_id,
                startTime: slot.startTime,
                endTime,
                title,
                assignedUserId: info.assignedUserId
              }, contactId);
              if (bookRes.ok && bookRes.appointment?.id) {
                await store.saveAppointmentId(conv.id, bookRes.appointment.id);
              }
            }
          }
        } catch (bookErr) {
          logger.log('calendar', 'error', contactId, 'Appointment booking threw', { error: bookErr.message, stack: bookErr.stack });
        }
      }

      // Handle DNC immediately
      if (claudeResult.terminal_outcome === 'dnc' && parsed.ghl_token) {
        await ghl.setContactDnd(parsed.ghl_token, conv.contact_id);
      }
      await firePostCallRouter(mergedConv, claudeResult.terminal_outcome);
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
