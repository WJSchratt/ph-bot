const express = require('express');
const health = require('../services/health');

const router = express.Router();

router.get('/health/status', async (req, res) => {
  try {
    const current = health.getCurrentStatus();
    const uptime7d = await health.getUptime(7 * 24);
    res.json({
      status: current.status,
      components: current.components,
      checked_at: current.at,
      uptime_7d: uptime7d,
      uptime_7d_pct: uptime7d !== null ? Math.round(uptime7d * 10000) / 100 : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/health/history', async (req, res) => {
  try {
    const hours = Math.min(parseInt(req.query.hours, 10) || 168, 720);
    const buckets = await health.getRecentHourlyBuckets(hours);
    res.json({ hours, buckets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
