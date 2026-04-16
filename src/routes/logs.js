const express = require('express');
const { getLogs } = require('../services/logger');

const router = express.Router();

router.get('/logs', (req, res) => {
  const { contact_id, limit } = req.query;
  const logs = getLogs({ contact_id, limit });
  res.json({ logs });
});

router.get('/logs/errors', (req, res) => {
  const { contact_id, limit } = req.query;
  const all = getLogs({ contact_id, limit: 200 });
  const errors = all.filter((l) => l.level === 'error');
  const max = Math.min(parseInt(limit, 10) || 50, 200);
  res.json({ logs: errors.slice(0, max), count: errors.length });
});

router.get('/logs/latest', (req, res) => {
  const logs = getLogs({ limit: 50 });
  res.json({ logs, count: logs.length });
});

module.exports = router;
