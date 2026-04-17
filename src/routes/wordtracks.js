const express = require('express');
const db = require('../db');
const wtClusters = require('../services/wordTrackClusters');
const router = express.Router();

const NEGATIVE_RE = /\b(stop|unsubscribe|remove me|fuck|shit|damn|bitch|leave me alone|take me off|not interested|fuck off|asshole|pissed)\b/i;
const OPTOUT_OUTCOMES = ['dnc', 'opted_out', 'opt_out', 'stop_requested'];
const BOOKED_OUTCOMES = ['appointment_booked', 'fex_immediate', 'mp_immediate'];

async function getAttributionWindowDays() {
  try {
    const q = await db.query(`SELECT value FROM app_settings WHERE section = 'wordtracks' AND key = 'attribution_window_days'`);
    return parseInt(q.rows[0]?.value, 10) || 7;
  } catch {
    return 7;
  }
}

function buildSourceFilter(source) {
  const s = String(source || 'all').toLowerCase();
  if (s === 'claude') return `AND gc.source = 'claude'`;
  if (s === 'botpress') return `AND gc.source = 'botpress'`;
  if (s === 'other') return `AND gc.source = 'other'`;
  return '';
}

/**
 * Main cluster stats endpoint. Attribution is temporal: for each outbound
 * cluster message we look ahead in the same ghl_conversation within the
 * attribution window for the very next inbound message. The cluster gets
 * credited with that reply's time + the conversation's terminal outcome
 * (booking / opt-out) only if the credited outbound is the LAST outbound
 * before the outcome.
 */
