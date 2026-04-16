const axios = require('axios');
const db = require('../db');
const logger = require('./logger');

const GHL_BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-04-15';
const OPP_PAGE_SIZE = 100;
const OPP_PAGE_SLEEP_MS = 50;
const OPP_PARALLEL = 5;
const MAX_OPPORTUNITIES = 50000;

function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, Version: VERSION };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function tsOrNull(v) {
  if (!v && v !== 0) return null;
  const d = new Date(typeof v === 'number' ? v : String(v));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

async function pullPipelines(ghlToken, locationId) {
  try {
    const res = await axios.get(`${GHL_BASE}/opportunities/pipelines`, {
      headers: authHeaders(ghlToken),
      params: { locationId },
      timeout: 20000
    });
    const pipelines = res.data?.pipelines || [];
    for (const p of pipelines) {
      await db.query(
        `INSERT INTO ghl_pipelines (ghl_pipeline_id, name, location_id, stages, pulled_at)
         VALUES ($1, $2, $3, $4::jsonb, NOW())
         ON CONFLICT (ghl_pipeline_id, location_id) DO UPDATE SET
           name = EXCLUDED.name, stages = EXCLUDED.stages, pulled_at = NOW()`,
        [p.id, p.name, locationId, JSON.stringify(p.stages || [])]
      );
    }
    logger.log('pipeline', 'info', null, 'Pipelines pulled', { locationId, count: pipelines.length });
    return pipelines;
  } catch (err) {
    logger.log('pipeline', 'error', null, 'Pipelines pull failed', {
      locationId, status: err.response?.status, error: err.response?.data || err.message
    });
    throw err;
  }
}

async function fetchOpportunitiesPage(ghlToken, locationId, cursor) {
  const params = { location_id: locationId, limit: OPP_PAGE_SIZE };
  if (cursor && cursor.startAfter) params.startAfter = cursor.startAfter;
  if (cursor && cursor.startAfterId) params.startAfterId = cursor.startAfterId;
  const res = await axios.get(`${GHL_BASE}/opportunities/search`, {
    headers: authHeaders(ghlToken),
    params,
    timeout: 30000
  });
  return res.data || {};
}

function pipelineStageNameFromCache(cache, pipelineId, stageId) {
  const p = cache[pipelineId];
  if (!p) return null;
  const stage = (p.stages || []).find((s) => s.id === stageId);
  return stage?.name || null;
}

async function upsertOpportunity(op, locationId, pipelineCache) {
  const pipelineId = op.pipelineId || op.pipeline_id || null;
  const stageId = op.pipelineStageId || op.pipeline_stage_id || null;
  const stageName = pipelineCache[pipelineId]
    ? pipelineStageNameFromCache(pipelineCache, pipelineId, stageId)
    : null;
  const pipelineName = pipelineCache[pipelineId]?.name || null;
  const contactName = op.contact?.name || op.contactName || op.name || null;
  const contactId = op.contactId || op.contact_id || op.contact?.id || null;
  const monetary = Number(op.monetaryValue || op.monetary_value || 0) || 0;

  await db.query(
    `INSERT INTO ghl_opportunities
       (ghl_opportunity_id, contact_id, contact_name, pipeline_id, pipeline_name,
        pipeline_stage_id, pipeline_stage_name, status, monetary_value, location_id,
        ghl_created_at, ghl_updated_at, pulled_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
     ON CONFLICT (ghl_opportunity_id, location_id) DO UPDATE SET
       contact_id = COALESCE(EXCLUDED.contact_id, ghl_opportunities.contact_id),
       contact_name = COALESCE(EXCLUDED.contact_name, ghl_opportunities.contact_name),
       pipeline_id = COALESCE(EXCLUDED.pipeline_id, ghl_opportunities.pipeline_id),
       pipeline_name = COALESCE(EXCLUDED.pipeline_name, ghl_opportunities.pipeline_name),
       pipeline_stage_id = COALESCE(EXCLUDED.pipeline_stage_id, ghl_opportunities.pipeline_stage_id),
       pipeline_stage_name = COALESCE(EXCLUDED.pipeline_stage_name, ghl_opportunities.pipeline_stage_name),
       status = COALESCE(EXCLUDED.status, ghl_opportunities.status),
       monetary_value = EXCLUDED.monetary_value,
       ghl_created_at = COALESCE(EXCLUDED.ghl_created_at, ghl_opportunities.ghl_created_at),
       ghl_updated_at = COALESCE(EXCLUDED.ghl_updated_at, ghl_opportunities.ghl_updated_at),
       pulled_at = NOW()`,
    [
      op.id,
      contactId,
      contactName,
      pipelineId,
      pipelineName,
      stageId,
      stageName,
      op.status || null,
      monetary,
      locationId,
      tsOrNull(op.createdAt || op.created_at),
      tsOrNull(op.updatedAt || op.updated_at)
    ]
  );
}

async function pullOpportunities(ghlToken, locationId, pipelineCache, progressCb) {
  let fetched = 0;
  let pages = 0;
  let cursor = null;

  while (fetched < MAX_OPPORTUNITIES) {
    pages++;
    let data;
    try {
      data = await fetchOpportunitiesPage(ghlToken, locationId, cursor);
    } catch (err) {
      logger.log('pipeline', 'error', null, 'Opportunities page failed', {
        locationId, page: pages, status: err.response?.status,
        error: err.response?.data || err.message
      });
      throw err;
    }
    const list = data.opportunities || [];
    if (!list.length) break;

    await Promise.all(list.map((op) => upsertOpportunity(op, locationId, pipelineCache).catch((err) => {
      logger.log('pipeline', 'error', null, 'Opportunity upsert failed', { op_id: op.id, error: err.message });
    })));

    fetched += list.length;
    if (progressCb) progressCb({ fetched, page: pages });

    const meta = data.meta || {};
    const next = meta.startAfter || meta.startAfterId;
    if (!next || list.length < OPP_PAGE_SIZE) break;
    cursor = {
      startAfter: meta.startAfter || cursor?.startAfter || null,
      startAfterId: meta.startAfterId || list[list.length - 1]?.id || null
    };
    await sleep(OPP_PAGE_SLEEP_MS);
  }
  logger.log('pipeline', 'info', null, 'Opportunities pull complete', { locationId, fetched, pages });
  return { fetched, pages };
}

async function pullAll(ghlToken, locationId, progressCb) {
  const pipelines = await pullPipelines(ghlToken, locationId);
  const cache = {};
  for (const p of pipelines) cache[p.id] = p;
  const oppResult = await pullOpportunities(ghlToken, locationId, cache, progressCb);
  return { pipelines: pipelines.length, opportunities: oppResult.fetched };
}

module.exports = {
  pullPipelines,
  pullOpportunities,
  pullAll,
  sleep
};
