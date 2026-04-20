const axios = require('axios');
const db = require('../db');
const logger = require('./logger');

const GHL_BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-04-15';
const VERSION_V2 = '2021-07-28';
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

// --- Pipeline routing: move opportunity to stage matching a bot outcome ---
// Target pipeline is "1 - Sales Pipeline" for the PH main sub-account. Each
// outcome maps to a specific stage + (optional) Handoff Reason picklist value
// on the contact. These IDs are location-specific; see summary.md for lookup.
const SALES_PIPELINE_ID = 'BSxRZNZTwAi1atb957Ev';
const HANDOFF_REASON_FIELD_ID = 'pctRcbbTXCRK9t2toB4u';

const OUTCOME_TO_STAGE = {
  booked:          { stageId: '7f4b529f-f067-4535-88bd-06d45ae9852b', handoffReason: null },
  requested_human: { stageId: 'c341c71e-9c68-4af9-aa9f-0471fceb3c51', handoffReason: 'Requested Human' },
  opted_out:       { stageId: 'c341c71e-9c68-4af9-aa9f-0471fceb3c51', handoffReason: 'Opted Out of SMS' },
  dnc:             { stageId: '1a298843-98b5-49ff-b787-40a21ed1a0a5', handoffReason: 'DNC' },
  disqualified:    { stageId: '69c4bf2f-3564-4a8a-b51c-3aec4d430c1a', handoffReason: null }
};

// Map internal terminal_outcome values the bot produces → feature outcome labels.
const TERMINAL_TO_ROUTE_OUTCOME = {
  appointment_booked: 'booked',
  human_handoff:      'requested_human',
  fex_immediate:      'requested_human',
  mp_immediate:       'requested_human',
  dnc:                'dnc',
  opted_out:          'opted_out',
  opt_out:            'opted_out',
  stop_requested:     'opted_out',
  disqualified:       'disqualified'
};

function v2Headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Version: VERSION_V2,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
}

async function findContactOpportunity(ghlToken, locationId, contactId) {
  const res = await axios.get(`${GHL_BASE}/opportunities/search`, {
    headers: v2Headers(ghlToken),
    params: { location_id: locationId, contact_id: contactId, limit: 20 },
    timeout: 15000
  });
  const list = res.data?.opportunities || [];
  if (!list.length) return null;
  // Open status first, then most recently updated.
  const scored = list.slice().sort((a, b) => {
    const ao = a.status === 'open' ? 1 : 0;
    const bo = b.status === 'open' ? 1 : 0;
    if (ao !== bo) return bo - ao;
    const au = new Date(a.updatedAt || a.lastStageChangeAt || 0).getTime();
    const bu = new Date(b.updatedAt || b.lastStageChangeAt || 0).getTime();
    return bu - au;
  });
  return scored[0];
}

async function updateOpportunityStage(ghlToken, opportunityId, pipelineStageId, pipelineId = SALES_PIPELINE_ID) {
  const res = await axios.put(
    `${GHL_BASE}/opportunities/${opportunityId}`,
    { pipelineId, pipelineStageId },
    { headers: v2Headers(ghlToken), timeout: 15000 }
  );
  return res.data?.opportunity || res.data;
}

async function setHandoffReason(ghlToken, contactId, reasonValue) {
  const res = await axios.put(
    `${GHL_BASE}/contacts/${contactId}`,
    { customFields: [{ id: HANDOFF_REASON_FIELD_ID, value: reasonValue }] },
    { headers: v2Headers(ghlToken), timeout: 15000 }
  );
  return res.data;
}

// Main routing tool. Never throws — returns a structured result with per-step
// success/failure so a webhook handler can log-and-continue.
async function routeOpportunity(ghlToken, locationId, contactId, outcome, opts = {}) {
  const { dryRun = false, logCtx = null } = opts;
  const lc = logCtx || contactId;
  const result = {
    contactId,
    outcome,
    dryRun,
    opportunityId: null,
    prior: null,
    target: null,
    handoffReason: null,
    steps: []
  };

  const mapping = OUTCOME_TO_STAGE[outcome];
  if (!mapping) {
    result.skipped = 'unknown_outcome';
    logger.log('pipeline_route', 'warn', lc, 'Unknown outcome, skipping', { outcome });
    return result;
  }
  result.target = { pipelineId: SALES_PIPELINE_ID, pipelineStageId: mapping.stageId };
  result.handoffReason = mapping.handoffReason;

  let opp;
  try {
    opp = await findContactOpportunity(ghlToken, locationId, contactId);
  } catch (err) {
    const error = err.response?.data || err.message;
    logger.log('pipeline_route', 'error', lc, 'Opportunity search failed', { outcome, error });
    result.error = error;
    result.steps.push({ step: 'search', ok: false, error });
    return result;
  }

  if (!opp) {
    result.skipped = 'no_opportunity';
    result.steps.push({ step: 'search', ok: true, found: 0 });
    logger.log('pipeline_route', 'info', lc, 'No opportunity for contact, nothing to route', { outcome });
    return result;
  }

  result.opportunityId = opp.id;
  result.prior = {
    pipelineId: opp.pipelineId,
    pipelineStageId: opp.pipelineStageId,
    status: opp.status
  };
  result.steps.push({ step: 'search', ok: true, found: 1, opportunityId: opp.id, prior: result.prior });

  if (dryRun) {
    result.steps.push({ step: 'update_stage', ok: true, dryRun: true, target: result.target });
    if (mapping.handoffReason) {
      result.steps.push({ step: 'set_handoff_reason', ok: true, dryRun: true, value: mapping.handoffReason });
    }
    logger.log('pipeline_route', 'info', lc, 'routeOpportunity dryRun', {
      outcome, opportunityId: opp.id, target: result.target, handoff_reason: mapping.handoffReason
    });
    return result;
  }

  try {
    await updateOpportunityStage(ghlToken, opp.id, mapping.stageId, SALES_PIPELINE_ID);
    result.steps.push({ step: 'update_stage', ok: true, target: result.target });
  } catch (err) {
    const error = err.response?.data || err.message;
    logger.log('pipeline_route', 'error', lc, 'Stage update failed', { outcome, opportunityId: opp.id, error });
    result.steps.push({ step: 'update_stage', ok: false, error });
    result.error = error;
  }

  if (mapping.handoffReason) {
    try {
      await setHandoffReason(ghlToken, contactId, mapping.handoffReason);
      result.steps.push({ step: 'set_handoff_reason', ok: true, value: mapping.handoffReason });
    } catch (err) {
      const error = err.response?.data || err.message;
      logger.log('pipeline_route', 'error', lc, 'Handoff reason update failed', { outcome, error });
      result.steps.push({ step: 'set_handoff_reason', ok: false, error, value: mapping.handoffReason });
    }
  }

  logger.log('pipeline_route', 'info', lc, 'routeOpportunity complete', {
    outcome,
    opportunityId: opp.id,
    target: result.target,
    handoff_reason: mapping.handoffReason,
    steps: result.steps.map((s) => ({ step: s.step, ok: s.ok }))
  });
  return result;
}

module.exports = {
  pullPipelines,
  pullOpportunities,
  pullAll,
  sleep,
  // Pipeline routing
  findContactOpportunity,
  updateOpportunityStage,
  setHandoffReason,
  routeOpportunity,
  OUTCOME_TO_STAGE,
  TERMINAL_TO_ROUTE_OUTCOME,
  SALES_PIPELINE_ID,
  HANDOFF_REASON_FIELD_ID
};