router.get('/wordtracks/clusters', async (req, res) => {
  try {
    const { location_id, location_ids, source = 'all', days = 30, window_days } = req.query;
    const daysInt = parseInt(days, 10) || 30;
    const winDays = parseInt(window_days, 10) || (await getAttributionWindowDays());
    const locIds = location_ids ? location_ids.split(',').map((s) => s.trim()).filter(Boolean) : (location_id ? [location_id] : []);

    const params = [daysInt, winDays];
    let locFilter = '';
    if (locIds.length) {
      params.push(locIds);
      locFilter = ` AND m.location_id = ANY($${params.length})`;
    }
    const sourceFilter = buildSourceFilter(source);

    // Per-cluster metrics.
    //  - sends: count of outbound cluster messages in window
    //  - replies: count of those that have a next-inbound within the
    //    attribution window and are the most recent outbound before it
    //  - bookings / opt-outs: count of conversations whose terminal outcome
    //    matches, where THIS cluster message is the most recent outbound
    //    before the conversation's last inbound (i.e. credited cluster)
    //  - drop-offs: outbound sends with no next-inbound within window
    const sql = `
      WITH outbounds AS (
        SELECT
          m.id AS msg_id,
          m.cluster_id,
          m.ghl_conversation_id,
          m.location_id,
          m.created_at,
          gc.terminal_outcome,
          gc.source
        FROM ghl_messages m
        JOIN ghl_conversations gc ON gc.ghl_conversation_id = m.ghl_conversation_id AND gc.location_id = m.location_id
        WHERE m.direction = 'outbound'
          AND m.cluster_id IS NOT NULL
          AND m.created_at >= NOW() - ($1 || ' days')::interval
          ${sourceFilter}
          ${locFilter}
      ),
      next_inbound AS (
        SELECT
          o.msg_id,
          o.cluster_id,
          o.ghl_conversation_id,
          o.location_id,
          o.created_at AS out_at,
          o.terminal_outcome,
          (SELECT MIN(created_at) FROM ghl_messages im
             WHERE im.ghl_conversation_id = o.ghl_conversation_id
               AND im.location_id = o.location_id
               AND im.direction = 'inbound'
               AND im.created_at > o.created_at
               AND im.created_at <= o.created_at + ($2 || ' days')::interval) AS in_at
        FROM outbounds o
      ),
      -- For each ghl_conversation, identify the single outbound cluster message
      -- immediately preceding the conversation's terminal outcome (i.e. the
      -- "credited" outbound for booking / opt-out attribution).
      credited AS (
        SELECT DISTINCT ON (o.ghl_conversation_id, o.location_id)
               o.ghl_conversation_id, o.location_id, o.cluster_id, o.terminal_outcome
          FROM outbounds o
        ORDER BY o.ghl_conversation_id, o.location_id, o.created_at DESC
      ),
      per_cluster AS (
        SELECT
          ni.cluster_id,
          COUNT(*)::int AS sends,
          COUNT(*) FILTER (WHERE ni.in_at IS NOT NULL)::int AS replies,
          COALESCE(AVG(EXTRACT(EPOCH FROM (ni.in_at - ni.out_at))) FILTER (WHERE ni.in_at IS NOT NULL), 0)::float AS avg_reply_seconds,
          COUNT(*) FILTER (WHERE ni.in_at IS NULL)::int AS drop_offs,
          COUNT(DISTINCT ni.ghl_conversation_id)::int AS unique_convs
        FROM next_inbound ni
        GROUP BY ni.cluster_id
      ),
      credit_totals AS (
        SELECT
          cluster_id,
          COUNT(*) FILTER (WHERE terminal_outcome = ANY($3))::int AS bookings,
          COUNT(*) FILTER (WHERE terminal_outcome = ANY($4))::int AS opt_outs
        FROM credited
        GROUP BY cluster_id
      )
      SELECT wc.id, wc.label, wc.description, wc.source, wc.example_text, wc.cluster_size,
             COALESCE(pc.sends, 0) AS sends,
             COALESCE(pc.replies, 0) AS replies,
             COALESCE(pc.avg_reply_seconds, 0) AS avg_reply_seconds,
             COALESCE(pc.drop_offs, 0) AS drop_offs,
             COALESCE(pc.unique_convs, 0) AS unique_convs,
             COALESCE(ct.bookings, 0) AS bookings,
             COALESCE(ct.opt_outs, 0) AS opt_outs
        FROM word_track_clusters wc
        LEFT JOIN per_cluster pc ON pc.cluster_id = wc.id
        LEFT JOIN credit_totals ct ON ct.cluster_id = wc.id
       WHERE COALESCE(pc.sends, 0) > 0 OR COALESCE(ct.bookings, 0) > 0 OR COALESCE(ct.opt_outs, 0) > 0
       ORDER BY sends DESC, wc.cluster_size DESC
    `;
    params.push(BOOKED_OUTCOMES, OPTOUT_OUTCOMES);
    const result = await db.query(sql, params);

    const clusters = result.rows.map((r) => {
      const sends = Number(r.sends) || 0;
      const replies = Number(r.replies) || 0;
      const uniqueConvs = Number(r.unique_convs) || 0;
      const bookings = Number(r.bookings) || 0;
      const optOuts = Number(r.opt_outs) || 0;
      const dropOffs = Number(r.drop_offs) || 0;
      return {
        id: r.id,
        label: r.label,
        description: r.description,
        source: r.source,
        example_text: r.example_text,
        cluster_size: Number(r.cluster_size) || 0,
        sends,
        replies,
        reply_rate: sends ? replies / sends : 0,
        avg_reply_seconds: Number(r.avg_reply_seconds) || 0,
        drop_offs: dropOffs,
        drop_off_rate: sends ? dropOffs / sends : 0,
        unique_conversations: uniqueConvs,
        bookings,
        booking_rate: uniqueConvs ? bookings / uniqueConvs : 0,
        opt_outs: optOuts,
        opt_out_rate: uniqueConvs ? optOuts / uniqueConvs : 0
      };
    });

    res.json({ source, days: daysInt, attribution_window_days: winDays, clusters });
  } catch (err) {
    console.error('[wordtracks/clusters] error', err);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Single-cluster detail: sample outbound + the inbound reply (if any)
// within the attribution window for each sample.
router.get('/wordtracks/cluster/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { days = 30, window_days, limit = 30 } = req.query;
    const daysInt = parseInt(days, 10) || 30;
    const winDays = parseInt(window_days, 10) || (await getAttributionWindowDays());
    const lim = Math.min(parseInt(limit, 10) || 30, 200);

    const cluster = (await db.query(
      `SELECT id, label, description, source, example_text, cluster_size, first_seen_at, last_seen_at
         FROM word_track_clusters WHERE id = $1`,
      [id]
    )).rows[0];
    if (!cluster) return res.status(404).json({ error: 'not found' });

    const samples = await db.query(
      `SELECT m.id AS msg_id, m.ghl_conversation_id, m.location_id, m.content, m.created_at,
              gc.contact_name, gc.contact_phone, gc.source, gc.terminal_outcome,
              (SELECT content FROM ghl_messages im
                 WHERE im.ghl_conversation_id = m.ghl_conversation_id
                   AND im.location_id = m.location_id
                   AND im.direction = 'inbound'
                   AND im.created_at > m.created_at
                   AND im.created_at <= m.created_at + ($2 || ' days')::interval
                 ORDER BY im.created_at ASC LIMIT 1) AS reply_content,
              (SELECT EXTRACT(EPOCH FROM (im.created_at - m.created_at))::int FROM ghl_messages im
                 WHERE im.ghl_conversation_id = m.ghl_conversation_id
                   AND im.location_id = m.location_id
                   AND im.direction = 'inbound'
                   AND im.created_at > m.created_at
                   AND im.created_at <= m.created_at + ($2 || ' days')::interval
                 ORDER BY im.created_at ASC LIMIT 1) AS reply_seconds
         FROM ghl_messages m
         JOIN ghl_conversations gc ON gc.ghl_conversation_id = m.ghl_conversation_id AND gc.location_id = m.location_id
        WHERE m.cluster_id = $1
          AND m.direction = 'outbound'
          AND m.created_at >= NOW() - ($3 || ' days')::interval
        ORDER BY m.created_at DESC
        LIMIT $4`,
      [id, winDays, daysInt, lim]
    );

    const samplesOut = samples.rows.map((r) => ({
      message_id: r.msg_id,
      ghl_conversation_id: r.ghl_conversation_id,
      location_id: r.location_id,
      source: r.source,
      terminal_outcome: r.terminal_outcome,
      contact_name: r.contact_name,
      contact_phone: r.contact_phone,
      content: r.content,
      created_at: r.created_at,
      reply_content: r.reply_content,
      reply_seconds: r.reply_seconds,
      negative_flag: r.reply_content ? NEGATIVE_RE.test(r.reply_content) : false
    }));

    res.json({ cluster, attribution_window_days: winDays, samples: samplesOut });
  } catch (err) {
    console.error('[wordtracks/cluster/:id] error', err);
    res.status(500).json({ error: err.message });
  }
});

// Rename/re-label a cluster manually.
router.patch('/wordtracks/cluster/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { label, description } = req.body || {};
    if (!label && !description) return res.status(400).json({ error: 'label or description required' });
    await db.query(
      `UPDATE word_track_clusters
          SET label = COALESCE($1, label),
              description = COALESCE($2, description),
              updated_at = NOW()
        WHERE id = $3`,
      [label || null, description || null, id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger a clustering run manually from the UI (admin-only via role guard).
router.post('/wordtracks/recluster', async (req, res) => {
  try {
    const opts = req.body || {};
    const out = await wtClusters.runFullPipeline(opts);
    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

module.exports = router;
