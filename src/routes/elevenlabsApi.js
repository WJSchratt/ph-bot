const express = require('express');
const store = require('../services/elevenlabsStore');
const audio = require('../services/elevenlabsAudio');
const epHandler = require('../services/epHandler');

const router = express.Router();

// List calls. `ep=1` narrows to EP only.
router.get('/elevenlabs/calls', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
  const offset = parseInt(req.query.offset, 10) || 0;
  const agentName = req.query.agent_name || null;
  const startDate = req.query.start_date || null;
  const endDate = req.query.end_date || null;
  const isEp = req.query.ep === '1' || req.query.ep === 'true';
  try {
    const out = await store.list({ isEp, agentName, startDate, endDate, limit, offset });
    res.json({ ok: true, ...out, limit, offset });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/elevenlabs/calls/:conversation_id', async (req, res) => {
  try {
    const row = await store.getByConversationId(req.params.conversation_id);
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
    // strip bytea
    delete row.audio_bytes;
    res.json({ ok: true, call: row });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/elevenlabs/agents', async (req, res) => {
  try {
    const rows = await store.listAgentNames();
    res.json({ ok: true, agents: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Stream audio. Served under /api so the dashboard's bearer token applies.
// No Range support yet — MP3s are small (a minute or two per call) and the
// browser <audio> element handles full loads fine.
router.get('/elevenlabs/audio/:conversation_id', async (req, res) => {
  try {
    const row = await store.getAudioBytes(req.params.conversation_id);
    if (!row || !row.audio_bytes) return res.status(404).json({ ok: false, error: 'no_audio' });
    res.setHeader('Content-Type', row.audio_mime || 'audio/mpeg');
    res.setHeader('Content-Length', row.audio_bytes.length);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.end(row.audio_bytes);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Manual audio-retry button for the dashboard. Handy when ELEVENLABS_API_KEY
// was missing at the moment the webhook fired.
router.post('/elevenlabs/audio/:conversation_id/refetch', async (req, res) => {
  try {
    const r = await audio.fetchAndStore(req.params.conversation_id, {});
    if (r.ok && r.url) {
      await epHandler.finalizeEpRecording(req.params.conversation_id, r.url).catch(() => {});
    }
    res.json({ ok: r.ok, result: r });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
