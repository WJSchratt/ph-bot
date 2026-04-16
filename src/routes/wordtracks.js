const express = require('express');
const db = require('../db');
const router = express.Router();

// Legacy wordtracks endpoint (kept for backwards compat with old UI calls).
router.get('/wordtracks', async (req, res) => {
  try {
    const { location_id, location_ids, days = 30, sort_by = 'total_sent', sort_dir = 'desc' } = req.query;
    const params = [];
    const filters = [`m.direction = 'outbound'`];
    params.push(parseInt(days, 10) || 30);
    filters.push(`m.created_at >= NOW() - ($${params.length} || ' days')::interval`);
    const locIds = location_ids ? location_ids.split(',').map(s => s.trim()).filter(Boolean) : (location_id ? [location_id] : []);
    if (locIds.length) { params.push(locIds); filters.push(`m.location_id = ANY($${params.length})`); }
    const where = `WHERE ${filters.join(' AND ')}`;

    const allowedSorts = ['total_sent', 'replies', 'reply_rate', 'opt_outs', 'opt_out_rate', 'bookings', 'booking_rate', 'avg_reply_time'];
    const sortCol = allowedSorts.includes(sort_by) ? sort_by : 'total_sent';
    const dir = sort_dir === 'asc' ? 'ASC' : 'DESC';

    const result = await db.query(
      `SELECT
         COALESCE(m.message_type, 'unknown') AS message_type,
         COUNT(*)::int AS total_sent,
         COUNT(*) FILTER (WHERE m.got_reply)::int AS replies,
         (COUNT(*) FILTER (WHERE m.got_reply)::float / NULLIF(COUNT(*), 0)) AS reply_rate,
         AVG(m.reply_time_seconds) FILTER (WHERE m.got_reply)::float AS avg_reply_time,
         COUNT(DISTINCT CASE WHEN c.terminal_outcome = 'dnc' THEN m.conversation_id END)::int AS opt_outs,
         (COUNT(DISTINCT CASE WHEN c.terminal_outcome = 'dnc' THEN m.conversation_id END)::float / NULLIF(COUNT(DISTINCT m.conversation_id), 0)) AS opt_out_rate,
         COUNT(DISTINCT CASE WHEN c.terminal_outcome = 'appointment_booked' THEN m.conversation_id END)::int AS bookings,
         (COUNT(DISTINCT CASE WHEN c.terminal_outcome = 'appointment_booked' THEN m.conversation_id END)::float / NULLIF(COUNT(DISTINCT m.conversation_id), 0)) AS booking_rate,
         COUNT(DISTINCT CASE WHEN c.terminal_outcome = 'human_handoff' THEN m.conversation_id END)::int AS transfers,
         (COUNT(DISTINCT CASE WHEN c.terminal_outcome = 'human_handoff' THEN m.conversation_id END)::float / NULLIF(COUNT(DISTINCT m.conversation_id), 0)) AS transfer_rate,
         COUNT(DISTINCT m.conversation_id)::int AS unique_conversations,
         COALESCE(SUM(m.segments), 0)::int AS total_segments
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id AND c.is_sandbox = FALSE
       ${where}
       GROUP BY 1
       ORDER BY ${sortCol} ${dir}`,
      params
    );

    res.json({ wordtracks: result.rows });
  } catch (err) {
    console.error('[wordtracks] error', err);
    res.status(500).json({ error: err.message });
  }
});

