const express = require('express');
const jobsService = require('../services/jobs');
const db = require('../db');
const { getUsageStats } = require('../services/anthropic');
const router = express.Router();

router.get('/jobs/:id', async (req, res) => {
  try {
    const job = await jobsService.getJob(parseInt(req.params.id, 10));
    if (!job) return res.status(404).json({ error: 'not found' });
    res.json({ job });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/jobs', async (req, res) => {
  try {
    const { type, limit } = req.query;
    const jobs = await jobsService.listRecent({
      type: type || null,
      limit: Math.min(parseInt(limit, 10) || 20, 100)
    });
    res.json({ jobs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Diagnostic — reports in-process logUsage counters + DB aggregate stats so
// operators can quickly spot insert failures without grepping logs. Also
// exposes the 10 most recent `anthropic_usage` error log lines.
router.get('/admin/usage-log-stats', async (req, res) => {
  try {
    const mem = getUsageStats();
    const byCat = await db.query(
      `SELECT category,
              COUNT(*)::int AS rows,
              COALESCE(SUM(cost_usd), 0)::numeric AS cost,
              MIN(created_at) AS oldest,
              MAX(created_at) AS newest
         FROM anthropic_usage_log
        WHERE created_at > NOW() - INTERVAL '24 hours'
        GROUP BY category
        ORDER BY rows DESC`
    );
    const last1h = await db.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(cost_usd), 0)::numeric AS cost
         FROM anthropic_usage_log
        WHERE created_at > NOW() - INTERVAL '1 hour'`
    );
    const today = await db.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(cost_usd), 0)::numeric AS cost
         FROM anthropic_usage_log
        WHERE created_at::date = CURRENT_DATE`
    );
    res.json({
      in_process: mem,
      last_1h: last1h.rows[0],
      today: today.rows[0],
      by_category_24h: byCat.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
