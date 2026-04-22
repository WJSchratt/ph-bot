const axios = require('axios');
const db = require('../db');
const logger = require('./logger');

// 5-min interval instead of 60s: cuts background DB writes + outbound HTTP
// by 5x without breaking the uptime % math (which is ratio-based, not count-based).
// Hourly-bucket resolution is still 12 data points per hour — plenty for charts.
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const GHL_BASE = 'https://services.leadconnectorhq.com';

let intervalHandle = null;
let lastCheck = { status: 'unknown', components: {}, at: null };

async function checkDb() {
  const started = Date.now();
  try {
    await db.query('SELECT 1');
    return { name: 'db', status: 'up', response_time_ms: Date.now() - started, error: null };
  } catch (err) {
    return { name: 'db', status: 'down', response_time_ms: Date.now() - started, error: err.message };
  }
}

async function checkClaude() {
  const started = Date.now();
  if (!process.env.ANTHROPIC_API_KEY) {
    return { name: 'claude', status: 'down', response_time_ms: Date.now() - started, error: 'ANTHROPIC_API_KEY not set' };
  }
  return { name: 'claude', status: 'up', response_time_ms: Date.now() - started, error: null };
}

async function checkGhl() {
  const started = Date.now();
  try {
    await axios.get(`${GHL_BASE}/`, { timeout: 8000, validateStatus: () => true });
    return { name: 'ghl', status: 'up', response_time_ms: Date.now() - started, error: null };
  } catch (err) {
    return { name: 'ghl', status: 'down', response_time_ms: Date.now() - started, error: err.message };
  }
}

function rollUpStatus(checks) {
  const downs = checks.filter((c) => c.status === 'down');
  if (!downs.length) return 'up';
  const critical = downs.some((c) => c.name === 'db');
  if (critical) return 'down';
  return 'degraded';
}

async function runCheck() {
  const checks = await Promise.all([checkDb(), checkClaude(), checkGhl()]);
  const overall = rollUpStatus(checks);
  lastCheck = {
    status: overall,
    components: checks.reduce((acc, c) => { acc[c.name] = c; return acc; }, {}),
    at: new Date().toISOString()
  };

  for (const c of checks) {
    try {
      await db.query(
        `INSERT INTO system_health_log (status, component, response_time_ms, error_message)
         VALUES ($1, $2, $3, $4)`,
        [c.status, c.name, c.response_time_ms, c.error || null]
      );
    } catch (err) {
      logger.log('health', 'error', null, 'Failed to insert health log', { component: c.name, error: err.message });
    }
  }

  if (overall !== 'up') {
    logger.log('health', 'warn', null, `System ${overall}`, { components: lastCheck.components });
  }
}

function startHealthLoop() {
  if (intervalHandle) return;
  runCheck().catch((err) => logger.log('health', 'error', null, 'Initial health check failed', { error: err.message }));
  intervalHandle = setInterval(() => {
    runCheck().catch((err) => logger.log('health', 'error', null, 'Health check failed', { error: err.message }));
  }, CHECK_INTERVAL_MS);
}

function getCurrentStatus() {
  return lastCheck;
}

async function getUptime(hours = 7 * 24) {
  try {
    const q = await db.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status = 'up')::int AS up
       FROM system_health_log
       WHERE checked_at >= NOW() - ($1 || ' hours')::interval`,
      [String(hours)]
    );
    const r = q.rows[0] || {};
    return r.total ? (r.up / r.total) : 1;
  } catch {
    return null;
  }
}

async function getRecentHourlyBuckets(hours = 168) {
  try {
    const q = await db.query(
      `SELECT date_trunc('hour', checked_at) AS bucket,
              COUNT(*) FILTER (WHERE status = 'up')::int AS up,
              COUNT(*) FILTER (WHERE status = 'down')::int AS down,
              COUNT(*) FILTER (WHERE status = 'degraded')::int AS degraded,
              AVG(response_time_ms)::float AS avg_ms
       FROM system_health_log
       WHERE checked_at >= NOW() - ($1 || ' hours')::interval
       GROUP BY 1 ORDER BY 1`,
      [String(hours)]
    );
    return q.rows;
  } catch {
    return [];
  }
}

module.exports = {
  startHealthLoop,
  runCheck,
  getCurrentStatus,
  getUptime,
  getRecentHourlyBuckets
};
