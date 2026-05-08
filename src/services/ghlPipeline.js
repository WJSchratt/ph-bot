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
// Stage/pipeline IDs are location-specific. The constants below are the PH main
// sub-account defaults. For all other locations, resolveLocationPipelineConfig()
// auto-discovers the correct IDs from the ghl_pipelines cache by matching stage names.
const SALES_PIPELINE_ID = 'BSxRZNZTwAi1atb957Ev';
const HANDOFF_REASON_FIELD_ID = 'pctRcbbTXCRK9t2toB4u';

// Stages that represent "past engagement" — don't downgrade a contact back
// to "Engaging with AI" if they're already at any of these.
const ENGAGING_SKIP_STAGES = [
  '5319f2ca-f208-4416-bf75-3843ac6b0d67', // Engaging with AI itself (no-op to avoid thrash)
  'c341c71e-9c68-4af9-aa9f-0471fceb3c51', // Needs Human Contact
  '7f4b529f-f067-4535-88bd-06d45ae9852b', // Appointment Set
  '1a298843-98b5-49ff-b787-40a21ed1a0a5', // DNC / Remove
  '69c4bf2f-3564-4a8a-b51c-3aec4d430c1a'  // Disqualified
];

const OUTCOME_TO_STAGE = {
  booked:            { stageId: '7f4b529f-f067-4535-88bd-06d45ae9852b', handoffReason: null,               label: 'Appointment Booked' },
  requested_human:   { stageId: 'c341c71e-9c68-4af9-aa9f-0471fceb3c51', handoffReason: 'Requested Human',  label: 'Requested Human' },
  opted_out:         { stageId: 'c341c71e-9c68-4af9-aa9f-0471fceb3c51', handoffReason: 'Opted Out of SMS', label: 'Opted Out of SMS' },
  dnc:               { stageId: '1a298843-98b5-49ff-b787-40a21ed1a0a5', handoffReason: 'DNC',              label: 'DNC' },
  disqualified:      { stageId: '69c4bf2f-3564-4a8a-b51c-3aec4d430c1a', handoffReason: null,               label: 'Disqualified' },
  engaging_with_ai:  { stageId: '5319f2ca-f208-4416-bf75-3843ac6b0d67', handoffReason: null,               label: 'Engaging with AI', skipIfAtStageIds: ENGAGING_SKIP_STAGES }
};

// Maps stage name patterns to outcome keys so we can match any sub-account's
// stages by name regardless of their GHL-generated UUIDs.
const STAGE_NAME_PATTERNS = [
  // Insurance pipeline stages
  { pattern: /engaging.with.ai/i,  outcome: 'engaging_with_ai' },
  { pattern: /appointment.set/i,   outcome: 'booked' },
  { pattern: /needs.human/i,       outcome: 'requested_human' },
  { pattern: /^dnc$/i,             outcome: 'dnc' },
  { pattern: /remove/i,            outcome: 'dnc' },
  { pattern: /disqualif/i,         outcome: 'disqualified' },
  // Chiro Patient Pipeline stages
  { pattern: /NPE\s*book/i,        outcome: 'booked' },
  { pattern: /^contacted$/i,       outcome: 'engaging_with_ai' },
  { pattern: /^new\s*lead$/i,      outcome: 'engaging_with_ai' },
  { pattern: /lost.*\/.*DQ|lost.*disq/i, outcome: 'dnc' },
];

// In-memory cache: locationId → {pipelineId, stageMap, cachedAt}
const _pipelineConfigCache = new Map();
const PIPELINE_CONFIG_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Looks up the Sales Pipeline for a location from the ghl_pipelines DB cache,
// pulling from GHL if not yet cached. Returns {pipelineId, stageMap} where
// stageMap keys are outcome names (e.g. "booked", "engaging_with_ai").
// Returns null if the pipeline can't be resolved.
// Returns the ILIKE pattern used to find the main pipeline for a given vertical.
function pipelineNamePattern(vertical) {
  if (vertical === 'chiro') return '%Patient%';
  return '%Sales%';
}

