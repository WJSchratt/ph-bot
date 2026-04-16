const express = require('express');
const db = require('../db');
const logger = require('../services/logger');

const router = express.Router();

function startOfWeek(d) {
  const date = d ? new Date(d) : new Date();
  const day = date.getUTCDay();
  const diff = (day === 0 ? 6 : day - 1);
  date.setUTCDate(date.getUTCDate() - diff);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

async function loadCostConfig() {
  try {
    const q = await db.query(`SELECT key, value FROM app_settings WHERE section = 'cost_config'`);
    const m = {};
    for (const r of q.rows) m[r.key] = r.value;
    return {
      sms_out: parseFloat(m.carrier_cost_per_segment_outbound) || 0.01,
      sms_in: parseFloat(m.carrier_cost_per_segment_inbound) || 0.01,
      mms_out: parseFloat(m.carrier_cost_mms_outbound) || 0.04,
      mms_in: parseFloat(m.carrier_cost_mms_inbound) || 0.04,
      input_cost_per_m: parseFloat(m.input_token_cost_per_million) || 3,
      output_cost_per_m: parseFloat(m.output_token_cost_per_million) || 15
    };
  } catch {
    return { sms_out: 0.01, sms_in: 0.01, mms_out: 0.04, mms_in: 0.04, input_cost_per_m: 3, output_cost_per_m: 15 };
  }
}

async function computeSummaryForLocation(locationId, weekStart, weekEnd, costConfig) {
  const cost = costConfig || (await loadCostConfig());

  const ghlQ = await db.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE terminal_outcome = 'appointment_booked')::int AS booked,
       COUNT(*) FILTER (WHERE terminal_outcome IN ('dnc','opted_out','opt_out','stop_requested'))::int AS dnc,
       COUNT(*) FILTER (WHERE message_count > 1)::int AS replied
     FROM ghl_conversations
     WHERE location_id = $1 AND COALESCE(ghl_date_added, last_message_at, pulled_at) >= $2 AND COALESCE(ghl_date_added, last_message_at, pulled_at) < $3`,
    [locationId, weekStart, weekEnd]
  );
  const g = ghlQ.rows[0] || {};
  const total = g.total || 0;
  const responseRate = total ? (g.replied || 0) / total : 0;
  const bookingRate = total ? (g.booked || 0) / total : 0;

  const botQ = await db.query(
    `SELECT
       COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
       COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens
     FROM conversations
     WHERE is_sandbox = FALSE AND location_id = $1
       AND created_at >= $2 AND created_at < $3`,
    [locationId, weekStart, weekEnd]
  );
  const b = botQ.rows[0] || {};

  const msgQ = await db.query(
    `SELECT
       COALESCE(SUM(segments) FILTER (WHERE direction = 'outbound' AND COALESCE(message_type, '') NOT ILIKE '%mms%'), 0)::int AS sms_out,
       COALESCE(SUM(segments) FILTER (WHERE direction = 'inbound'  AND COALESCE(message_type, '') NOT ILIKE '%mms%'), 0)::int AS sms_in,
       COALESCE(SUM(segments) FILTER (WHERE direction = 'outbound' AND COALESCE(message_type, '') ILIKE '%mms%'), 0)::int AS mms_out,
       COALESCE(SUM(segments) FILTER (WHERE direction = 'inbound'  AND COALESCE(message_type, '') ILIKE '%mms%'), 0)::int AS mms_in
     FROM messages
     WHERE location_id = $1 AND created_at >= $2 AND created_at < $3`,
    [locationId, weekStart, weekEnd]
  );
  const m = msgQ.rows[0] || {};

  const ghlMmsQ = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE direction = 'outbound' AND message_type ILIKE '%MMS%')::int AS mms_out,
       COUNT(*) FILTER (WHERE direction = 'inbound'  AND message_type ILIKE '%MMS%')::int AS mms_in
     FROM ghl_messages
     WHERE location_id = $1 AND created_at >= $2 AND created_at < $3`,
    [locationId, weekStart, weekEnd]
  );
  const gm = ghlMmsQ.rows[0] || {};

  const aiCost = (Number(b.input_tokens) * cost.input_cost_per_m + Number(b.output_tokens) * cost.output_cost_per_m) / 1000000;
  const smsSegOut = m.sms_out || 0;
  const smsSegIn = m.sms_in || 0;
  const mmsSegOut = (m.mms_out || 0) + (gm.mms_out || 0);
  const mmsSegIn = (m.mms_in || 0) + (gm.mms_in || 0);
  const smsCost = smsSegOut * cost.sms_out + smsSegIn * cost.sms_in;
  const mmsCost = mmsSegOut * cost.mms_out + mmsSegIn * cost.mms_in;
  const carrierCost = smsCost + mmsCost;

  const apptsQ = await db.query(
    `SELECT contact_name, ghl_conversation_id, last_message_at
     FROM ghl_conversations
     WHERE location_id = $1 AND terminal_outcome = 'appointment_booked'
       AND COALESCE(ghl_date_added, last_message_at, pulled_at) >= $2 AND COALESCE(ghl_date_added, last_message_at, pulled_at) < $3
     ORDER BY last_message_at DESC LIMIT 25`,
    [locationId, weekStart, weekEnd]
  );

  return {
    location_id: locationId,
    week_start: weekStart.toISOString().slice(0, 10),
    week_end: weekEnd.toISOString().slice(0, 10),
    total_conversations: total,
    response_rate: responseRate,
    booking_rate: bookingRate,
    appointments_booked: g.booked || 0,
    dnc_count: g.dnc || 0,
    ai_cost: Math.round(aiCost * 100) / 100,
    sms_cost: Math.round(smsCost * 100) / 100,
    mms_cost: Math.round(mmsCost * 100) / 100,
    carrier_cost: Math.round(carrierCost * 100) / 100,
    total_cost: Math.round((aiCost + carrierCost) * 100) / 100,
    appointments: apptsQ.rows.map((r) => ({
      contact_name: r.contact_name,
      ghl_conversation_id: r.ghl_conversation_id,
      when: r.last_message_at
    }))
  };
}

