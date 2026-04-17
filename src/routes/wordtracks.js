const express = require('express');
const db = require('../db');
const wtClusters = require('../services/wordTrackClusters');
const jobs = require('../services/jobs');
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

// ────────────────────────────────────────────────────────────────────────
// TOP LEVEL: list workflows with aggregate stats.
// ────────────────────────────────────────────────────────────────────────

router.get('/wordtracks/workflows', async (req, res) => {
  try {
    const daysInt = parseInt(req.query.days, 10) || 30;
    const winDays = parseInt(req.query.window_days, 10) || (await getAttributionWindowDays());

    const q = await db.query(
      `WITH scoped_msgs AS (
         SELECT m.id AS msg_id, m.ghl_conversation_id, m.location_id,
                m.created_at, m.cluster_id,
                wtc.workflow_cluster_id
           FROM ghl_messages m
           JOIN word_track_clusters wtc ON wtc.id = m.cluster_id
          WHERE m.direction = 'outbound'
            AND m.created_at >= NOW() - ($1 || ' days')::interval
       ),
       per_msg AS (
         SELECT sm.workflow_cluster_id,
                sm.msg_id,
                sm.ghl_conversation_id,
                sm.location_id,
                sm.created_at AS out_at,
                (SELECT MIN(created_at) FROM ghl_messages im
                   WHERE im.ghl_conversation_id = sm.ghl_conversation_id
                     AND im.location_id = sm.location_id
                     AND im.direction = 'inbound'
                     AND im.created_at > sm.created_at
                     AND im.created_at <= sm.created_at + ($2 || ' days')::interval) AS in_at,
                gc.terminal_outcome
           FROM scoped_msgs sm
           LEFT JOIN ghl_conversations gc
             ON gc.ghl_conversation_id = sm.ghl_conversation_id AND gc.location_id = sm.location_id
       ),
       last_out_per_conv AS (
         SELECT DISTINCT ON (sm.ghl_conversation_id, sm.location_id)
                sm.workflow_cluster_id, sm.ghl_conversation_id, sm.location_id,
                pm.terminal_outcome
           FROM scoped_msgs sm
           JOIN per_msg pm USING (msg_id)
          ORDER BY sm.ghl_conversation_id, sm.location_id, sm.created_at DESC
       )
       SELECT wf.id, wf.label, wf.description, wf.conversation_count, wf.labeled_at, wf.example_opener,
              COALESCE(m.sends, 0) AS sends,
              COALESCE(m.replies, 0) AS replies,
              COALESCE(m.avg_reply_seconds, 0) AS avg_reply_seconds,
              COALESCE(m.drop_offs, 0) AS drop_offs,
              COALESCE(m.unique_convs, 0) AS unique_convs,
              COALESCE(c.bookings, 0) AS bookings,
              COALESCE(c.opt_outs, 0) AS opt_outs
         FROM workflow_clusters wf
         LEFT JOIN (
           SELECT workflow_cluster_id,
                  COUNT(*)::int AS sends,
                  COUNT(*) FILTER (WHERE in_at IS NOT NULL)::int AS replies,
                  COALESCE(AVG(EXTRACT(EPOCH FROM (in_at - out_at))) FILTER (WHERE in_at IS NOT NULL), 0)::float AS avg_reply_seconds,
                  COUNT(*) FILTER (WHERE in_at IS NULL)::int AS drop_offs,
                  COUNT(DISTINCT ghl_conversation_id)::int AS unique_convs
             FROM per_msg GROUP BY workflow_cluster_id
         ) m ON m.workflow_cluster_id = wf.id
         LEFT JOIN (
           SELECT workflow_cluster_id,
                  COUNT(*) FILTER (WHERE terminal_outcome = ANY($3))::int AS bookings,
                  COUNT(*) FILTER (WHERE terminal_outcome = ANY($4))::int AS opt_outs
             FROM last_out_per_conv GROUP BY workflow_cluster_id
         ) c ON c.workflow_cluster_id = wf.id
        ORDER BY sends DESC, wf.conversation_count DESC`,
      [daysInt, winDays, BOOKED_OUTCOMES, OPTOUT_OUTCOMES]
    );

    const workflows = q.rows.map((r) => {
      const sends = Number(r.sends) || 0;
      const replies = Number(r.replies) || 0;
      const uniqueConvs = Number(r.unique_convs) || 0;
      return {
        id: r.id,
        label: r.label,
        description: r.description,
        example_opener: r.example_opener,
        conversation_count: Number(r.conversation_count) || 0,
        labeled: !!r.labeled_at,
        sends,
        replies,
        reply_rate: sends ? replies / sends : 0,
        avg_reply_seconds: Number(r.avg_reply_seconds) || 0,
        drop_offs: Number(r.drop_offs) || 0,
        drop_off_rate: sends ? (Number(r.drop_offs) || 0) / sends : 0,
        unique_conversations: uniqueConvs,
        bookings: Number(r.bookings) || 0,
        booking_rate: uniqueConvs ? (Number(r.bookings) || 0) / uniqueConvs : 0,
        opt_outs: Number(r.opt_outs) || 0,
        opt_out_rate: uniqueConvs ? (Number(r.opt_outs) || 0) / uniqueConvs : 0
      };
    });

    res.json({ days: daysInt, attribution_window_days: winDays, workflows });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// ────────────────────────────────────────────────────────────────────────
// DRILL-DOWN: for a specific workflow, per-position cluster breakdown.
// ────────────────────────────────────────────────────────────────────────

router.get('/wordtracks/workflow/:id', async (req, res) => {
  try {
    const wfId = parseInt(req.params.id, 10);
    const daysInt = parseInt(req.query.days, 10) || 30;
    const winDays = parseInt(req.query.window_days, 10) || (await getAttributionWindowDays());

    const wfQ = await db.query(
      `SELECT id, label, description, conversation_count, example_opener, labeled_at
         FROM workflow_clusters WHERE id = $1`,
      [wfId]
    );
    const workflow = wfQ.rows[0];
    if (!workflow) return res.status(404).json({ error: 'workflow not found' });

    const clustersQ = await db.query(
      `WITH scoped AS (
         SELECT m.id AS msg_id, m.ghl_conversation_id, m.location_id,
                m.created_at, m.cluster_id,
                wtc.position
           FROM ghl_messages m
           JOIN word_track_clusters wtc ON wtc.id = m.cluster_id
          WHERE wtc.workflow_cluster_id = $1
            AND m.direction = 'outbound'
            AND m.created_at >= NOW() - ($2 || ' days')::interval
       ),
       next_inbound AS (
         SELECT s.cluster_id, s.ghl_conversation_id, s.location_id, s.created_at AS out_at,
                (SELECT MIN(created_at) FROM ghl_messages im
                   WHERE im.ghl_conversation_id = s.ghl_conversation_id
                     AND im.location_id = s.location_id
                     AND im.direction = 'inbound'
                     AND im.created_at > s.created_at
                     AND im.created_at <= s.created_at + ($3 || ' days')::interval) AS in_at
           FROM scoped s
       ),
       credited AS (
         SELECT DISTINCT ON (s.ghl_conversation_id, s.location_id)
                s.cluster_id, s.ghl_conversation_id, s.location_id,
                gc.terminal_outcome
           FROM scoped s
           LEFT JOIN ghl_conversations gc
             ON gc.ghl_conversation_id = s.ghl_conversation_id AND gc.location_id = s.location_id
          ORDER BY s.ghl_conversation_id, s.location_id, s.created_at DESC
       )
       SELECT wtc.id, wtc.label, wtc.description, wtc.example_text, wtc.position, wtc.cluster_size, wtc.labeled_at,
              COALESCE(m.sends, 0) AS sends,
              COALESCE(m.replies, 0) AS replies,
              COALESCE(m.avg_reply_seconds, 0) AS avg_reply_seconds,
              COALESCE(m.drop_offs, 0) AS drop_offs,
              COALESCE(m.unique_convs, 0) AS unique_convs,
              COALESCE(c.bookings, 0) AS bookings,
              COALESCE(c.opt_outs, 0) AS opt_outs
         FROM word_track_clusters wtc
         LEFT JOIN (
           SELECT cluster_id,
                  COUNT(*)::int AS sends,
                  COUNT(*) FILTER (WHERE in_at IS NOT NULL)::int AS replies,
                  COALESCE(AVG(EXTRACT(EPOCH FROM (in_at - out_at))) FILTER (WHERE in_at IS NOT NULL), 0)::float AS avg_reply_seconds,
                  COUNT(*) FILTER (WHERE in_at IS NULL)::int AS drop_offs,
                  COUNT(DISTINCT ghl_conversation_id)::int AS unique_convs
             FROM next_inbound GROUP BY cluster_id
         ) m ON m.cluster_id = wtc.id
         LEFT JOIN (
           SELECT cluster_id,
                  COUNT(*) FILTER (WHERE terminal_outcome = ANY($4))::int AS bookings,
                  COUNT(*) FILTER (WHERE terminal_outcome = ANY($5))::int AS opt_outs
             FROM credited GROUP BY cluster_id
         ) c ON c.cluster_id = wtc.id
        WHERE wtc.workflow_cluster_id = $1
        ORDER BY wtc.position ASC, sends DESC`,
      [wfId, daysInt, winDays, BOOKED_OUTCOMES, OPTOUT_OUTCOMES]
    );

    const byPosition = new Map();
    for (const r of clustersQ.rows) {
      if (!byPosition.has(r.position)) byPosition.set(r.position, []);
      const sends = Number(r.sends) || 0;
      const replies = Number(r.replies) || 0;
      const uniqueConvs = Number(r.unique_convs) || 0;
      byPosition.get(r.position).push({
        id: r.id,
        label: r.label,
        description: r.description,
        example_text: r.example_text,
        cluster_size: Number(r.cluster_size) || 0,
        position: r.position,
        labeled: !!r.labeled_at,
        sends,
        replies,
        reply_rate: sends ? replies / sends : 0,
        avg_reply_seconds: Number(r.avg_reply_seconds) || 0,
        drop_offs: Number(r.drop_offs) || 0,
        drop_off_rate: sends ? (Number(r.drop_offs) || 0) / sends : 0,
        unique_conversations: uniqueConvs,
        bookings: Number(r.bookings) || 0,
        booking_rate: uniqueConvs ? (Number(r.bookings) || 0) / uniqueConvs : 0,
        opt_outs: Number(r.opt_outs) || 0,
        opt_out_rate: uniqueConvs ? (Number(r.opt_outs) || 0) / uniqueConvs : 0
      });
    }
    const positions = Array.from(byPosition.keys()).sort((a, b) => a - b).map((pos) => ({
      position: pos,
      clusters: byPosition.get(pos)
    }));

    res.json({ workflow, attribution_window_days: winDays, positions });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// ────────────────────────────────────────────────────────────────────────
// CLUSTER DETAIL: all sends of a single (workflow, position, cluster).
// ────────────────────────────────────────────────────────────────────────

router.get('/wordtracks/cluster/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { days = 30, window_days, limit = 30 } = req.query;
    const daysInt = parseInt(days, 10) || 30;
    const winDays = parseInt(window_days, 10) || (await getAttributionWindowDays());
    const lim = Math.min(parseInt(limit, 10) || 30, 200);

    const cluster = (await db.query(
      `SELECT wtc.*, wf.label AS workflow_label, wf.id AS workflow_id
         FROM word_track_clusters wtc
         LEFT JOIN workflow_clusters wf ON wf.id = wtc.workflow_cluster_id
        WHERE wtc.id = $1`,
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

    res.json({
      cluster,
      attribution_window_days: winDays,
      samples: samples.rows.map((r) => ({
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
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rename/re-label manually.
router.patch('/wordtracks/cluster/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { label, description } = req.body || {};
    if (!label && !description) return res.status(400).json({ error: 'label or description required' });
    await db.query(
      `UPDATE word_track_clusters SET label = COALESCE($1, label), description = COALESCE($2, description), updated_at = NOW() WHERE id = $3`,
      [label || null, description || null, id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/wordtracks/workflow/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { label, description } = req.body || {};
    if (!label && !description) return res.status(400).json({ error: 'label or description required' });
    await db.query(
      `UPDATE workflow_clusters SET label = COALESCE($1, label), description = COALESCE($2, description), updated_at = NOW() WHERE id = $3`,
      [label || null, description || null, id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ────────────────────────────────────────────────────────────────────────
// Trigger a full two-layer rebuild. Returns a job ID for polling.
// ────────────────────────────────────────────────────────────────────────

router.post('/wordtracks/recluster', async (req, res) => {
  try {
    const jobId = await jobs.createJob({
      type: 'word_track_recluster',
      startedBy: req.session?.username || null
    });
    jobs.spawn(jobId, async (reporter) => {
      return await wtClusters.runFullPipeline({ reporter });
    });
    res.json({ ok: true, jobId });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Diagnostic (same as before, expanded for two-layer state).
// ────────────────────────────────────────────────────────────────────────

router.get('/wordtracks/diag', async (req, res) => {
  try {
    const diag = {};
    const tblQ = await db.query(
      `SELECT to_regclass('word_track_clusters') AS wtc,
              to_regclass('workflow_clusters') AS wfc,
              to_regclass('conversation_workflow_assignment') AS cwa,
              to_regclass('ghl_messages') AS m,
              to_regclass('anthropic_usage_log') AS a`
    );
    diag.tables = {
      word_track_clusters: !!tblQ.rows[0]?.wtc,
      workflow_clusters: !!tblQ.rows[0]?.wfc,
      conversation_workflow_assignment: !!tblQ.rows[0]?.cwa,
      ghl_messages: !!tblQ.rows[0]?.m,
      anthropic_usage_log: !!tblQ.rows[0]?.a
    };
    if (!diag.tables.workflow_clusters) {
      return res.json({ ok: false, reason: 'workflow_clusters table missing — boot migration did not run. Redeploy.', diag });
    }
    const countsQ = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM ghl_messages WHERE direction = 'outbound') AS total_outbound,
         (SELECT COUNT(*) FROM workflow_clusters) AS workflows_total,
         (SELECT COUNT(*) FROM workflow_clusters WHERE labeled_at IS NOT NULL) AS workflows_labeled,
         (SELECT COUNT(*) FROM word_track_clusters WHERE workflow_cluster_id IS NOT NULL) AS word_tracks_total,
         (SELECT COUNT(*) FROM word_track_clusters WHERE workflow_cluster_id IS NOT NULL AND labeled_at IS NOT NULL) AS word_tracks_labeled,
         (SELECT COUNT(*) FROM conversation_workflow_assignment) AS conversations_assigned,
         (SELECT COUNT(*) FROM ghl_messages WHERE cluster_id IS NOT NULL) AS messages_attached`
    );
    diag.counts = {};
    for (const [k, v] of Object.entries(countsQ.rows[0] || {})) diag.counts[k] = Number(v) || 0;

    let hint = null;
    if (diag.counts.total_outbound === 0) {
      hint = 'No outbound messages in ghl_messages. Run a GHL pull from the Analyzer tab first.';
    } else if (diag.counts.workflows_total === 0) {
      hint = 'No workflows clustered yet. Click "Recluster now" on the WordTracks tab.';
    } else if (diag.counts.conversations_assigned === 0) {
      hint = 'Workflows exist but no conversations are mapped — pipeline may have errored mid-run.';
    } else if (diag.counts.workflows_labeled === 0) {
      hint = 'Workflows exist but no labels. Check anthropic_usage_log for word_track_clustering errors.';
    }
    res.json({ ok: true, diag, hint });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

module.exports = router;