async function resolveLocationPipelineConfig(locationId, ghlToken, vertical) {
  const cacheKey = `${locationId}:${vertical || 'insurance'}`;
  const mem = _pipelineConfigCache.get(cacheKey);
  if (mem && Date.now() - mem.cachedAt < PIPELINE_CONFIG_CACHE_TTL_MS) return mem;

  const namePattern = pipelineNamePattern(vertical || 'insurance');
  let row = null;
  try {
    const r = await db.query(
      `SELECT ghl_pipeline_id, stages FROM ghl_pipelines
       WHERE location_id = $1 AND name ILIKE $2
       ORDER BY pulled_at DESC LIMIT 1`,
      [locationId, namePattern]
    );
    row = r.rows[0] || null;
  } catch (err) {
    logger.log('pipeline_route', 'warn', null, 'DB pipeline lookup failed', { locationId, error: err.message });
  }

  // Not in DB yet — pull fresh from GHL
  if (!row && ghlToken) {
    try {
      await pullPipelines(ghlToken, locationId);
      const r = await db.query(
        `SELECT ghl_pipeline_id, stages FROM ghl_pipelines
         WHERE location_id = $1 AND name ILIKE $2
         ORDER BY pulled_at DESC LIMIT 1`,
        [locationId, namePattern]
      );
      row = r.rows[0] || null;
    } catch (err) {
      logger.log('pipeline_route', 'warn', null, 'Pipeline pull failed', { locationId, error: err.message });
    }
  }

  if (!row) return null;

  const stages = Array.isArray(row.stages) ? row.stages : [];
  const stageMap = {};
  for (const stage of stages) {
    for (const { pattern, outcome } of STAGE_NAME_PATTERNS) {
      if (!stageMap[outcome] && pattern.test(stage.name || '')) {
        stageMap[outcome] = stage.id;
        break;
      }
    }
  }

  const config = { pipelineId: row.ghl_pipeline_id, stageMap, cachedAt: Date.now() };
  _pipelineConfigCache.set(cacheKey, config);
  logger.log('pipeline_route', 'info', null, 'Pipeline config resolved', {
    locationId, pipelineId: config.pipelineId, stages: Object.keys(stageMap).length
  });
  return config;
}

