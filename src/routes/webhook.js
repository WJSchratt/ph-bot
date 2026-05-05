const express = require('express');
const axios = require('axios');
const { parseInboundPayload } = require('../utils/parser');
const store = require('../services/conversationStore');
const claude = require('../services/claude');
const ghl = require('../services/ghl');
const calendar = require('../services/calendar');
const { firePostCallRouter } = require('../services/postCallRouter');
const ghlPipeline = require('../services/ghlPipeline');
const logger = require('../services/logger');
const db = require('../db');

const router = express.Router();

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_AUTH = (token) => ({ Authorization: `Bearer ${token}`, Version: '2021-04-15' });

// Fetch the live GHL conversation thread and format it as Claude history.
// Called on every webhook hit so Claude always has full context of what was
// said — including manual GHL messages, drip replies, and prior bot turns.
// Returns [{role, content}] array or null on failure (caller falls back to conv.messages).
async function fetchGhlThreadAsHistory(contactId, locationId, ghlToken, currentMessage) {
  try {
    // Find the GHL conversation ID — check local table first, then search live
    let ghlConvId = null;
    const localConvQ = await db.query(
      `SELECT ghl_conversation_id FROM ghl_conversations
       WHERE contact_id = $1 AND location_id = $2
       ORDER BY last_message_at DESC LIMIT 1`,
      [contactId, locationId]
    );
    ghlConvId = localConvQ.rows[0]?.ghl_conversation_id;

    if (!ghlConvId && ghlToken) {
      const searchRes = await axios.get(`${GHL_BASE}/conversations/search`, {
        headers: GHL_AUTH(ghlToken),
        params: { contactId, locationId },
        timeout: 8000
      });
      ghlConvId = searchRes.data?.conversations?.[0]?.id;
    }

    if (!ghlConvId) return null;

    // Fetch messages live from GHL
    const msgRes = await axios.get(`${GHL_BASE}/conversations/${ghlConvId}/messages`, {
      headers: GHL_AUTH(ghlToken),
      params: { limit: 50 },
      timeout: 10000
    });

    const raw = msgRes.data?.messages?.messages || msgRes.data?.messages || [];
    if (!Array.isArray(raw) || !raw.length) return null;

    // Sort chronologically
    const sorted = raw
      .filter((m) => (m.body || m.text || '').trim())
      .sort((a, b) => new Date(a.dateAdded || a.createdAt || 0) - new Date(b.dateAdded || b.createdAt || 0));

    // Build history, excluding the current incoming message (added separately as newUserMessage)
    const currentTrimmed = (currentMessage || '').trim().toLowerCase();
    let skippedCurrent = false;
    const history = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
      const m = sorted[i];
      const isInbound = m.direction === 'inbound' || m.type === 1;
      const content = (m.body || m.text || '').trim();
      if (!skippedCurrent && isInbound && content.toLowerCase() === currentTrimmed) {
        skippedCurrent = true;
        continue;
      }
      history.unshift({ role: isInbound ? 'user' : 'assistant', content });
    }

    return history.slice(-40); // cap at 40 turns to stay within token budget
  } catch (err) {
    logger.log('webhook', 'warn', contactId, 'fetchGhlThreadAsHistory failed (non-fatal)', { error: err.message });
    return null;
  }
}

const TERMINAL_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const SLOTS_CACHE_TTL_MS = 60 * 60 * 1000;
const SLOT_LOOKAHEAD_DAYS = 5;

function isSchedulingPhase(conv) {
  if (!conv) return false;
  if (conv.last_outbound_message_type === 'scheduling') return true;
  if (conv.collected_preferred_time && String(conv.collected_preferred_time).trim()) return true;
  return false;
}

function isPostBooking(conv) {
  return !!conv && conv.is_active && conv.terminal_outcome === 'appointment_booked';
}

