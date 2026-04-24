const express = require('express');
const axios = require('axios');
const store = require('../services/elevenlabsStore');
const audio = require('../services/elevenlabsAudio');
const epHandler = require('../services/epHandler');
const logger = require('../services/logger');

const router = express.Router();

const EL_BASE = 'https://api.elevenlabs.io';
const BACKFILL_PAGE_SIZE = 100;
const BACKFILL_SLEEP_MS = 300;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Backfill historical ElevenLabs calls into the DB by polling the
// Conversations API. Runs async — responds immediately with a job summary
// once the fetch loop finishes. Cap at 90 days max.
router.post('/elevenlabs/backfill', async (req, res) => {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return res.status(500).json({ ok: false, error: 'ELEVENLABS_API_KEY not set' });

  const daysBack = Math.min(parseInt(req.body?.daysBack, 10) || 14, 90);
  const dryRun = !!req.body?.dryRun;
  const sinceTs = Math.floor((Date.now() - daysBack * 24 * 60 * 60 * 1000) / 1000);

  const headers = { 'xi-api-key': apiKey };
  let cursor = null;
  let fetched = 0;
  let inserted = 0;
  let skipped = 0;
  let epCount = 0;
  let audioQueued = 0;
  const errors = [];

  try {
    while (true) {
      const params = {
        page_size: BACKFILL_PAGE_SIZE,
        call_start_after_unix_timestamp: sinceTs
      };
      if (cursor) params.cursor = cursor;

      const listRes = await axios.get(`${EL_BASE}/v1/convai/conversations`, { headers, params, timeout: 20000 });
      const convList = listRes.data?.conversations || [];
      if (!convList.length) break;

      for (const summary of convList) {
        fetched++;
        const convId = summary.conversation_id;
        if (!convId) continue;

        // Skip if already stored
        try {
          const existing = await store.getByConversationId(convId);
          if (existing) { skipped++; continue; }
        } catch {}

        // Fetch full detail (transcript + analysis)
        let detail;
        try {
          const detailRes = await axios.get(`${EL_BASE}/v1/convai/conversations/${convId}`, { headers, timeout: 20000 });
          detail = detailRes.data;
        } catch (err) {
          errors.push({ convId, error: err.message });
          logger.log('elevenlabs', 'warn', convId, 'Backfill detail fetch failed', { error: err.message });
          continue;
        }

        // Wrap in the same envelope the webhook uses, then process
        const body = { type: 'post_call_transcription', data: detail };
        const row = store.extractRow(detail);
        if (!row.conversation_id) continue;

        if (!dryRun) await store.upsertBase(row, body);
        inserted++;

        const isEp = epHandler.isEpCall(row.agent_id, row.agent_name);
        if (isEp) {
          epCount++;
          if (!dryRun) {
            try {
              await epHandler.processEpCall({ payload: detail, row, conversationId: convId, dryRun: false });
            } catch (err) {
              errors.push({ convId, error: `EP handler: ${err.message}` });
              logger.log('elevenlabs', 'error', convId, 'Backfill EP handler failed', { error: err.message });
            }
          }
        }

        if (row.has_audio && !dryRun) {
          audioQueued++;
          audio.fetchAndStore(convId, {}).then((r) => {
            if (r.ok && r.url && isEp) epHandler.finalizeEpRecording(convId, r.url).catch(() => {});
          }).catch(() => {});
        }

        await sleep(BACKFILL_SLEEP_MS);
      }

      if (!listRes.data?.has_more) break;
      cursor = listRes.data?.next_cursor;
      if (!cursor) break;
    }

    logger.log('elevenlabs', 'info', null, 'Backfill complete', { daysBack, fetched, inserted, skipped, epCount, audioQueued, errors: errors.length });
    res.json({ ok: true, daysBack, sinceDate: new Date(sinceTs * 1000).toISOString(), fetched, inserted, skipped, epCount, audioQueued, errors: errors.slice(0, 20) });
  } catch (err) {
    logger.log('elevenlabs', 'error', null, 'Backfill failed', { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

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