// Map internal terminal_outcome values the bot produces → feature outcome labels.
const TERMINAL_TO_ROUTE_OUTCOME = {
  appointment_booked:        'booked',
  advanced_market_booked:    'booked',
  human_handoff:             'requested_human',
  fex_immediate:             'requested_human',
  mp_immediate:              'requested_human',
  dnc:                       'dnc',
  opted_out:                 'opted_out',
  opt_out:                   'opted_out',
  stop_requested:            'opted_out',
  disqualified:              'disqualified'
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

async function createOpportunity(ghlToken, locationId, contactId, name, pipelineStageId, pipelineId = SALES_PIPELINE_ID) {
  const res = await axios.post(
    `${GHL_BASE}/opportunities/`,
    { pipelineId, locationId, name, pipelineStageId, status: 'open', contactId },
    { headers: v2Headers(ghlToken), timeout: 15000 }
  );
  return res.data?.opportunity || res.data;
}

async function fetchContactName(ghlToken, contactId) {
  try {
    const res = await axios.get(`${GHL_BASE}/contacts/${contactId}`, {
      headers: v2Headers(ghlToken),
      timeout: 10000
    });
    const c = res.data?.contact || {};
    const full = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
    return full || c.contactName || c.name || null;
  } catch {
    return null;
  }
}

// Main routing tool. Never throws — returns a structured result with per-step
// success/failure so a webhook handler can log-and-continue. When the contact
// has no opportunity yet, one is created in the Sales Pipeline at the target
// stage (step: 'create_opportunity'); otherwise the existing opp is moved
// (step: 'update_stage').
async function routeOpportunity(ghlToken, locationId, contactId, outcome, opts = {}) {
  const { dryRun = false, logCtx = null, contactName = null, vertical = 'insurance' } = opts;
  const lc = logCtx || contactId;
  const result = {
    contactId,
    outcome,
    dryRun,
    opportunityId: null,
    prior: null,
    target: null,
    handoffReason: null,
    created: false,
    steps: []
  };

  const mapping = OUTCOME_TO_STAGE[outcome];
  if (!mapping) {
    result.skipped = 'unknown_outcome';
    logger.log('pipeline_route', 'warn', lc, 'Unknown outcome, skipping', { outcome });
    return result;
  }

  // Resolve location-specific pipeline/stage IDs; fall back to PH main defaults
  let resolvedPipelineId = SALES_PIPELINE_ID;
  let resolvedStageId = mapping.stageId;
  let resolvedSkipStageIds = Array.isArray(mapping.skipIfAtStageIds) ? mapping.skipIfAtStageIds : null;

  const locCfg = await resolveLocationPipelineConfig(locationId, ghlToken, vertical);
  if (locCfg) {
    resolvedPipelineId = locCfg.pipelineId;
    if (locCfg.stageMap[outcome]) resolvedStageId = locCfg.stageMap[outcome];
    // For engaging_with_ai skip check: all resolved stage IDs count as "at or past"
    if (mapping.skipIfAtStageIds) {
      resolvedSkipStageIds = Object.values(locCfg.stageMap).filter(Boolean);
    }
  }

  result.target = { pipelineId: resolvedPipelineId, pipelineStageId: resolvedStageId };
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

  if (opp) {
    result.opportunityId = opp.id;
    result.prior = {
      pipelineId: opp.pipelineId,
      pipelineStageId: opp.pipelineStageId,
      status: opp.status
    };
    result.steps.push({ step: 'search', ok: true, found: 1, opportunityId: opp.id, prior: result.prior });

    // Skip if already at-or-past the target stage. Used by "engaging_with_ai"
    // to avoid downgrading contacts who've already progressed to Appointment
    // Set / Needs Human Contact / DNC / Disqualified, and to no-op when
    // already at Engaging with AI.
    const skipSet = resolvedSkipStageIds;
    if (skipSet && skipSet.includes(opp.pipelineStageId)) {
      result.skipped = 'already_at_or_past_stage';
      result.steps.push({ step: 'skip_check', ok: true, reason: 'already_at_or_past_stage', currentStageId: opp.pipelineStageId });
      logger.log('pipeline_route', 'info', lc, 'Opportunity already at/past target stage, skipping', {
        outcome, opportunityId: opp.id, currentStageId: opp.pipelineStageId
      });
      return result;
    }
  } else {
    result.steps.push({ step: 'search', ok: true, found: 0 });
  }

  // Resolve the opportunity name once (needed only if we end up creating).
  async function buildOpportunityName() {
    let name = contactName || null;
    if (!name) name = await fetchContactName(ghlToken, contactId);
    const base = (name && String(name).trim()) || `Contact ${contactId}`;
    return `${base} - ${mapping.label}`;
  }

  if (dryRun) {
    if (opp) {
      result.steps.push({ step: 'update_stage', ok: true, dryRun: true, target: result.target });
    } else {
      const plannedName = await buildOpportunityName();
      result.steps.push({ step: 'create_opportunity', ok: true, dryRun: true, target: result.target, plannedName });
    }
    if (mapping.handoffReason) {
      result.steps.push({ step: 'set_handoff_reason', ok: true, dryRun: true, value: mapping.handoffReason });
    }
    logger.log('pipeline_route', 'info', lc, 'routeOpportunity dryRun', {
      outcome, opportunityId: opp?.id || null, will_create: !opp, target: result.target, handoff_reason: mapping.handoffReason
    });
    return result;
  }

  if (opp) {
    try {
      await updateOpportunityStage(ghlToken, opp.id, resolvedStageId, resolvedPipelineId);
      result.steps.push({ step: 'update_stage', ok: true, target: result.target });
    } catch (err) {
      const error = err.response?.data || err.message;
      logger.log('pipeline_route', 'error', lc, 'Stage update failed', { outcome, opportunityId: opp.id, error });
      result.steps.push({ step: 'update_stage', ok: false, error });
      result.error = error;
    }
  } else {
    try {
      const name = await buildOpportunityName();
      const newOpp = await createOpportunity(ghlToken, locationId, contactId, name, resolvedStageId, resolvedPipelineId);
      const newId = newOpp?.id || newOpp?._id || null;
      result.opportunityId = newId;
      result.created = true;
      result.steps.push({ step: 'create_opportunity', ok: true, target: result.target, opportunityId: newId, name });
    } catch (err) {
      const error = err.response?.data || err.message;
      logger.log('pipeline_route', 'error', lc, 'Opportunity create failed', { outcome, error });
      result.steps.push({ step: 'create_opportunity', ok: false, error });
      result.error = error;
    }
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
    opportunityId: result.opportunityId,
    created: result.created,
    target: result.target,
    handoff_reason: mapping.handoffReason,
    steps: result.steps.map((s) => ({ step: s.step, ok: s.ok }))
  });

  // Persist to DB so routing history survives server restarts (in-memory logger rolls off at 200 entries).
  try {
    await db.query(
      `INSERT INTO pipeline_route_log
        (contact_id, location_id, outcome, route_outcome, opportunity_id, pipeline_id, stage_id, prior_stage_id, was_created, skipped, error, steps)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        contactId,
        locationId,
        outcome,
        result.target ? outcome : null,
        result.opportunityId || null,
        result.target?.pipelineId || null,
        result.target?.pipelineStageId || null,
        result.prior?.pipelineStageId || null,
        result.created || false,
        result.skipped || null,
        result.error ? JSON.stringify(result.error) : null,
        JSON.stringify(result.steps.map((s) => ({ step: s.step, ok: s.ok, error: s.error || undefined })))
      ]
    );
  } catch (dbErr) {
    logger.log('pipeline_route', 'warn', lc, 'DB log write failed', { error: dbErr.message });
  }

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
  createOpportunity,
  fetchContactName,
  resolveLocationPipelineConfig,
  routeOpportunity,
  OUTCOME_TO_STAGE,
  TERMINAL_TO_ROUTE_OUTCOME,
  SALES_PIPELINE_ID,
  HANDOFF_REASON_FIELD_ID
};