// Classify an outbound message body into a stage for BotPress / "other" convos
// where message_type isn't stored. Good-enough keyword heuristics.
function classifyStage(text) {
  if (!text) return 'unknown';
  const t = text.toLowerCase();
  if (/remov.*list|opted? out|take care|do not contact/.test(t)) return 'dnc';
  if (/\b(you're|you are) booked|confirmed for|all set|rescheduled for/.test(t)) return 'confirmation';
  if (/\b(is there any reason|100%|tie[- ]?down|confirm that you|can you confirm 100)/.test(t)) return 'scheduling';
  if (/\b(got it - looks like|we have \d|which works better|what time works|time tomorrow|over the next 24|book an appointment|set up an appointment|sometime over the next)/.test(t)) return 'scheduling';
  if (/\b(not a problem|not the first to say|what we could do|unless you think|have our ai|one of our|for sure|certainly|no problem)\b/.test(t) && /\b(expensive|interest|think|spouse|cost|price|already|covered|budget|afford)\b/.test(t)) return 'objection_handling';
  if (/\b(how old|dob|birthday|smoker|chain[- ]?smok|health conditions|high blood pressure|diabetes|heart issues|cancer|how much coverage|loved ones|yourself, or)\b/.test(t)) return 'qualification';
  if (/\b(just (sarah|frank|[a-z]+) here|hey \w+,? just|apologies for the confusion|appreciate you reaching out|was that for yourself|was that coverage for)\b/.test(t)) return 'greeting';
  if (/\b(ai voice|opt in|reply yes|reply no|business card|licensing info|enter that into the system)\b/.test(t)) return 'ai_disclosure';
  if (/\bjeremiah will be with you shortly|agent will be with you shortly/.test(t)) return 'post_terminal';
  if (/\b(turning off ai|reach out directly|connect you with)/.test(t)) return 'handoff';
  return 'general';
}

// Main endpoint: per-stage metrics across Claude bot + BotPress (ghl_messages).
router.get('/wordtracks/stages', async (req, res) => {
  try {
    const { location_ids, location_id, bot_type = 'combined', days = 30 } = req.query;
    const locIds = location_ids ? location_ids.split(',').map((s) => s.trim()).filter(Boolean) : (location_id ? [location_id] : []);
    const daysInt = parseInt(days, 10) || 30;
    const filter = String(bot_type).toLowerCase();

    const stages = {};
    const bumpStage = (name, field, inc) => {
      if (!stages[name]) stages[name] = { stage: name, total_sent: 0, replies: 0, avg_reply_time_sum: 0, avg_reply_time_count: 0, booked_convs: new Set(), dnc_convs: new Set(), dropoff_convs: new Set(), convs: new Set() };
      stages[name][field] = (stages[name][field] || 0) + (inc || 1);
    };

    // --- Claude bot (local messages + conversations) ---
    if (filter === 'claude' || filter === 'combined') {
      const params = [daysInt];
      let where = `m.direction = 'outbound' AND m.created_at >= NOW() - ($1 || ' days')::interval AND c.is_sandbox = FALSE`;
      if (locIds.length) { params.push(locIds); where += ` AND m.location_id = ANY($${params.length})`; }
      const q = await db.query(
        `SELECT
           COALESCE(NULLIF(m.message_type, ''), 'unknown') AS stage,
           COUNT(*)::int AS total_sent,
           COUNT(*) FILTER (WHERE m.got_reply)::int AS replies,
           COALESCE(AVG(m.reply_time_seconds) FILTER (WHERE m.got_reply), 0)::float AS avg_reply_time,
           COUNT(DISTINCT m.conversation_id)::int AS unique_convs,
           COUNT(DISTINCT CASE WHEN c.terminal_outcome = 'appointment_booked' THEN m.conversation_id END)::int AS booked,
           COUNT(DISTINCT CASE WHEN c.terminal_outcome IN ('dnc','opted_out','opt_out','stop_requested') THEN m.conversation_id END)::int AS dnc,
           COUNT(DISTINCT CASE WHEN c.terminal_outcome IS NULL AND NOT m.got_reply THEN m.conversation_id END)::int AS dropoff
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE ${where}
         GROUP BY 1`,
        params
      );
      for (const r of q.rows) {
        const s = r.stage || 'unknown';
        if (!stages[s]) stages[s] = { stage: s, total_sent: 0, replies: 0, avg_reply_time_sum: 0, avg_reply_time_count: 0, unique_convs: 0, booked: 0, dnc: 0, dropoff: 0 };
        stages[s].total_sent += r.total_sent;
        stages[s].replies += r.replies;
        if (r.avg_reply_time) {
          stages[s].avg_reply_time_sum += r.avg_reply_time * r.replies;
          stages[s].avg_reply_time_count += r.replies;
        }
        stages[s].unique_convs += r.unique_convs;
        stages[s].booked += r.booked;
        stages[s].dnc += r.dnc;
        stages[s].dropoff += r.dropoff;
      }
    }

    // --- BotPress / other (ghl_messages + ghl_conversations) ---
    if (filter === 'botpress' || filter === 'combined') {
      const params = [daysInt];
      let where = `m.direction = 'outbound' AND m.created_at >= NOW() - ($1 || ' days')::interval`;
      if (filter === 'botpress') where += ` AND gc.source = 'botpress'`;
      if (locIds.length) { params.push(locIds); where += ` AND m.location_id = ANY($${params.length})`; }
      const q = await db.query(
        `SELECT m.content, m.ghl_conversation_id, m.location_id, gc.terminal_outcome, gc.message_count
         FROM ghl_messages m
         JOIN ghl_conversations gc ON gc.ghl_conversation_id = m.ghl_conversation_id AND gc.location_id = m.location_id
         WHERE ${where}
         LIMIT 30000`,
        params
      );
      const perStage = {};
      for (const row of q.rows) {
        const stage = classifyStage(row.content);
        if (!perStage[stage]) perStage[stage] = { total: 0, convs: new Set(), booked: new Set(), dnc: new Set(), replies: 0 };
        perStage[stage].total++;
        perStage[stage].convs.add(row.ghl_conversation_id);
        if (row.terminal_outcome === 'appointment_booked') perStage[stage].booked.add(row.ghl_conversation_id);
        if (['dnc', 'opted_out', 'opt_out', 'stop_requested'].includes(row.terminal_outcome)) perStage[stage].dnc.add(row.ghl_conversation_id);
      }
      for (const [stage, d] of Object.entries(perStage)) {
        if (!stages[stage]) stages[stage] = { stage, total_sent: 0, replies: 0, avg_reply_time_sum: 0, avg_reply_time_count: 0, unique_convs: 0, booked: 0, dnc: 0, dropoff: 0 };
        stages[stage].total_sent += d.total;
        stages[stage].unique_convs += d.convs.size;
        stages[stage].booked += d.booked.size;
        stages[stage].dnc += d.dnc.size;
      }
    }

    const list = Object.values(stages).map((s) => {
      const avg = s.avg_reply_time_count ? s.avg_reply_time_sum / s.avg_reply_time_count : null;
      return {
        stage: s.stage,
        total_sent: s.total_sent || 0,
        replies: s.replies || 0,
        reply_rate: s.total_sent ? (s.replies || 0) / s.total_sent : 0,
        avg_reply_time_seconds: avg,
        unique_conversations: s.unique_convs || 0,
        booking_conversion: s.unique_convs ? (s.booked || 0) / s.unique_convs : 0,
        opt_out_rate: s.unique_convs ? (s.dnc || 0) / s.unique_convs : 0,
        drop_off_rate: s.unique_convs ? (s.dropoff || 0) / s.unique_convs : 0,
        booked: s.booked || 0,
        dnc: s.dnc || 0,
        dropoff: s.dropoff || 0
      };
    }).sort((a, b) => b.total_sent - a.total_sent);

    res.json({ bot_type: filter, days: daysInt, stages: list });
  } catch (err) {
    console.error('[wordtracks/stages] error', err);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Detail for a single stage: sample messages + their lead follow-ups.
router.get('/wordtracks/stage/:stage', async (req, res) => {
  try {
    const { stage } = req.params;
    const { bot_type = 'combined', location_ids, days = 30, limit = 25 } = req.query;
    const locIds = location_ids ? location_ids.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const daysInt = parseInt(days, 10) || 30;
    const lim = Math.min(parseInt(limit, 10) || 25, 100);
    const filter = String(bot_type).toLowerCase();

    const out = [];

    if (filter === 'claude' || filter === 'combined') {
      const params = [stage, daysInt];
      let where = `m.direction = 'outbound' AND COALESCE(NULLIF(m.message_type, ''), 'unknown') = $1 AND m.created_at >= NOW() - ($2 || ' days')::interval AND c.is_sandbox = FALSE`;
      if (locIds.length) { params.push(locIds); where += ` AND m.location_id = ANY($${params.length})`; }
      const q = await db.query(
        `SELECT m.id, m.content, m.got_reply, m.reply_time_seconds, m.created_at,
                c.id AS conv_id, c.first_name, c.last_name, c.terminal_outcome, c.location_id
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE ${where}
         ORDER BY m.created_at DESC LIMIT ${lim * 2}`,
        params
      );
      for (const m of q.rows) {
        // Next inbound message on the same conversation
        const follow = await db.query(
          `SELECT content FROM messages WHERE conversation_id = $1 AND direction = 'inbound' AND created_at > $2 ORDER BY created_at ASC LIMIT 1`,
          [m.conv_id, m.created_at]
        );
        const reply = follow.rows[0]?.content || null;
        out.push({
          bot_type: 'claude',
          message_id: m.id,
          conversation_id: m.conv_id,
          content: m.content,
          contact_name: [m.first_name, m.last_name].filter(Boolean).join(' ').trim(),
          terminal_outcome: m.terminal_outcome,
          got_reply: m.got_reply,
          reply_time_seconds: m.reply_time_seconds,
          created_at: m.created_at,
          reply_content: reply,
          negative_flag: reply ? isNegativeReply(reply) : false
        });
        if (out.length >= lim) break;
      }
    }

    if ((filter === 'botpress' || filter === 'combined') && out.length < lim) {
      const params = [daysInt];
      let where = `m.direction = 'outbound' AND m.created_at >= NOW() - ($1 || ' days')::interval AND gc.source = 'botpress'`;
      if (locIds.length) { params.push(locIds); where += ` AND m.location_id = ANY($${params.length})`; }
      const q = await db.query(
        `SELECT m.content, m.ghl_conversation_id, m.location_id, m.created_at,
                gc.terminal_outcome, gc.contact_name
         FROM ghl_messages m
         JOIN ghl_conversations gc ON gc.ghl_conversation_id = m.ghl_conversation_id AND gc.location_id = m.location_id
         WHERE ${where}
         LIMIT ${lim * 4}`,
        params
      );
      for (const m of q.rows) {
        if (classifyStage(m.content) !== stage) continue;
        const follow = await db.query(
          `SELECT content FROM ghl_messages WHERE ghl_conversation_id = $1 AND location_id = $2 AND direction = 'inbound' AND created_at > $3 ORDER BY created_at ASC LIMIT 1`,
          [m.ghl_conversation_id, m.location_id, m.created_at]
        );
        const reply = follow.rows[0]?.content || null;
        out.push({
          bot_type: 'botpress',
          ghl_conversation_id: m.ghl_conversation_id,
          content: m.content,
          contact_name: m.contact_name,
          terminal_outcome: m.terminal_outcome,
          created_at: m.created_at,
          reply_content: reply,
          negative_flag: reply ? isNegativeReply(reply) : false
        });
        if (out.length >= lim) break;
      }
    }

    res.json({ stage, bot_type: filter, samples: out });
  } catch (err) {
    console.error('[wordtracks/stage/:stage] error', err);
    res.status(500).json({ error: err.message });
  }
});

const NEGATIVE_RE = /\b(stop|unsubscribe|remove me|fuck|shit|damn|bitch|leave me alone|take me off|not interested|fuck off|asshole|pissed)\b/i;
function isNegativeReply(text) {
  if (!text) return false;
  return NEGATIVE_RE.test(text);
}

module.exports = router;
