const express = require('express');
const db = require('../db');
const router = express.Router();

const DEACTIVATING_OUTCOMES = ["'dnc'", "'opted_out'", "'opt_out'", "'stop_requested'"];
const BOOKED_OUTCOMES = ["'appointment_booked'", "'fex_immediate'", "'mp_immediate'"];
const HANDOFF_OUTCOMES = ["'human_handoff'", "'handoff_requested'"];

async function loadCostConfig() {
  try {
    const q = await db.query(`SELECT key, value FROM app_settings WHERE section = 'cost_config'`);
    const map = {};
    for (const r of q.rows) map[r.key] = r.value;
    return {
      carrier_out: parseFloat(map.carrier_cost_per_segment_outbound) || 0.0079,
      carrier_in: parseFloat(map.carrier_cost_per_segment_inbound) || 0.0079,
      webhook_free: parseInt(map.webhook_free_tier_per_month, 10) || 100,
      webhook_cost: parseFloat(map.webhook_cost_per_event) || 0.02,
      input_cost_per_m: parseFloat(map.input_token_cost_per_million) || 3,
      output_cost_per_m: parseFloat(map.output_token_cost_per_million) || 15
    };
  } catch {
    return { carrier_out: 0.0079, carrier_in: 0.0079, webhook_free: 100, webhook_cost: 0.02, input_cost_per_m: 3, output_cost_per_m: 15 };
  }
}

