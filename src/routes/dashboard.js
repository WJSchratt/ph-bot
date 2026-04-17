const express = require('express');
const db = require('../db');
const router = express.Router();

const DEACTIVATING_OUTCOMES = ["'dnc'", "'opted_out'", "'opt_out'", "'stop_requested'"];
const BOOKED_OUTCOMES = ["'appointment_booked'", "'fex_immediate'", "'mp_immediate'"];
const HANDOFF_OUTCOMES = ["'human_handoff'", "'handoff_requested'"];

async function loadCostConfig() {
  const defaults = {
    // Anthropic (kept for legacy per-subaccount token-based cost estimation only —
    // real per-category totals now come from anthropic_usage_log.cost_usd).
    input_cost_per_m: 3,
    output_cost_per_m: 15,
    // Signal House SMS carrier.
    sh_base_monthly: 50,
    sh_base_segments: 7500,
    sh_overage_per_seg: 0.01,
    sh_mms_per_seg: 0.04
  };
  try {
    const q = await db.query(`SELECT key, value FROM app_settings WHERE section = 'cost_config'`);
    const map = {};
    for (const r of q.rows) map[r.key] = r.value;
    return {
      input_cost_per_m: parseFloat(map.input_token_cost_per_million) || defaults.input_cost_per_m,
      output_cost_per_m: parseFloat(map.output_token_cost_per_million) || defaults.output_cost_per_m,
      sh_base_monthly: parseFloat(map.signal_house_base_monthly) || defaults.sh_base_monthly,
      sh_base_segments: parseInt(map.signal_house_base_segments, 10) || defaults.sh_base_segments,
      sh_overage_per_seg: parseFloat(map.signal_house_overage_per_seg) || defaults.sh_overage_per_seg,
      sh_mms_per_seg: parseFloat(map.signal_house_mms_per_seg) || defaults.sh_mms_per_seg
    };
  } catch {
    return defaults;
  }
}

/**
 * Signal House cost for a date range:
 *   base = (days_in_range / 30) * $50/mo
 *   segments_covered = min(sms_segments, sh_base_segments * days_in_range / 30)
 *   overage = max(0, sms_segments - segments_covered) * overage_per_seg
 *   mms = mms_segments * mms_per_seg
 *   total = base + overage + mms
 */