async function generateAndStore(locationId, weekStart, weekEnd) {
  const data = await computeSummaryForLocation(locationId, weekStart, weekEnd);
  const prev = await computeSummaryForLocation(
    locationId,
    new Date(weekStart.getTime() - 7 * 86400000),
    weekStart
  );
  const pctChange = (cur, p) => (p ? ((cur - p) / p) : null);
  const comparison = {
    total_conversations_pct: pctChange(data.total_conversations, prev.total_conversations),
    response_rate_pct: pctChange(data.response_rate, prev.response_rate),
    booking_rate_pct: pctChange(data.booking_rate, prev.booking_rate),
    appointments_booked_pct: pctChange(data.appointments_booked, prev.appointments_booked),
    dnc_count_pct: pctChange(data.dnc_count, prev.dnc_count),
    total_cost_pct: pctChange(data.total_cost, prev.total_cost),
    previous: prev
  };
  const full = { ...data, comparison };
  await db.query(
    `INSERT INTO weekly_summaries (location_id, week_start, week_end, summary_data, generated_at)
     VALUES ($1, $2, $3, $4::jsonb, NOW())
     ON CONFLICT (location_id, week_start) DO UPDATE SET
       summary_data = EXCLUDED.summary_data,
       generated_at = NOW()`,
    [locationId, data.week_start, data.week_end, JSON.stringify(full)]
  );
  return full;
}

router.get('/weekly-summary/:locationId', async (req, res) => {
  try {
    const { locationId } = req.params;
    const weekStartQ = req.query.week_start ? new Date(req.query.week_start) : startOfWeek(new Date(Date.now() - 7 * 86400000));
    if (isNaN(weekStartQ.getTime())) return res.status(400).json({ error: 'invalid week_start' });
    weekStartQ.setUTCHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStartQ.getTime() + 7 * 86400000);

    const cached = await db.query(
      `SELECT summary_data, generated_at FROM weekly_summaries
       WHERE location_id = $1 AND week_start = $2`,
      [locationId, weekStartQ.toISOString().slice(0, 10)]
    );
    if (cached.rows[0] && req.query.refresh !== '1') {
      return res.json({ summary: cached.rows[0].summary_data, generated_at: cached.rows[0].generated_at, cached: true });
    }
    const summary = await generateAndStore(locationId, weekStartQ, weekEnd);
    res.json({ summary, generated_at: new Date().toISOString(), cached: false });
  } catch (err) {
    logger.log('weekly', 'error', null, 'weekly-summary failed', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

router.get('/weekly-summaries/history', async (req, res) => {
  try {
    const { locationId, limit = 12 } = req.query;
    if (!locationId) return res.status(400).json({ error: 'locationId required' });
    const q = await db.query(
      `SELECT week_start, week_end, summary_data, generated_at
       FROM weekly_summaries WHERE location_id = $1
       ORDER BY week_start DESC LIMIT $2`,
      [locationId, Math.min(parseInt(limit, 10) || 12, 52)]
    );
    res.json({ history: q.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/weekly-summary/generate-all', async (req, res) => {
  try {
    const subsQ = await db.query(`SELECT ghl_location_id, name FROM subaccounts WHERE status = 'active' OR status IS NULL`);
    const weekStart = req.body?.week_start ? new Date(req.body.week_start) : startOfWeek(new Date(Date.now() - 7 * 86400000));
    weekStart.setUTCHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart.getTime() + 7 * 86400000);
    const results = [];
    for (const s of subsQ.rows) {
      try {
        const summary = await generateAndStore(s.ghl_location_id, weekStart, weekEnd);
        results.push({ location_id: s.ghl_location_id, name: s.name, ok: true, total: summary.total_conversations, booked: summary.appointments_booked });
      } catch (err) {
        results.push({ location_id: s.ghl_location_id, name: s.name, ok: false, error: err.message });
      }
    }
    logger.log('weekly', 'info', null, 'Generated all summaries', { count: results.length });
    res.json({ week_start: weekStart.toISOString().slice(0, 10), results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, generateAndStore, startOfWeek };
