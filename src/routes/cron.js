const express = require('express');
const db = require('../db');
const ghl = require('../services/ghl');
const wtClusters = require('../services/wordTrackClusters');

const router = express.Router();

function requireCronAuth(req, res, next) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return next();
  const provided = req.headers['x-cron-secret'] || req.query.secret;
  if (provided !== secret) return res.status(401).json({ error: 'unauthorized' });
  next();
}

async function syncDirtyFields() {
  const result = await db.query(
    `SELECT * FROM conversations WHERE fields_dirty = TRUE ORDER BY updated_at ASC LIMIT 500`
  );
  const rows = result.rows;
  const outcomes = { total: rows.length, synced: 0, failed: 0, skipped: 0 };
  for (const conv of rows) {
    if (!conv.ghl_token) { outcomes.skipped++; continue; }
    const res = await ghl.updateContactFields(conv.ghl_token, conv.contact_id, conv);
    if (res.ok) {
      await db.query(
        `UPDATE conversations SET fields_dirty = FALSE, last_synced_at = NOW() WHERE id = $1`,
        [conv.id]
      );
      outcomes.synced++;
    } else {
      outcomes.failed++;
    }
    await ghl.sleep(250); // gentle rate-limiting
  }
  return outcomes;
}

async function aggregateAnalytics(targetDate) {
  const dateExpr = targetDate ? `DATE '${targetDate}'` : `CURRENT_DATE - INTERVAL '1 day'`;
  await db.query(
    `INSERT INTO analytics_daily (
       location_id, date, conversations_started, conversations_completed, appointments_booked,
       fex_immediate, mp_immediate, human_handoffs, dnc_count,
       total_inbound_messages, total_outbound_messages,
       avg_messages_per_conversation, avg_response_time_seconds, opt_out_rate
     )
     SELECT
       c.location_id,
       ${dateExpr} AS date,
       COUNT(DISTINCT c.id)::int,
       COUNT(DISTINCT c.id) FILTER (WHERE c.terminal_outcome IS NOT NULL)::int,
       COUNT(DISTINCT c.id) FILTER (WHERE c.terminal_outcome = 'appointment_booked')::int,
       COUNT(DISTINCT c.id) FILTER (WHERE c.terminal_outcome = 'fex_immediate')::int,
       COUNT(DISTINCT c.id) FILTER (WHERE c.terminal_outcome = 'mp_immediate')::int,
       COUNT(DISTINCT c.id) FILTER (WHERE c.terminal_outcome = 'human_handoff')::int,
       COUNT(DISTINCT c.id) FILTER (WHERE c.terminal_outcome = 'dnc')::int,
       (SELECT COUNT(*) FROM messages m WHERE m.location_id = c.location_id AND m.direction = 'inbound' AND m.created_at::date = ${dateExpr})::int,
       (SELECT COUNT(*) FROM messages m WHERE m.location_id = c.location_id AND m.direction = 'outbound' AND m.created_at::date = ${dateExpr})::int,
       (SELECT AVG(cnt) FROM (SELECT COUNT(*)::int AS cnt FROM messages m WHERE m.location_id = c.location_id AND m.created_at::date = ${dateExpr} GROUP BY conversation_id) t),
       (SELECT AVG(reply_time_seconds) FROM messages m WHERE m.location_id = c.location_id AND m.direction = 'outbound' AND m.got_reply AND m.created_at::date = ${dateExpr}),
       (COUNT(DISTINCT c.id) FILTER (WHERE c.terminal_outcome = 'dnc')::float / NULLIF(COUNT(DISTINCT c.id), 0))
     FROM conversations c
     WHERE c.created_at::date = ${dateExpr}
     GROUP BY c.location_id
     ON CONFLICT (location_id, date) DO UPDATE SET
       conversations_started = EXCLUDED.conversations_started,
       conversations_completed = EXCLUDED.conversations_completed,
       appointments_booked = EXCLUDED.appointments_booked,
       fex_immediate = EXCLUDED.fex_immediate,
       mp_immediate = EXCLUDED.mp_immediate,
       human_handoffs = EXCLUDED.human_handoffs,
       dnc_count = EXCLUDED.dnc_count,
       total_inbound_messages = EXCLUDED.total_inbound_messages,
       total_outbound_messages = EXCLUDED.total_outbound_messages,
       avg_messages_per_conversation = EXCLUDED.avg_messages_per_conversation,
       avg_response_time_seconds = EXCLUDED.avg_response_time_seconds,
       opt_out_rate = EXCLUDED.opt_out_rate`
  );
}