router.get('/dashboard', async (req, res) => {
  try {
    const { location_id, location_ids, days = 30 } = req.query;
    const daysInt = parseInt(days, 10) || 30;
    const locIds = location_ids ? location_ids.split(',').map((s) => s.trim()).filter(Boolean) : (location_id ? [location_id] : []);

    const costConfig = await loadCostConfig();

    // --- 1) Local Claude-bot KPIs (from conversations + messages tables) ---
    const botParams = [];
    const botFilters = ['is_sandbox = FALSE'];
    if (locIds.length) { botParams.push(locIds); botFilters.push(`location_id = ANY($${botParams.length})`); }
    botParams.push(daysInt);
    botFilters.push(`created_at >= NOW() - ($${botParams.length} || ' days')::interval`);
    const botWhere = `WHERE ${botFilters.join(' AND ')}`;

    const botKpiRes = await db.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE is_active)::int AS active,
         COUNT(*) FILTER (WHERE terminal_outcome = 'appointment_booked')::int AS booked,
         COUNT(*) FILTER (WHERE terminal_outcome IN (${HANDOFF_OUTCOMES.join(',')}))::int AS handoffs,
         COUNT(*) FILTER (WHERE terminal_outcome IN (${DEACTIVATING_OUTCOMES.join(',')}))::int AS dnc,
         COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
         COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens
       FROM conversations ${botWhere}`,
      botParams
    );
    const botKpi = botKpiRes.rows[0];

    const msgParams = [];
    const msgFilters = [];
    if (locIds.length) { msgParams.push(locIds); msgFilters.push(`location_id = ANY($${msgParams.length})`); }
    msgParams.push(daysInt);
    msgFilters.push(`created_at >= NOW() - ($${msgParams.length} || ' days')::interval`);
    const msgWhere = `WHERE ${msgFilters.join(' AND ')}`;

    const msgRes = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE direction = 'inbound')::int AS inbound,
         COUNT(*) FILTER (WHERE direction = 'outbound')::int AS outbound,
         AVG(reply_time_seconds) FILTER (WHERE direction = 'outbound' AND got_reply)::float AS avg_response_time,
         COALESCE(SUM(segments) FILTER (WHERE direction = 'outbound'), 0)::int AS out_segments,
         COALESCE(SUM(segments) FILTER (WHERE direction = 'inbound'), 0)::int AS in_segments
       FROM messages ${msgWhere}`,
      msgParams
    );
    const mg = msgRes.rows[0];

    const avgMsgRes = await db.query(
      `SELECT AVG(cnt)::float AS avg_msgs FROM (
         SELECT conversation_id, COUNT(*)::int AS cnt FROM messages ${msgWhere} GROUP BY conversation_id
       ) t`,
      msgParams
    );

    // --- 2) GHL-pulled conversation view (the "full picture" layer) ---
    const ghlParams = [];
    const ghlFilters = [];
    if (locIds.length) { ghlParams.push(locIds); ghlFilters.push(`location_id = ANY($${ghlParams.length})`); }
    ghlParams.push(daysInt);
    ghlFilters.push(`COALESCE(last_message_at, ghl_date_added, pulled_at) >= NOW() - ($${ghlParams.length} || ' days')::interval`);
    const ghlWhere = ghlFilters.length ? `WHERE ${ghlFilters.join(' AND ')}` : '';

    const ghlKpiRes = await db.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE terminal_outcome = 'appointment_booked')::int AS booked,
         COUNT(*) FILTER (WHERE terminal_outcome = 'dnc')::int AS dnc,
         COUNT(*) FILTER (WHERE terminal_outcome IS NOT NULL)::int AS completed,
         COUNT(*) FILTER (WHERE terminal_outcome IS NULL)::int AS open,
         COALESCE(AVG(message_count) FILTER (WHERE terminal_outcome IS NOT NULL), 0)::float AS avg_messages_to_resolution,
         COALESCE(AVG(message_count), 0)::float AS avg_messages_overall,
         COUNT(*) FILTER (WHERE message_count > 1)::int AS replied_to,
         COUNT(*) FILTER (WHERE source = 'claude')::int AS src_claude,
         COUNT(*) FILTER (WHERE source = 'botpress')::int AS src_botpress,
         COUNT(*) FILTER (WHERE source = 'other')::int AS src_other
       FROM ghl_conversations ${ghlWhere}`,
      ghlParams
    );
    const ghlKpi = ghlKpiRes.rows[0] || {};

    const ghlOutboundRes = await db.query(
      `SELECT COUNT(*) FILTER (WHERE direction = 'outbound')::int AS outbound,
              COUNT(*) FILTER (WHERE direction = 'inbound')::int AS inbound,
              COUNT(DISTINCT ghl_conversation_id) FILTER (WHERE direction = 'outbound')::int AS convs_with_outbound,
              COUNT(DISTINCT ghl_conversation_id) FILTER (WHERE direction = 'inbound')::int AS convs_with_inbound
       FROM ghl_messages
       ${locIds.length ? `WHERE location_id = ANY($1) AND created_at >= NOW() - ($2 || ' days')::interval` : `WHERE created_at >= NOW() - ($1 || ' days')::interval`}`,
      locIds.length ? [locIds, daysInt] : [daysInt]
    );
    const ghlOut = ghlOutboundRes.rows[0] || {};

    // --- 3) Combined headline numbers (prefer GHL-pulled since it includes
    //        BotPress + manual agent + Claude, not just Claude-bot rows) ---
    const totalConversations = ghlKpi.total || botKpi.total || 0;
    const appointmentsBooked = (ghlKpi.booked || 0) + (botKpi.booked || 0);
    const dncCount = (ghlKpi.dnc || 0) + Math.max(0, (botKpi.dnc || 0) - (ghlKpi.dnc || 0));
    const handoffs = botKpi.handoffs || 0;

    const sentTo = ghlOut.convs_with_outbound || 0;
    const replied = ghlOut.convs_with_inbound || 0;
    const responseRate = sentTo ? replied / sentTo : 0;
    const bookingRate = totalConversations ? appointmentsBooked / totalConversations : 0;
    const optOutRate = totalConversations ? dncCount / totalConversations : 0;
    const dncRate = optOutRate; // alias

    // --- 4) Cost + time saved ---
    const inputCost = (Number(botKpi.input_tokens) * costConfig.input_cost_per_m) / 1000000;
    const outputCost = (Number(botKpi.output_tokens) * costConfig.output_cost_per_m) / 1000000;
    const aiCost = inputCost + outputCost;

    const outSegments = mg.out_segments || 0;
    const inSegments = mg.in_segments || 0;
    const carrierCost = outSegments * costConfig.carrier_out + inSegments * costConfig.carrier_in;

    // Webhook billing: terminal outcomes fire a webhook. Estimate count.
    const webhookFiredQ = await db.query(
      `SELECT COUNT(*)::int AS n FROM conversations ${botWhere} AND terminal_outcome IS NOT NULL`,
      botParams
    );
    const webhookEvents = webhookFiredQ.rows[0]?.n || 0;
    const webhookBillable = Math.max(0, webhookEvents - costConfig.webhook_free);
    const webhookCost = webhookBillable * costConfig.webhook_cost;

    const totalMessages = (mg.outbound || 0) + (mg.inbound || 0) || 1;
    const costPerMessage = (aiCost + carrierCost + webhookCost) / totalMessages;

    const smsSavedSec = ((mg.outbound || 0) + (mg.inbound || 0)) * 100;
    const callSavedSec = appointmentsBooked * 120;
    const adminSavedSec = (totalConversations || 0) * 15;
    const hoursSaved = Math.round((smsSavedSec + callSavedSec + adminSavedSec) / 3600);

    // --- 5) Per-subaccount breakdown (merges bot-only metrics with GHL totals) ---
    const subParams = [daysInt];
    const subRes = await db.query(
      `WITH ghl_agg AS (
         SELECT location_id,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE terminal_outcome = 'appointment_booked')::int AS booked,
           COUNT(*) FILTER (WHERE terminal_outcome = 'dnc')::int AS dnc,
           COUNT(*) FILTER (WHERE message_count > 1)::int AS replied
         FROM ghl_conversations
         WHERE COALESCE(last_message_at, ghl_date_added, pulled_at) >= NOW() - ($1 || ' days')::interval
         GROUP BY location_id
       ),
       bot_agg AS (
         SELECT location_id,
           COUNT(*)::int AS bot_total,
           COUNT(*) FILTER (WHERE terminal_outcome = 'human_handoff')::int AS handoffs,
           COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
           COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
           COALESCE(AVG(jsonb_array_length(messages)), 0)::float AS avg_messages
         FROM conversations
         WHERE is_sandbox = FALSE AND created_at >= NOW() - ($1 || ' days')::interval
         GROUP BY location_id
       ),
       msg_agg AS (
         SELECT location_id,
           COALESCE(SUM(segments) FILTER (WHERE direction = 'outbound'), 0)::int AS out_segments,
           COALESCE(SUM(segments) FILTER (WHERE direction = 'inbound'), 0)::int AS in_segments
         FROM messages
         WHERE created_at >= NOW() - ($1 || ' days')::interval
         GROUP BY location_id
       )
       SELECT COALESCE(g.location_id, b.location_id, m.location_id) AS location_id,
              s.name AS subaccount_name,
              COALESCE(g.total, b.bot_total, 0) AS total_conversations,
              COALESCE(g.booked, 0) AS appointments_booked,
              COALESCE(g.dnc, 0) AS dnc_count,
              COALESCE(b.handoffs, 0) AS human_handoffs,
              COALESCE(g.replied, 0) AS replied_to,
              COALESCE(b.avg_messages, 0) AS avg_messages_per_conversation,
              COALESCE(b.input_tokens, 0) AS input_tokens,
              COALESCE(b.output_tokens, 0) AS output_tokens,
              COALESCE(m.out_segments, 0) AS out_segments,
              COALESCE(m.in_segments, 0) AS in_segments
         FROM ghl_agg g
         FULL OUTER JOIN bot_agg b ON g.location_id = b.location_id
         FULL OUTER JOIN msg_agg m ON COALESCE(g.location_id, b.location_id) = m.location_id
         LEFT JOIN subaccounts s ON s.ghl_location_id = COALESCE(g.location_id, b.location_id, m.location_id)
        ORDER BY total_conversations DESC`,
      subParams
    );

    const perSubaccount = subRes.rows.map((r) => {
      const total = Number(r.total_conversations) || 0;
      const replied = Number(r.replied_to) || 0;
      const booked = Number(r.appointments_booked) || 0;
      const dnc = Number(r.dnc_count) || 0;
      const outSeg = Number(r.out_segments) || 0;
      const inSeg = Number(r.in_segments) || 0;
      const inTok = Number(r.input_tokens) || 0;
      const outTok = Number(r.output_tokens) || 0;
      const ai = (inTok * costConfig.input_cost_per_m + outTok * costConfig.output_cost_per_m) / 1000000;
      const carrier = outSeg * costConfig.carrier_out + inSeg * costConfig.carrier_in;
      return {
        location_id: r.location_id,
        subaccount_name: r.subaccount_name || null,
        total_conversations: total,
        appointments_booked: booked,
        human_handoffs: Number(r.human_handoffs) || 0,
        dnc_count: dnc,
        opt_out_rate: total ? dnc / total : 0,
        response_rate: total ? replied / total : 0,
        booking_rate: total ? booked / total : 0,
        avg_messages_per_conversation: Number(r.avg_messages_per_conversation) || 0,
        ai_cost: Math.round(ai * 10000) / 10000,
        carrier_cost: Math.round(carrier * 10000) / 10000,
        total_cost: Math.round((ai + carrier) * 10000) / 10000,
        time_saved_hours: Math.round(((outSeg + inSeg) * 100 + booked * 120) / 3600)
      };
    });

    // --- 6) Response outcome donut (from GHL-pulled) ---
    const outcomeRes = await db.query(
      `SELECT
         CASE
           WHEN terminal_outcome = 'appointment_booked' THEN 'Booked'
           WHEN terminal_outcome IN ('human_handoff','handoff_requested') THEN 'Live Transfer'
           WHEN terminal_outcome IN ('dnc','opted_out','opt_out','stop_requested') THEN 'Opt-Out / DNC'
           WHEN terminal_outcome IS NOT NULL THEN terminal_outcome
           WHEN message_count > 1 THEN 'Pending'
           ELSE 'No Response'
         END AS outcome,
         COUNT(*)::int AS count
       FROM ghl_conversations ${ghlWhere}
       GROUP BY 1 ORDER BY 2 DESC`,
      ghlParams
    );

    // --- 7) Daily trend (from GHL-pulled so it reflects ALL conversations) ---
    const trendParams = [];
    if (locIds.length) { trendParams.push(locIds); }
    trendParams.push(daysInt);
    const trendWhere = locIds.length
      ? `WHERE location_id = ANY($1) AND COALESCE(ghl_date_added, last_message_at, pulled_at) >= NOW() - ($2 || ' days')::interval`
      : `WHERE COALESCE(ghl_date_added, last_message_at, pulled_at) >= NOW() - ($1 || ' days')::interval`;
    const trendRes = await db.query(
      `SELECT COALESCE(ghl_date_added, last_message_at, pulled_at)::date AS date,
              COUNT(*)::int AS conversations_started,
              COUNT(*) FILTER (WHERE terminal_outcome = 'appointment_booked')::int AS booked,
              COUNT(*) FILTER (WHERE terminal_outcome = 'dnc')::int AS dnc
       FROM ghl_conversations ${trendWhere}
       GROUP BY 1 ORDER BY 1`,
      trendParams
    );

    // --- 8) Appointments by type (uses bot-local conversations.product_type) ---
    const apptByTypeRes = await db.query(
      `SELECT COALESCE(NULLIF(product_type, ''), 'Unknown') AS type,
              COUNT(*)::int AS count
       FROM conversations ${botWhere}
         AND terminal_outcome = 'appointment_booked'
       GROUP BY 1 ORDER BY 2 DESC`,
      botParams
    );

    res.json({
      kpis: {
        total_conversations: totalConversations,
        active_conversations: botKpi.active || 0,
        completed_conversations: ghlKpi.completed || 0,
        appointments_booked: appointmentsBooked,
        booking_rate: bookingRate,
        appointment_rate: bookingRate, // backwards-compat alias
        human_handoffs: handoffs,
        dnc_count: dncCount,
        dnc_rate: dncRate,
        opt_out_rate: optOutRate,
        response_rate: responseRate,
        sms_response_rate: responseRate,
        avg_messages_per_conversation: avgMsgRes.rows[0]?.avg_msgs || ghlKpi.avg_messages_overall || 0,
        avg_messages_to_resolution: ghlKpi.avg_messages_to_resolution || 0,
        avg_response_time_seconds: mg.avg_response_time || 0,
        total_inbound: mg.inbound || 0,
        total_outbound: mg.outbound || 0,
        total_input_tokens: Number(botKpi.input_tokens) || 0,
        total_output_tokens: Number(botKpi.output_tokens) || 0,
        ai_cost: Math.round(aiCost * 100) / 100,
        carrier_cost: Math.round(carrierCost * 100) / 100,
        webhook_cost: Math.round(webhookCost * 100) / 100,
        total_cost: Math.round((aiCost + carrierCost + webhookCost) * 100) / 100,
        cost_per_message: Math.round(costPerMessage * 10000) / 10000,
        total_segments: outSegments + inSegments,
        total_segments_outbound: outSegments,
        total_segments_inbound: inSegments,
        hours_saved: hoursSaved,
        time_saved_breakdown: {
          sms_responded_hours: Math.round((smsSavedSec / 3600) * 10) / 10,
          phone_calls_avoided_hours: Math.round((callSavedSec / 3600) * 10) / 10,
          admin_per_contact_hours: Math.round((adminSavedSec / 3600) * 10) / 10
        },
        by_source: {
          claude: ghlKpi.src_claude || 0,
          botpress: ghlKpi.src_botpress || 0,
          other: ghlKpi.src_other || 0
        },
        webhook_events: webhookEvents,
        webhook_billable_events: webhookBillable
      },
      cost_config: costConfig,
      trends: trendRes.rows.map((r) => ({
        date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : r.date,
        conversations_started: r.conversations_started,
        booked: r.booked,
        dnc: r.dnc
      })),
      response_outcomes: outcomeRes.rows,
      appointments_by_type: apptByTypeRes.rows,
      per_subaccount: perSubaccount
    });
  } catch (err) {
    console.error('[dashboard] error', err);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

module.exports = router;
