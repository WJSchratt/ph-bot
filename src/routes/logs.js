const express = require('express');
const { getLogs } = require('../services/logger');

const router = express.Router();

router.get('/logs', (req, res) => {
  const { contact_id, limit } = req.query;
  const logs = getLogs({ contact_id, limit });
  res.json({ logs });
});

module.exports = router;