function buildPostBookingContext(conv) {
  const apptTime = conv.collected_appointment_time || '(time on file)';
  const agent = conv.agent_name || 'the agent';
  const meeting = conv.meeting_type || 'Phone';
  return `---
POST-BOOKING STATE — CRITICAL OVERRIDE:
This lead's appointment is ALREADY BOOKED for ${apptTime} with ${agent} (${meeting}). Do NOT re-qualify. Do NOT restart the qualification flow. Do NOT ask DOB/health/coverage amount again. Do NOT re-send the opt-in or AI-disclosure message.

Your ONLY job here is to handle their follow-up message in ONE short reply (ideally <160 chars, never more than 2 messages).

Valid message_type values in this state:
- "reschedule" — user wants a DIFFERENT time. If the real-time calendar availability block is present above, offer 2 real options, wait for confirmation, then (on their confirmation) return terminal_outcome="appointment_booked" AND collected_data.appointment_time set to the NEW time. The system will automatically cancel the old slot and book the new one.
- "cancel_appointment" — use ONLY after the user has EXPLICITLY confirmed they want to cancel (e.g. they said "yes cancel it" after you asked). First mention they want to cancel → ask to confirm with message_type="post_booking_question". After confirm → message_type="cancel_appointment", terminal_outcome=null, short friendly ack. The system will cancel the appointment automatically.
- "post_booking_question" — any question about the appointment (what time, what to expect, can spouse join, etc.) or clarification of their request.
- "post_booking_chat" — "thanks", "cool", "sounds good" and other conversational replies. Give a brief friendly acknowledgment. No re-pitch, no follow-up question unless genuinely helpful.

Keep the booking itself intact. Never re-introduce yourself. Tone: concise, friendly, done-deal.`;
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

async function syncContactFieldsNow(conv, ghlToken, contactId) {
  if (!ghlToken || !conv) return;
  try {
    const fresh = await store.getConversationById(conv.id);
    if (!fresh) return;
    const res = await ghl.updateContactFields(ghlToken, fresh.contact_id, fresh, contactId);
    if (res.ok) await store.markSynced(conv.id);
  } catch (err) {
    logger.log('field_sync', 'error', contactId, 'Immediate field sync threw', { error: err.message, stack: err.stack });
  }
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
    // Empty/null bodies must not trigger any bot response. GHL sometimes
    // delivers MMS or empty SMS with body=null (serialized to the literal
    // string "null") or just whitespace — don't feed those to Claude and
    // don't trip the cooldown reply either.
    const trimmedBody = String(parsed.messageBody || '').trim();
    if (!trimmedBody || trimmedBody.toLowerCase() === 'null' || trimmedBody.toLowerCase() === 'undefined') {
      logger.log('webhook', 'info', contactId, 'Skipped empty/null inbound', { raw_body: parsed.messageBody });
      return res.status(200).json({ ok: true, skipped: 'empty message' });
    }

    // Non-SMS message-type guard. GHL fires this webhook on EVERY conversation
    // event — inbound calls, missed calls, voicemails, email activity, custom
    // activities — not just SMS. If we don't filter, the bot ends up replying
    // to call logs as if they were texts. Example from prod: "📞 Inbound call
    // to (801) 348-2482 - Answered (00:03)" was being fed to Claude and the
    // bot kept texting leads right after they hung up with 11labs.
    const rawMessageType = String(req.body?.message?.type || req.body?.body?.message?.type || req.body?.type || '').toUpperCase();
    const nonSmsTypeMarkers = ['CALL', 'VOICEMAIL', 'EMAIL', 'FACEBOOK', 'INSTAGRAM', 'WEBCHAT', 'LIVE_CHAT', 'REVIEW', 'GMB', 'ACTIVITY', 'CUSTOM_EMAIL'];
    if (rawMessageType && nonSmsTypeMarkers.some((m) => rawMessageType.includes(m))) {
      logger.log('webhook', 'info', contactId, 'Skipped non-SMS inbound by message.type', { type: rawMessageType });
      return res.status(200).json({ ok: true, skipped: 'non-sms type', type: rawMessageType });
    }
    // Body-pattern guard for when GHL omits message.type but the content is
    // clearly an activity log (emoji prefix + "Inbound call" / "Missed call" /
    // "Voicemail" / "Answered" / "Thanks for calling"). If a real lead ever
    // literally types "📞 Inbound call..." into SMS, they deserve weird.
    if (/^📞|inbound call to |missed call (to|from) |voicemail from |answered \(\d+/i.test(trimmedBody)) {
      logger.log('webhook', 'info', contactId, 'Skipped non-SMS inbound by body pattern', { body_preview: trimmedBody.slice(0, 100) });
      return res.status(200).json({ ok: true, skipped: 'call/activity log body' });
    }

    // GHL retries webhook delivery on timeout (~30s, 5min, 30min intervals).
    // If we've already logged an identical inbound from this contact in the
    // last 5 minutes, this is a retry — skip it to avoid duplicate bot replies.
    if (parsed.contact_id && trimmedBody) {
      const dupCheck = await db.query(
        `SELECT id FROM messages
         WHERE contact_id = $1 AND direction = 'inbound' AND content = $2
           AND created_at > NOW() - INTERVAL '5 minutes'
         LIMIT 1`,
        [parsed.contact_id, trimmedBody]
      );
      if (dupCheck.rows.length) {
        logger.log('webhook', 'info', contactId, 'Duplicate inbound suppressed', {
          existing_message_id: dupCheck.rows[0].id,
          contact_id: parsed.contact_id
        });
        return res.status(200).json({ ok: true, skipped: 'duplicate' });
      }
    }

    const conv = await store.upsertConversation(parsed);

    // Terminal cooldown handling — gate on the outcome itself, not is_active.
    // This is defensive: if a stale row has is_active=false but a non-deactivating
    // outcome (e.g. appointment_booked from pre-fix data), we still want to respond.
    if (store.shouldDeactivateForOutcome(conv.terminal_outcome)) {
      const lastMsgAt = conv.last_message_at ? new Date(conv.last_message_at).getTime() : 0;
      const elapsed = Date.now() - lastMsgAt;
      const outcomeKey = String(conv.terminal_outcome || '').toLowerCase();
      const isDnc = outcomeKey === 'dnc' || outcomeKey === 'opted_out' || outcomeKey === 'opt_out' || outcomeKey === 'stop_requested';
      if (elapsed < TERMINAL_COOLDOWN_MS) {
        // DNC/opt-out: lead explicitly said stop. Log the inbound for
        // audit, but NEVER send a "will be with you shortly" follow-up
        // (that's what Steven Hedtke got — he opted out, then the system
        // texted him again 20 minutes later saying "Jeremiah will be with
        // you shortly" and he replied asking why we kept texting).
        await store.logMessage({
          conversationId: conv.id,
          contactId: conv.contact_id,
          locationId: conv.location_id,
          direction: 'inbound',
          content: parsed.messageBody,
          messageType: 'post_terminal'
        });
        if (isDnc) {
          logger.log('webhook', 'info', contactId, 'Post-DNC inbound — silent (no reply sent)', { outcome: outcomeKey });
          return res.status(200).json({ ok: true, cooldown: true, silent_dnc: true });
        }
        // Non-DNC deactivating outcome (currently none, but future-proofing) —
        // fall through to the canned cooldown reply.
        const shortReply = `hey ${conv.first_name || 'there'}, ${conv.agent_name || 'our agent'} will be with you shortly`;
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
    } else if (!conv.is_active && conv.terminal_outcome) {
      // Non-deactivating outcome but somehow is_active=false — repair in place, keep outcome.
      conv.is_active = true;
    }

    // First-reply pipeline move: if this is the contact's first inbound in
    // our bot's conversation (jsonb history empty at read-time), mark the
    // opportunity as "Engaging with AI" so the dashboard reflects active
    // bot engagement. routeOpportunity handles no-op / skip-if-downstream
    // internally, so this is safe to fire on every "first" inbound.
    const isFirstReply = Array.isArray(conv.messages) && conv.messages.length === 0;
    if (isFirstReply && parsed.ghl_token && parsed.location_id) {
      try {
        const contactName = [conv.first_name || parsed.first_name, conv.last_name || parsed.last_name]
          .filter(Boolean).join(' ').trim() || null;
        const engRes = await ghlPipeline.routeOpportunity(
          parsed.ghl_token,
          parsed.location_id,
          conv.contact_id,
          'engaging_with_ai',
          { logCtx: contactId, contactName, vertical: conv.vertical || 'insurance' }
        );
        logger.log('pipeline_route', 'info', contactId, 'first-reply engaging_with_ai', {
          opportunityId: engRes.opportunityId,
          created: engRes.created,
          skipped: engRes.skipped || null,
          prior_stage: engRes.prior?.pipelineStageId || null,
          error: engRes.error || null
        });
      } catch (engErr) {
        logger.log('pipeline_route', 'error', contactId, 'first-reply engaging_with_ai threw', { error: engErr.message });
      }
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

    // Build history for Claude — fetch live from GHL so Claude always has the
    // full conversation (manual GHL messages, drip replies, prior bot turns).
    // Falls back to our stored conv.messages JSONB if the GHL call fails.
    let history = Array.isArray(conv.messages) ? conv.messages : [];
    if (parsed.ghl_token) {
      const ghlHistory = await fetchGhlThreadAsHistory(
        conv.contact_id, conv.location_id, parsed.ghl_token, parsed.messageBody
      );
      if (ghlHistory !== null) {
        history = ghlHistory;
        logger.log('webhook', 'info', contactId, 'Using live GHL thread as history', { turns: ghlHistory.length });
      }
    }

    // If scheduling phase OR post-booking (may need to reschedule), fetch real calendar slots
    let slotInfo = null;
    let schedulingContext = '';
    const postBooking = isPostBooking(conv);
    if (isSchedulingPhase(conv) || postBooking) {
      try {
        slotInfo = await ensureSlotsForScheduling(conv, parsed, contactId);
        schedulingContext = buildSchedulingContext(slotInfo);
      } catch (schedErr) {
        logger.log('calendar', 'error', contactId, 'Scheduling context setup failed', { error: schedErr.message, stack: schedErr.stack });
      }
    }

    // If post-booking, prepend the post-booking override so Claude doesn't re-qualify
    const postBookingContext = postBooking ? buildPostBookingContext(conv) : '';
    const extraContext = [postBookingContext, schedulingContext].filter(Boolean).join('\n\n');

    // Call Claude
    const claudeStarted = Date.now();
    const claudeResult = await claude.generateResponse(conv, history, parsed.messageBody, contactId, extraContext);
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

    // === Post-booking cancellation (can arrive with terminal_outcome=null) ===
    if (postBooking && claudeResult.message_type === 'cancel_appointment') {
      logger.log('post_booking', 'info', contactId, 'Post-booking interaction', { action: 'cancel' });
      if (conv.appointment_id && parsed.ghl_token) {
        try {
          await calendar.cancelAppointment(parsed.ghl_token, conv.appointment_id, contactId);
        } catch (cancelErr) {
          logger.log('calendar', 'error', contactId, 'Cancel threw', { error: cancelErr.message, stack: cancelErr.stack });
        }
      }
      await store.clearAppointmentId(conv.id);
      await store.clearTerminalOutcome(conv.id);
      await syncContactFieldsNow(conv, parsed.ghl_token, contactId);
    }

    // === Terminal outcome handling ===
    if (claudeResult.terminal_outcome) {
      const newOutcome = claudeResult.terminal_outcome;
      const isReschedule = newOutcome === 'appointment_booked' && postBooking && !!conv.appointment_id;

      await store.setTerminalOutcome(conv.id, newOutcome);
      const mergedConv = { ...conv, ...claudeResult.collected_data, terminal_outcome: newOutcome };

      // Book real appointment (or reschedule: cancel old first, then book new)
      if (newOutcome === 'appointment_booked' && parsed.ghl_token) {
        try {
          if (isReschedule) {
            logger.log('post_booking', 'info', contactId, 'Post-booking interaction', { action: 'reschedule', old_appointment_id: conv.appointment_id });
            try {
              await calendar.cancelAppointment(parsed.ghl_token, conv.appointment_id, contactId);
            } catch (cancelErr) {
              logger.log('calendar', 'error', contactId, 'Reschedule cancel-old threw', { error: cancelErr.message });
            }
            await store.clearAppointmentId(conv.id);
          }

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

      // Handle DNC immediately (deactivates conversation via setTerminalOutcome already)
      if (newOutcome === 'dnc' && parsed.ghl_token) {
        await ghl.setContactDnd(parsed.ghl_token, conv.contact_id);
      }

      // Tag-based pipeline routing (kept for workflow triggers that still watch tags).
      // DNC already tags via setContactDnd above.
      if (newOutcome !== 'dnc' && parsed.ghl_token) {
        try {
          const tagRes = await ghl.tagContactForOutcome(parsed.ghl_token, conv.contact_id, newOutcome);
          if (tagRes && !tagRes.skipped) {
            logger.log('ghl_tag', tagRes.ok ? 'info' : 'warn', contactId, 'Tagged contact for outcome', { outcome: newOutcome, tags: tagRes.tags, ok: tagRes.ok });
          }
        } catch (tagErr) {
          logger.log('ghl_tag', 'error', contactId, 'Tag contact threw', { outcome: newOutcome, error: tagErr.message });
        }
      }

      // Direct opportunity stage move. Translates the bot's internal outcome
      // into the feature routing label, then moves the contact's opportunity
      // into the Sales Pipeline at the right stage. Cross-pipeline moves are
      // supported by GHL — the PUT sets both pipelineId and pipelineStageId.
      if (parsed.ghl_token && parsed.location_id) {
        const routeOutcome = ghlPipeline.TERMINAL_TO_ROUTE_OUTCOME[newOutcome];
        if (routeOutcome) {
          try {
            const contactName = [conv.first_name || parsed.first_name, conv.last_name || parsed.last_name]
              .filter(Boolean).join(' ').trim() || null;
            const routeRes = await ghlPipeline.routeOpportunity(
              parsed.ghl_token,
              parsed.location_id,
              conv.contact_id,
              routeOutcome,
              { logCtx: contactId, contactName, vertical: conv.vertical || 'insurance' }
            );
            logger.log('pipeline_route', 'info', contactId, 'routeOpportunity result', {
              terminal_outcome: newOutcome,
              route_outcome: routeOutcome,
              opportunityId: routeRes.opportunityId,
              prior: routeRes.prior,
              target: routeRes.target,
              handoff_reason: routeRes.handoffReason,
              skipped: routeRes.skipped || null,
              error: routeRes.error || null
            });
          } catch (routeErr) {
            logger.log('pipeline_route', 'error', contactId, 'routeOpportunity threw', {
              terminal_outcome: newOutcome, error: routeErr.message
            });
          }
        }
      }

      // Skip firing PCR again on a reschedule, and skip entirely for non-insurance verticals
      if (!isReschedule && (conv.vertical || 'insurance') === 'insurance') {
        await firePostCallRouter(mergedConv, newOutcome);
        logger.log('webhook_fire', 'info', contactId, 'Post-call router fired', { outcome: newOutcome, url: process.env.GHL_POST_CALL_ROUTER_URL });
      }

      // Immediate custom-field sync to GHL (covers booked, reschedule, handoff, dnc, fex/mp_immediate, etc.)
      await syncContactFieldsNow(conv, parsed.ghl_token, contactId);
    }

    // Post-booking conversational / question turn (no terminal outcome, not a cancel)
    if (postBooking && !claudeResult.terminal_outcome && claudeResult.message_type !== 'cancel_appointment') {
      const mt = claudeResult.message_type || 'post_booking_chat';
      if (mt === 'post_booking_question' || mt === 'post_booking_chat' || mt === 'reschedule') {
        logger.log('post_booking', 'info', contactId, 'Post-booking interaction', { action: mt });
      }
    }

    // Keep ghl_conversations.last_message_at current so the All Conversations
    // tab sorts correctly without waiting for a manual GHL pull.
    db.query(
      `UPDATE ghl_conversations SET last_message_at = NOW() WHERE contact_id = $1 AND location_id = $2`,
      [parsed.contact_id, parsed.location_id]
    ).catch(() => {});

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
