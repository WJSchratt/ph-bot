const express = require('express');
const db = require('../db');
const ghlPipeline = require('../services/ghlPipeline');
const logger = require('../services/logger');
const router = express.Router();

// --- Legacy endpoint: contact_stage funnel for the bot's own pipeline column ---
router.get('/pipeline', async (req, res) => {
  try {
    const { location_id, location_ids, days = 30 } = req.query;
    const params = [];
    const filters = ['is_sandbox = FALSE'];
    params.push(parseInt(days, 10) || 30);
    filters.push(`created_at >= NOW() - ($${params.length} || ' days')::interval`);
    const locIds = location_ids ? location_ids.split(',').map((s) => s.trim()).filter(Boolean) : (location_id ? [location_id] : []);
    if (locIds.length) { params.push(locIds); filters.push(`location_id = ANY($${params.length})`); }
    const where = `WHERE ${filters.join(' AND ')}`;
    const stageRes = await db.query(
      `SELECT contact_stage, COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE is_active)::int AS active,
              COUNT(*) FILTER (WHERE terminal_outcome = 'appointment_booked')::int AS booked,
              COUNT(*) FILTER (WHERE terminal_outcome = 'fex_immediate')::int AS fex_immediate,
              COUNT(*) FILTER (WHERE terminal_outcome = 'mp_immediate')::int AS mp_immediate,
              COUNT(*) FILTER (WHERE terminal_outcome = 'human_handoff')::int AS handoff,
              COUNT(*) FILTER (WHERE terminal_outcome = 'dnc')::int AS dnc
         FROM conversations ${where}
         GROUP BY contact_stage
         ORDER BY 1`,
      params
    );
    const outcomeRes = await db.query(
      `SELECT COALESCE(terminal_outcome, 'active') AS stage, COUNT(*)::int AS count
         FROM conversations ${where} GROUP BY 1 ORDER BY 2 DESC`,
      params
    );
    res.json({ stages: stageRes.rows, outcomes: outcomeRes.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GHL Pipelines (real opportunity pipelines) ---

const pullProgress = {};

async function findGhlTokenForLocation(locationId) {
  try {
    const fromSub = await db.query(
      `SELECT ghl_api_key FROM subaccounts WHERE ghl_location_id = $1 AND ghl_api_key IS NOT NULL AND ghl_api_key <> ''`,
      [locationId]
    );
    if (fromSub.rows[0]?.ghl_api_key) return fromSub.rows[0].ghl_api_key;
  } catch {}
  try {
    const fromConv = await db.query(
      `SELECT ghl_token FROM conversations
       WHERE location_id = $1 AND ghl_token IS NOT NULL AND ghl_token <> ''
       ORDER BY updated_at DESC LIMIT 1`,
      [locationId]
    );
    if (fromConv.rows[0]?.ghl_token) return fromConv.rows[0].ghl_token;
  } catch {}
  return null;
}

router.post('/pipeline/pull', async (req, res) => {
  try {
    const locationId = req.body?.locationId;
    if (!locationId) return res.status(400).json({ error: 'locationId required' });
    let token = req.body?.ghlToken || null;
    if (!token) token = await findGhlTokenForLocation(locationId);
    if (!token) return res.status(400).json({ error: 'No GHL token found for this location.' });

    if (pullProgress[locationId]?.status === 'pulling') {
      return res.json({ status: 'pulling', locationId, progress: pullProgress[locationId] });
    }
    pullProgress[locationId] = { status: 'pulling', stage: 'starting', fetched: 0, started_at: new Date().toISOString() };

    (async () => {
      try {
        const result = await ghlPipeline.pullAll(token, locationId, (p) => {
          pullProgress[locationId].stage = 'opportunities';
          pullProgress[locationId].fetched = p.fetched;
          pullProgress[locationId].pages = p.page;
        });
        pullProgress[locationId] = {
          status: 'complete',
          stage: 'done',
          pipelines: result.pipelines,
          opportunities: result.opportunities,
          started_at: pullProgress[locationId].started_at,
          completed_at: new Date().toISOString()
        };
      } catch (err) {
        pullProgress[locationId] = {
          ...(pullProgress[locationId] || {}),
          status: 'error',
          error: err.message,
          completed_at: new Date().toISOString()
        };
        logger.log('pipeline', 'error', null, 'Pull job failed', { locationId, error: err.message });
      }
    })();

    res.json({ status: 'pulling', locationId, startedAt: pullProgress[locationId].started_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/pipeline/pull-status', async (req, res) => {
  try {
    const locationId = req.query.locationId;
    if (!locationId) return res.status(400).json({ error: 'locationId required' });
    const progress = pullProgress[locationId] || { status: 'idle' };
    const countsQ = await db.query(
      `SELECT
         (SELECT COUNT(*)::int FROM ghl_pipelines WHERE location_id = $1) AS pipelines,
         (SELECT COUNT(*)::int FROM ghl_opportunities WHERE location_id = $1) AS opportunities,
         (SELECT MAX(pulled_at) FROM ghl_opportunities WHERE location_id = $1) AS last_pulled`,
      [locationId]
    );
    res.json({
      locationId,
      progress,
      counts: countsQ.rows[0],
      last_pulled: countsQ.rows[0]?.last_pulled
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/pipelines/list', async (req, res) => {
  try {
    const locationId = req.query.locationId;
    if (!locationId) return res.status(400).json({ error: 'locationId required' });
    const pipelinesQ = await db.query(
      `SELECT ghl_pipeline_id, name, stages, pulled_at
       FROM ghl_pipelines WHERE location_id = $1
       ORDER BY name`,
      [locationId]
    );
    // Stage counts per pipeline
    const countsQ = await db.query(
      `SELECT pipeline_id, pipeline_stage_id, pipeline_stage_name, COUNT(*)::int AS count,
              COALESCE(SUM(monetary_value), 0)::float AS value
       FROM ghl_opportunities WHERE location_id = $1
       GROUP BY pipeline_id, pipeline_stage_id, pipeline_stage_name`,
      [locationId]
    );
    const byPipeline = {};
    for (const r of countsQ.rows) {
      if (!byPipeline[r.pipeline_id]) byPipeline[r.pipeline_id] = {};
      byPipeline[r.pipeline_id][r.pipeline_stage_id] = {
        stage_name: r.pipeline_stage_name,
        count: r.count,
        value: r.value
      };
    }
    const out = pipelinesQ.rows.map((p) => {
      const stages = Array.isArray(p.stages) ? p.stages : [];
      const stageCounts = byPipeline[p.ghl_pipeline_id] || {};
      const total = Object.values(stageCounts).reduce((a, b) => a + (b.count || 0), 0);
      return {
        id: p.ghl_pipeline_id,
        name: p.name,
        pulled_at: p.pulled_at,
        total_opportunities: total,
        stages: stages.map((s) => ({
          id: s.id,
          name: s.name,
          count: stageCounts[s.id]?.count || 0,
          value: stageCounts[s.id]?.value || 0
        }))
      };
    });
    res.json({ locationId, pipelines: out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/pipeline/opportunities', async (req, res) => {
  try {
    const { locationId, pipelineId, stageId, limit = 100, offset = 0 } = req.query;
    if (!locationId) return res.status(400).json({ error: 'locationId required' });
    const params = [locationId];
    const filters = ['location_id = $1'];
    if (pipelineId) { params.push(pipelineId); filters.push(`pipeline_id = $${params.length}`); }
    if (stageId) { params.push(stageId); filters.push(`pipeline_stage_id = $${params.length}`); }
    const lim = Math.min(parseInt(limit, 10) || 100, 500);
    const off = parseInt(offset, 10) || 0;
    params.push(lim); params.push(off);
    const q = await db.query(
      `SELECT ghl_opportunity_id, contact_id, contact_name, pipeline_name, pipeline_stage_name,
              status, monetary_value, ghl_updated_at
       FROM ghl_opportunities WHERE ${filters.join(' AND ')}
       ORDER BY ghl_updated_at DESC NULLS LAST
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ opportunities: q.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Recent pipeline routing events — persisted to DB (survives restarts, unlike in-memory logger).
// Use this to verify routeOpportunity is firing and whether GHL API calls are succeeding.
router.get('/pipeline/route-log', async (req, res) => {
  try {
    const { contact_id, location_id, limit = 100 } = req.query;
    const params = [];
    const filters = [];
    if (contact_id) { params.push(contact_id); filters.push(`contact_id = $${params.length}`); }
    if (location_id) { params.push(location_id); filters.push(`location_id = $${params.length}`); }
    const lim = Math.min(parseInt(limit, 10) || 100, 500);
    params.push(lim);
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const q = await db.query(
      `SELECT id, contact_id, location_id, outcome, opportunity_id, pipeline_id, stage_id,
              prior_stage_id, was_created, skipped, error, steps, created_at
       FROM pipeline_route_log ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params
    );
    res.json({ rows: q.rows, count: q.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