router.post('/sync-fields', requireCronAuth, async (req, res) => {
  try {
    const out = await syncDirtyFields();
    res.json({ ok: true, ...out });
  } catch (err) {
    console.error('[cron/sync-fields]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/aggregate-analytics', requireCronAuth, async (req, res) => {
  try {
    await aggregateAnalytics(req.body?.date);
    res.json({ ok: true });
  } catch (err) {
    console.error('[cron/aggregate-analytics]', err);
    res.status(500).json({ error: err.message });
  }
});

// Runs the full word-track clustering pipeline:
//   1. Hash-bucket every unclustered outbound ghl_message (normalize + sha).
//   2. Create/update clusters from buckets of size >= 2.
//   3. Batch-label unlabeled clusters via Claude (category=word_track_clustering).
router.post('/cluster-word-tracks', requireCronAuth, async (req, res) => {
  try {
    const opts = req.body || {};
    const out = await wtClusters.runFullPipeline(opts);
    res.json({ ok: true, ...out });
  } catch (err) {
    console.error('[cron/cluster-word-tracks]', err);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// POST /cron/ghl-full-repull — manual trigger for the daily 7am-ET full repull.
// Useful for testing and as a Railway cron fallback if the setInterval fires
// outside the 1-hour check window. Mirrors the logic in pull-all-locations.
router.post('/ghl-full-repull', requireCronAuth, async (req, res) => {
  try {
    const [convLocs, subLocs] = await Promise.all([
      db.query(`SELECT DISTINCT location_id FROM conversations WHERE ghl_token IS NOT NULL AND ghl_token <> '' AND is_sandbox = FALSE`),
      db.query(`SELECT DISTINCT ghl_location_id AS location_id FROM subaccounts WHERE ghl_api_key IS NOT NULL AND ghl_api_key <> ''`)
    ]);
    const seen = new Set();
    const locationIds = [];
    for (const r of [...convLocs.rows, ...subLocs.rows]) {
      if (!seen.has(r.location_id)) { seen.add(r.location_id); locationIds.push(r.location_id); }
    }

    const jobs = require('../services/jobs');
    const ghlConv = require('../services/ghlConversations');
    const started = [];

    for (const locationId of locationIds) {
      const fromSub = await db.query(`SELECT ghl_api_key FROM subaccounts WHERE ghl_location_id = $1 AND ghl_api_key IS NOT NULL AND ghl_api_key <> '' LIMIT 1`, [locationId]);
      const token = fromSub.rows[0]?.ghl_api_key || (await db.query(`SELECT ghl_token FROM conversations WHERE location_id = $1 AND ghl_token IS NOT NULL AND ghl_token <> '' ORDER BY updated_at DESC LIMIT 1`, [locationId])).rows[0]?.ghl_token;
      if (!token) continue;
      const jobId = await jobs.createJob({ type: 'ghl_full_repull', params: { locationId, fullRepull: true }, startedBy: 'cron/ghl-full-repull' });
      jobs.spawn(jobId, async (reporter) => {
        reporter.report({ message: `Pulling ${locationId}…` });
        const result = await ghlConv.pullAndStore(token, locationId, (p) => {
          reporter.report({ current: p.fetched, message: `pulling: ${p.fetched} fetched` });
        }, { fullRepull: true });
        reporter.report({ message: 'done' });
        return result;
      });
      started.push({ locationId, jobId });
    }

    // Write sync timestamp once all jobs complete
    if (started.length > 0) {
      const batchJobIds = started.map((s) => s.jobId);
      (async () => {
        try {
          while (true) {
            await new Promise((r) => setTimeout(r, 5000));
            const q = await db.query(
              `SELECT COUNT(*) FILTER (WHERE status IN ('queued', 'running'))::int AS pending FROM jobs WHERE id = ANY($1)`,
              [batchJobIds]
            );
            if (!q.rows[0]?.pending) break;
          }
          await db.query(
            `INSERT INTO app_settings (section, key, value) VALUES ('ghl_sync', 'last_full_repull_at', $1)
             ON CONFLICT (section, key) DO UPDATE SET value = EXCLUDED.value`,
            [new Date().toISOString()]
          );
        } catch (e) {
          console.error('[cron/ghl-full-repull] sync timestamp write failed', e.message);
        }
      })();
    }

    res.json({ ok: true, started, location_count: started.length });
  } catch (err) {
    console.error('[cron/ghl-full-repull]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, syncDirtyFields, aggregateAnalytics };