function computeSignalHouseCost({ smsSegments, mmsSegments, daysInRange, cfg }) {
  const days = Math.max(1, daysInRange);
  const proratedBase = (days / 30) * cfg.sh_base_monthly;
  const proratedBaseSegments = (days / 30) * cfg.sh_base_segments;
  const overageSegments = Math.max(0, smsSegments - proratedBaseSegments);
  const overageCost = overageSegments * cfg.sh_overage_per_seg;
  const mmsCost = mmsSegments * cfg.sh_mms_per_seg;
  return {
    base_cost: Math.round(proratedBase * 100) / 100,
    base_segments_included: Math.round(proratedBaseSegments),
    overage_segments: Math.round(overageSegments),
    overage_cost: Math.round(overageCost * 100) / 100,
    mms_segments: mmsSegments,
    mms_cost: Math.round(mmsCost * 100) / 100,
    total: Math.round((proratedBase + overageCost + mmsCost) * 100) / 100
  };
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
         COALESCE(SUM(segments) FILTER (WHERE direction = 'outbound' AND COALESCE(message_type, '') NOT ILIKE '%mms%'), 0)::int AS sms_out_segments,
         COALESCE(SUM(segments) FILTER (WHERE direction = 'inbound'  AND COALESCE(message_type, '') NOT ILIKE '%mms%'), 0)::int AS sms_in_segments,
         COALESCE(SUM(segments) FILTER (WHERE direction = 'outbound' AND COALESCE(message_type, '') ILIKE '%mms%'), 0)::int AS mms_out_segments,
         COALESCE(SUM(segments) FILTER (WHERE direction = 'inbound'  AND COALESCE(message_type, '') ILIKE '%mms%'), 0)::int AS mms_in_segments
       FROM messages ${msgWhere}`,
      msgParams
    );
    const mg = msgRes.rows[0];

    // Additional MMS detection from pulled GHL data.
    const mmsGhlQ = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE direction = 'outbound' AND message_type ILIKE '%MMS%')::int AS mms_out,
         COUNT(*) FILTER (WHERE direction = 'inbound'  AND message_type ILIKE '%MMS%')::int AS mms_in
       FROM ghl_messages gm
       ${locIds.length ? 'WHERE location_id = ANY($1) AND created_at >= NOW() - ($2 || \' days\')::interval' : 'WHERE created_at >= NOW() - ($1 || \' days\')::interval'}`,
      locIds.length ? [locIds, daysInt] : [daysInt]
    );
    const ghlMms = mmsGhlQ.rows[0] || { mms_out: 0, mms_in: 0 };

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

    // --- 3) Combined headline numbers ---
    const totalConversations = ghlKpi.total || botKpi.total || 0;
    const appointmentsBooked = (ghlKpi.booked || 0) + (botKpi.booked || 0);
    const dncCount = (ghlKpi.dnc || 0) + Math.max(0, (botKpi.dnc || 0) - (ghlKpi.dnc || 0));
    const handoffs = botKpi.handoffs || 0;

    const sentTo = ghlOut.convs_with_outbound || 0;
    const replied = ghlOut.convs_with_inbound || 0;
    const responseRate = sentTo ? replied / sentTo : 0;
    const bookingRate = totalConversations ? appointmentsBooked / totalConversations : 0;
    const optOutRate = totalConversations ? dncCount / totalConversations : 0;
    const dncRate = optOutRate;

    // --- 4) Signal House carrier cost (prorated base + overage + MMS) ---
    const smsOutSeg = mg.sms_out_segments || 0;
    const smsInSeg = mg.sms_in_segments || 0;
    const mmsOutSeg = (mg.mms_out_segments || 0) + (ghlMms.mms_out || 0);
    const mmsInSeg = (mg.mms_in_segments || 0) + (ghlMms.mms_in || 0);
    const totalSmsSegments = smsOutSeg + smsInSeg;
    const totalMmsSegments = mmsOutSeg + mmsInSeg;

    const signalHouse = computeSignalHouseCost({
      smsSegments: totalSmsSegments,
      mmsSegments: totalMmsSegments,
      daysInRange: daysInt,
      cfg: costConfig
    });
    const carrierCost = signalHouse.total;

    // --- 5) Anthropic API cost breakdown (from anthropic_usage_log) ---
    const usageParams = [daysInt];
    let usageWhere = `created_at >= NOW() - ($1 || ' days')::interval`;
    if (locIds.length) {
      usageParams.push(locIds);
      // Note: many call categories don't attach a location_id (analyzer cross-account,
      // dev_console). When a location filter is applied, include only rows matching
      // one of those locations.
      usageWhere += ` AND location_id = ANY($${usageParams.length})`;
    }

    // Diagnostic first: does the table even exist? If the migration hasn't
    // run, every INSERT in callAnthropic() fails silently, which is how
    // Bug 2 happened (dashboard fell back to stale conversations tokens).
    let anthropicLogStatus = { table_exists: false, row_count_total: 0, newest_row_at: null, oldest_row_at: null };
    try {
      const statusQ = await db.query(
        `SELECT to_regclass('anthropic_usage_log') AS t,
                (SELECT COUNT(*) FROM anthropic_usage_log) AS total,
                (SELECT MAX(created_at) FROM anthropic_usage_log) AS newest,
                (SELECT MIN(created_at) FROM anthropic_usage_log) AS oldest`
      );
      anthropicLogStatus = {
        table_exists: !!statusQ.rows[0]?.t,
        row_count_total: Number(statusQ.rows[0]?.total) || 0,
        newest_row_at: statusQ.rows[0]?.newest || null,
        oldest_row_at: statusQ.rows[0]?.oldest || null
      };
    } catch (err) {
      // to_regclass returns null when the table is missing, so this path
      // usually only fires if the DB itself is unreachable.
      anthropicLogStatus.error = err.message;
    }

    let anthropicTotals = {};
    if (anthropicLogStatus.table_exists) {
      const anthropicTotalsRes = await db.query(
        `SELECT
           COALESCE(SUM(cost_usd), 0)::numeric AS total_cost,
           COALESCE(SUM(input_tokens), 0)::bigint AS total_input,
           COALESCE(SUM(output_tokens), 0)::bigint AS total_output,
           COALESCE(SUM(cache_creation_input_tokens), 0)::bigint AS total_cache_write,
           COALESCE(SUM(cache_read_input_tokens), 0)::bigint AS total_cache_read,
           COUNT(*)::int AS call_count
         FROM anthropic_usage_log
         WHERE ${usageWhere}`,
        usageParams
      );
      anthropicTotals = anthropicTotalsRes.rows[0] || {};
    }

    let anthropicByCatRes = { rows: [] };
    let anthropicDailyRes = { rows: [] };
    if (anthropicLogStatus.table_exists) {
      anthropicByCatRes = await db.query(
        `SELECT category,
                COUNT(*)::int AS call_count,
                COALESCE(SUM(cost_usd), 0)::numeric AS cost_usd,
                COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
                COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
                COALESCE(SUM(cache_creation_input_tokens), 0)::bigint AS cache_write_tokens,
                COALESCE(SUM(cache_read_input_tokens), 0)::bigint AS cache_read_tokens,
                COALESCE(AVG(duration_ms), 0)::int AS avg_ms
         FROM anthropic_usage_log
         WHERE ${usageWhere}
         GROUP BY category
         ORDER BY cost_usd DESC`,
        usageParams
      );

      anthropicDailyRes = await db.query(
        `SELECT created_at::date AS date,
                category,
                COALESCE(SUM(cost_usd), 0)::numeric AS cost_usd
         FROM anthropic_usage_log
         WHERE ${usageWhere}
         GROUP BY 1, 2
         ORDER BY 1 ASC`,
        usageParams
      );
    }

    const aiCost = Number(anthropicTotals.total_cost) || 0;

    // --- 6) Cost-per-message + time saved ---
    const totalMessages = (mg.outbound || 0) + (mg.inbound || 0) || 1;
    const totalCost = aiCost + carrierCost;
    const costPerMessage = totalCost / totalMessages;

    const smsSavedSec = ((mg.outbound || 0) + (mg.inbound || 0)) * 100;
    const callSavedSec = appointmentsBooked * 120;
    const adminSavedSec = (totalConversations || 0) * 15;
    const hoursSaved = Math.round((smsSavedSec + callSavedSec + adminSavedSec) / 3600);

    // --- 7) Per-subaccount breakdown ---
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
           COALESCE(AVG(jsonb_array_length(messages)), 0)::float AS avg_messages
         FROM conversations
         WHERE is_sandbox = FALSE AND created_at >= NOW() - ($1 || ' days')::interval
         GROUP BY location_id
       ),
       msg_agg AS (
         SELECT location_id,
           COALESCE(SUM(segments) FILTER (WHERE direction = 'outbound' AND COALESCE(message_type, '') NOT ILIKE '%mms%'), 0)::int AS sms_out,
           COALESCE(SUM(segments) FILTER (WHERE direction = 'inbound'  AND COALESCE(message_type, '') NOT ILIKE '%mms%'), 0)::int AS sms_in,
           COALESCE(SUM(segments) FILTER (WHERE direction = 'outbound' AND COALESCE(message_type, '') ILIKE '%mms%'), 0)::int AS mms_out,
           COALESCE(SUM(segments) FILTER (WHERE direction = 'inbound'  AND COALESCE(message_type, '') ILIKE '%mms%'), 0)::int AS mms_in
         FROM messages
         WHERE created_at >= NOW() - ($1 || ' days')::interval
         GROUP BY location_id
       ),
       usage_agg AS (
         SELECT location_id,
           COALESCE(SUM(cost_usd), 0)::numeric AS ai_cost,
           COUNT(*)::int AS ai_calls
         FROM anthropic_usage_log
         WHERE created_at >= NOW() - ($1 || ' days')::interval AND location_id IS NOT NULL
         GROUP BY location_id
       )
       SELECT COALESCE(g.location_id, b.location_id, m.location_id, u.location_id) AS location_id,
              s.name AS subaccount_name,
              COALESCE(g.total, b.bot_total, 0) AS total_conversations,
              COALESCE(g.booked, 0) AS appointments_booked,
              COALESCE(g.dnc, 0) AS dnc_count,
              COALESCE(b.handoffs, 0) AS human_handoffs,
              COALESCE(g.replied, 0) AS replied_to,
              COALESCE(b.avg_messages, 0) AS avg_messages_per_conversation,
              COALESCE(m.sms_out, 0) AS sms_out,
              COALESCE(m.sms_in, 0) AS sms_in,
              COALESCE(m.mms_out, 0) AS mms_out,
              COALESCE(m.mms_in, 0) AS mms_in,
              COALESCE(u.ai_cost, 0) AS ai_cost,
              COALESCE(u.ai_calls, 0) AS ai_calls
         FROM ghl_agg g
         FULL OUTER JOIN bot_agg b ON g.location_id = b.location_id
         FULL OUTER JOIN msg_agg m ON COALESCE(g.location_id, b.location_id) = m.location_id
         FULL OUTER JOIN usage_agg u ON COALESCE(g.location_id, b.location_id, m.location_id) = u.location_id
         LEFT JOIN subaccounts s ON s.ghl_location_id = COALESCE(g.location_id, b.location_id, m.location_id, u.location_id)
        ORDER BY total_conversations DESC`,
      subParams
    );

    const perSubaccount = subRes.rows.map((r) => {
      const total = Number(r.total_conversations) || 0;
      const replied = Number(r.replied_to) || 0;
      const booked = Number(r.appointments_booked) || 0;
      const dnc = Number(r.dnc_count) || 0;
      const smsSeg = (Number(r.sms_out) || 0) + (Number(r.sms_in) || 0);
      const mmsSeg = (Number(r.mms_out) || 0) + (Number(r.mms_in) || 0);
      const ai = Number(r.ai_cost) || 0;
      const sh = computeSignalHouseCost({
        smsSegments: smsSeg,
        mmsSegments: mmsSeg,
        daysInRange: daysInt,
        cfg: costConfig
      });
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
        ai_calls: Number(r.ai_calls) || 0,
        carrier_cost: sh.total,
        carrier_breakdown: sh,
        total_cost: Math.round((ai + sh.total) * 10000) / 10000,
        time_saved_hours: Math.round(((smsSeg) * 100 + booked * 120) / 3600)
      };
    });

    // --- 8) Response outcome donut ---
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

    // --- 9) Daily trend ---
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

    // --- 10) Appointments by type ---
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
        appointment_rate: bookingRate,
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
        // Tokens come from anthropic_usage_log only — no fallback to the old
        // conversations.input_tokens column, since that fallback masked Bug 2
        // (the log table was missing in prod and $0/0 calls got hidden by
        // stale per-conversation counts).
        total_input_tokens: Number(anthropicTotals.total_input) || 0,
        total_output_tokens: Number(anthropicTotals.total_output) || 0,
        total_cache_write_tokens: Number(anthropicTotals.total_cache_write) || 0,
        total_cache_read_tokens: Number(anthropicTotals.total_cache_read) || 0,
        ai_cost: Math.round(aiCost * 100) / 100,
        ai_calls: Number(anthropicTotals.call_count) || 0,
        carrier_cost: carrierCost,
        carrier_breakdown: signalHouse,
        total_cost: Math.round(totalCost * 100) / 100,
        cost_per_message: Math.round(costPerMessage * 10000) / 10000,
        total_segments: totalSmsSegments + totalMmsSegments,
        total_segments_outbound: smsOutSeg + mmsOutSeg,
        total_segments_inbound: smsInSeg + mmsInSeg,
        sms_segments: { outbound: smsOutSeg, inbound: smsInSeg, total: totalSmsSegments },
        mms_segments: { outbound: mmsOutSeg, inbound: mmsInSeg, total: totalMmsSegments },
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
        }
      },
      anthropic_breakdown: {
        log_status: anthropicLogStatus,
        total_cost: Math.round(aiCost * 10000) / 10000,
        call_count: Number(anthropicTotals.call_count) || 0,
        by_category: anthropicByCatRes.rows.map((r) => ({
          category: r.category,
          call_count: Number(r.call_count) || 0,
          cost_usd: Math.round(Number(r.cost_usd) * 10000) / 10000,
          input_tokens: Number(r.input_tokens) || 0,
          output_tokens: Number(r.output_tokens) || 0,
          cache_write_tokens: Number(r.cache_write_tokens) || 0,
          cache_read_tokens: Number(r.cache_read_tokens) || 0,
          avg_ms: Number(r.avg_ms) || 0
        })),
        daily: anthropicDailyRes.rows.map((r) => ({
          date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : r.date,
          category: r.category,
          cost_usd: Math.round(Number(r.cost_usd) * 10000) / 10000
        }))
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
