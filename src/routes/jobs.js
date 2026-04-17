const express = require('express');
const jobsService = require('../services/jobs');
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

module.exports = router;
