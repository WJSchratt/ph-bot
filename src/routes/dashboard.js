const express = require('express');
const db = require('../db');
const router = express.Router();

router.get('/dashboard', async (req, res) => {
  try {
    const { location_id, days = 30 } = req.query;
    const params = [];
    const filters = ['is_sandbox = FALSE'];
    if (location_id) { params.push(location_id); filters.push(`c.location_id = $${params.length}`); }
    const daysInt = parseInt(days, 10) || 30;
    params.push(daysInt);
    filters.push(`c.created_at >= NOW() - ($${params.length} || ' days')::interval`);
    const where = `WHERE ${filters.join(' AND ')}`;
    const cAlias = where.replace(/c\./g, '');

    // KPIs from conversations
    const kpiRes = await db.query(
      `SELECT
         COUNT(*)::int AS total_conversations,
         COUNT(*) FILTER (WHERE c.is_active)::int AS active_conversations,
         COUNT(*) FILTER (WHERE c.terminal_outcome IS NOT NULL)::int AS completed_conversations,
         COUNT(*) FILTER (WHERE c.terminal_outcome = 'appointment_booked')::int AS appointments_booked,
         COUNT(*) FILTER (WHERE c.terminal_outcome = 'fex_immediate')::int AS fex_immediate,
         COUNT(*) FILTER (WHERE c.terminal_outcome = 'mp_immediate')::int AS mp_immediate,
         COUNT(*) FILTER (WHERE c.terminal_outcome = 'human_handoff')::int AS human_handoffs,
         COUNT(*) FILTER (WHERE c.terminal_outcome = 'dnc')::int AS dnc_count,
         COALESCE(SUM(c.input_tokens), 0)::bigint AS total_input_tokens,
         COALESCE(SUM(c.output_tokens), 0)::bigint AS total_output_tokens
       FROM conversations c ${where}`,
      params
    );
    const k = kpiRes.rows[0];
    const total = k.total_conversations || 1;

    // Message stats
    const msgParams = [];
    const msgFilters = [];
    if (location_id) { msgParams.push(location_id); msgFilters.push(`m.location_id = $${msgParams.length}`); }
    msgParams.push(daysInt);
    msgFilters.push(`m.created_at >= NOW() - ($${msgParams.length} || ' days')::interval`);
    const msgWhere = `WHERE ${msgFilters.join(' AND ')}`;

    const msgRes = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE m.direction = 'inbound')::int AS total_inbound,
         COUNT(*) FILTER (WHERE m.direction = 'outbound')::int AS total_outbound,
         AVG(m.reply_time_seconds) FILTER (WHERE m.direction = 'outbound' AND m.got_reply)::float AS avg_response_time,
         COALESCE(SUM(m.segments) FILTER (WHERE m.direction = 'outbound'), 0)::int AS total_segments
       FROM messages m ${msgWhere}`,
      msgParams
    );
    const mg = msgRes.rows[0];

    // Avg messages per conversation
    const avgMsgRes = await db.query(
      `SELECT AVG(cnt)::float AS avg_msgs FROM (
         SELECT conversation_id, COUNT(*)::int AS cnt FROM messages m ${msgWhere} GROUP BY conversation_id
       ) t`,
      msgParams
    );

    // Response rate (unique conversations that got a reply / conversations that got outbound)
    const respRateRes = await db.query(
      `SELECT
         COUNT(DISTINCT m.conversation_id) FILTER (WHERE m.direction = 'outbound')::int AS sent_to,
         COUNT(DISTINCT m.conversation_id) FILTER (WHERE m.direction = 'inbound')::int AS replied
       FROM messages m ${msgWhere}`,
      msgParams
    );
    const rr = respRateRes.rows[0];
    const responseRate = rr.sent_to ? (rr.replied / rr.sent_to) : 0;

    // Cost estimation (Claude Sonnet pricing: $3/MTok input, $15/MTok output)
    const inputCost = (Number(k.total_input_tokens) * 3) / 1000000;
    const outputCost = (Number(k.total_output_tokens) * 15) / 1000000;
    const totalAiCost = inputCost + outputCost;
    const carrierCost = (mg.total_segments || 0) * 0.0075;
    const totalMessages = (mg.total_outbound || 1);
    const costPerMessage = (totalAiCost + carrierCost) / totalMessages;

    // Per-subaccount breakdown
    const subParams = [];
    const subFilters = ['c.is_sandbox = FALSE'];
    subParams.push(daysInt);
    subFilters.push(`c.created_at >= NOW() - ($${subParams.length} || ' days')::interval`);
    const subWhere = `WHERE ${subFilters.join(' AND ')}`;

    const subRes = await db.query(
      `SELECT c.location_id,
         COALESCE(s.name, c.location_id) AS name,
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE c.terminal_outcome = 'appointment_booked')::int AS appointments,
         COUNT(*) FILTER (WHERE c.terminal_outcome = 'dnc')::int AS dnc,
         COUNT(*) FILTER (WHERE c.terminal_outcome = 'human_handoff')::int AS handoffs,
         COALESCE(SUM(c.input_tokens), 0)::bigint AS input_tokens,
         COALESCE(SUM(c.output_tokens), 0)::bigint AS output_tokens
       FROM conversations c
       LEFT JOIN subaccounts s ON s.ghl_location_id = c.location_id
       ${subWhere}
       GROUP BY c.location_id, s.name
       ORDER BY total DESC`,
      subParams
    );

    // Response outcomes for doughnut chart
    const outcomeRes = await db.query(
      `SELECT
         COALESCE(terminal_outcome, CASE WHEN is_active THEN 'active' ELSE 'no_response' END) AS outcome,
         COUNT(*)::int AS count
       FROM conversations c ${where}
       GROUP BY 1 ORDER BY count DESC`,
      params
    );

    // Daily trend (last N days from conversations)
    const trendParams = [];
    trendParams.push(daysInt);
    const trendFilters = ['is_sandbox = FALSE'];
    if (location_id) { trendParams.push(location_id); trendFilters.push(`location_id = $${trendParams.length}`); }
    const trendWhere = `WHERE ${trendFilters.join(' AND ')}`;

    const trendRes = await db.query(
      `SELECT created_at::date AS date,
         COUNT(*)::int AS conversations,
         COUNT(*) FILTER (WHERE terminal_outcome = 'appointment_booked')::int AS booked,
         COUNT(*) FILTER (WHERE terminal_outcome = 'dnc')::int AS dnc,
         COALESCE(SUM(input_tokens), 0)::int AS input_tokens,
         COALESCE(SUM(output_tokens), 0)::int AS output_tokens
       FROM conversations ${trendWhere} AND created_at >= NOW() - ($1 || ' days')::interval
       GROUP BY 1 ORDER BY 1`,
      trendParams
    );

    // Time saved calculation (100s per SMS handled by AI)
    const totalHandled = (mg.total_inbound || 0) + (mg.total_outbound || 0);
    const hoursSaved = Math.round((totalHandled * 100) / 3600);

    res.json({
      kpis: {
        total_conversations: k.total_conversations,
        active_conversations: k.active_conversations,
        completed_conversations: k.completed_conversations,
        appointments_booked: k.appointments_booked,
        appointment_rate: k.appointments_booked / total,
        fex_immediate: k.fex_immediate,
        mp_immediate: k.mp_immediate,
        human_handoffs: k.human_handoffs,
        dnc_count: k.dnc_count,
        opt_out_rate: k.dnc_count / total,
        response_rate: responseRate,
        avg_messages_per_conversation: avgMsgRes.rows[0]?.avg_msgs || 0,
        avg_response_time_seconds: mg.avg_response_time || 0,
        total_inbound: mg.total_inbound,
        total_outbound: mg.total_outbound,
        total_input_tokens: Number(k.total_input_tokens),
        total_output_tokens: Number(k.total_output_tokens),
        ai_cost: Math.round(totalAiCost * 100) / 100,
        carrier_cost: Math.round(carrierCost * 100) / 100,
        cost_per_message: Math.round(costPerMessage * 10000) / 10000,
        total_segments: mg.total_segments,
        hours_saved: hoursSaved
      },
      trends: trendRes.rows,
      response_outcomes: outcomeRes.rows,
      per_subaccount: subRes.rows
    });
  } catch (err) {
    console.error('[dashboard] error', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
