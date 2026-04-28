const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db');
const logger = require('./logger');

const ALLOWED_CATEGORIES = new Set([
  'bot_response',
  'word_track_clustering',
  'qc_sim_score',
  'qc_generate_samples',
  'qc_batch_apply',
  'qc_console',
  'analyzer_analysis',
  'analyzer_prompt_gen',
  'dev_console',
  'sandbox_sim',
  'chiro_console',
  'chiro_apply',
  'chiro_sandbox'
]);

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

let pricingCache = null;
let pricingCacheAt = 0;
const PRICING_TTL_MS = 60 * 1000;

async function getPricing() {
  const now = Date.now();
  if (pricingCache && now - pricingCacheAt < PRICING_TTL_MS) return pricingCache;
  const defaults = {
    input_per_m: 3,
    output_per_m: 15,
    cache_read_per_m: 0.30,
    cache_write_per_m: 3.75
  };
  try {
    const q = await db.query(`SELECT key, value FROM app_settings WHERE section = 'cost_config'`);
    const map = {};
    for (const r of q.rows) map[r.key] = r.value;
    pricingCache = {
      input_per_m: parseFloat(map.input_token_cost_per_million) || defaults.input_per_m,
      output_per_m: parseFloat(map.output_token_cost_per_million) || defaults.output_per_m,
      cache_read_per_m: parseFloat(map.cache_read_cost_per_million) || defaults.cache_read_per_m,
      cache_write_per_m: parseFloat(map.cache_write_cost_per_million) || defaults.cache_write_per_m
    };
  } catch {
    pricingCache = defaults;
  }
  pricingCacheAt = now;
  return pricingCache;
}

function computeCost(usage, pricing) {
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  return (
    (input * pricing.input_per_m +
     output * pricing.output_per_m +
     cacheWrite * pricing.cache_write_per_m +
     cacheRead * pricing.cache_read_per_m) / 1_000_000
  );
}

// In-memory counters for the /api/admin/usage-log-stats diagnostic.
const _usageStats = { attempted: 0, logged: 0, failed: 0, retried: 0, lastError: null, byCategory: {} };

async function _runInsert(params) {
  await db.query(
    `INSERT INTO anthropic_usage_log
     (category, model, location_id, input_tokens, output_tokens,
      cache_creation_input_tokens, cache_read_input_tokens,
      cost_usd, duration_ms, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    params
  );
}

async function logUsage({ category, model, location_id, usage, duration_ms, meta }) {
  _usageStats.attempted++;
  _usageStats.byCategory[category] = _usageStats.byCategory[category] || { attempted: 0, logged: 0, failed: 0 };
  _usageStats.byCategory[category].attempted++;
  const pricing = await getPricing();
  const cost = computeCost(usage || {}, pricing);
  const params = [
    category, model, location_id || null,
    usage?.input_tokens || 0, usage?.output_tokens || 0,
    usage?.cache_creation_input_tokens || 0, usage?.cache_read_input_tokens || 0,
    cost, duration_ms || null, meta ? JSON.stringify(meta) : null
  ];

  try {
    await _runInsert(params);
    _usageStats.logged++;
    _usageStats.byCategory[category].logged++;
    return;
  } catch (err) {
    // Common poisoning: a sibling query (e.g. Dev Console runSafeQuery)
    // left an aborted transaction on a pooled connection. Retry once —
    // the pool either hands us a healthy connection this time, or the
    // error repeats and we report it loudly.
    const transient = /transaction is aborted|connection terminated|reset by peer|read ECONN/i.test(err.message || '');
    if (transient) {
      _usageStats.retried++;
      await new Promise((r) => setTimeout(r, 250));
      try {
        await _runInsert(params);
        _usageStats.logged++;
        _usageStats.byCategory[category].logged++;
        return;
      } catch (retryErr) {
        _usageStats.failed++;
        _usageStats.byCategory[category].failed++;
        _usageStats.lastError = { message: retryErr.message, at: new Date().toISOString(), category };
        throw retryErr;
      }
    }
    _usageStats.failed++;
    _usageStats.byCategory[category].failed++;
    _usageStats.lastError = { message: err.message, at: new Date().toISOString(), category };
    throw err;
  }
}

function getUsageStats() { return JSON.parse(JSON.stringify(_usageStats)); }

/**
 * Shared wrapper for all Anthropic calls. Forwards params to
 * client.messages.create() unchanged and returns the raw response.
 * Usage logging is fire-and-forget so the hot path is never blocked.
 */
async function callAnthropic(params, ctx) {
  const category = ctx?.category;
  if (!category) throw new Error('callAnthropic: category is required');
  if (!ALLOWED_CATEGORIES.has(category)) {
    throw new Error(`callAnthropic: unknown category "${category}"`);
  }
  const t0 = Date.now();
  const resp = await client.messages.create(params);
  const duration_ms = Date.now() - t0;

  logUsage({
    category,
    model: params.model,
    location_id: ctx.location_id || null,
    usage: resp.usage || {},
    duration_ms,
    meta: ctx.meta || null
  }).catch((err) => {
    // Loud failure: write to stderr (shows in Railway logs) in addition to the
    // in-memory logger. Silent failures here caused Bug 2 — the dashboard fell
    // back to stale conversations.input_tokens and showed $0.00 · 0 calls.
    console.error('[anthropic_usage] INSERT FAILED:', category, err.message);
    logger.log('anthropic_usage', 'error', null, 'usage log insert failed', {
      category,
      error: err.message,
      hint: /relation .* does not exist/i.test(err.message)
        ? 'run `npm run migrate` — anthropic_usage_log table missing'
        : undefined
    });
  });

  return resp;
}

module.exports = {
  callAnthropic,
  client,
  ALLOWED_CATEGORIES: Array.from(ALLOWED_CATEGORIES),
  getUsageStats,
  _internal: { getPricing, computeCost }
};
