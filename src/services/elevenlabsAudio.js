const axios = require('axios');
const store = require('./elevenlabsStore');
const logger = require('./logger');

// Audio storage decision: we stash the MP3 bytes in the Postgres bytea column
// `audio_bytes` (+ mime) rather than Railway volumes or GHL media. Reasons:
//   * Railway volumes need explicit mount config; if absent, files vanish on
//     redeploy. Storing in the DB matches the existing durability model for
//     every other piece of data in this app.
//   * GHL media upload returns a signed URL on a host we don't control; some
//     of those URLs eventually expire or move. We need the recording to be
//     available when Jeremiah films the VSL the *next* day minimum, and for
//     training/QC later.
//   * Volume per call is ~1-2 min MP3 = ~1-2MB. EP flow is low-volume by
//     design (lead-gen play, not a call center). If this grows an order of
//     magnitude we move to S3 — same interface, different backing.
// The dashboard plays audio via GET /api/elevenlabs/audio/:conversation_id
// which streams the bytes directly from Postgres.

const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io';

async function fetchConversationAudio(conversationId, apiKey) {
  const url = `${ELEVENLABS_API_BASE}/v1/convai/conversations/${encodeURIComponent(conversationId)}/audio`;
  const res = await axios.get(url, {
    headers: { 'xi-api-key': apiKey, Accept: 'audio/mpeg' },
    responseType: 'arraybuffer',
    timeout: 45000
  });
  const mime = res.headers['content-type'] || 'audio/mpeg';
  const bytes = Buffer.from(res.data);
  return { mime, bytes };
}

async function fetchAndStore(conversationId, { dryRun = false, baseUrl = '' } = {}) {
  if (dryRun) {
    logger.log('elevenlabs', 'info', conversationId, 'Audio fetch skipped (dryRun)', {});
    return { ok: true, dryRun: true };
  }
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    logger.log('elevenlabs', 'warn', conversationId, 'ELEVENLABS_API_KEY missing — cannot fetch audio', {});
    await store.setAudio(conversationId, { status: 'failed' });
    return { ok: false, reason: 'missing_api_key' };
  }
  try {
    const { mime, bytes } = await fetchConversationAudio(conversationId, apiKey);
    const localUrl = `/api/elevenlabs/audio/${encodeURIComponent(conversationId)}`;
    await store.setAudio(conversationId, { status: 'success', mime, bytes, url: localUrl });
    logger.log('elevenlabs', 'info', conversationId, 'Audio stored', { bytes: bytes.length, mime });
    return { ok: true, url: localUrl, bytes: bytes.length, mime };
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data ? Buffer.from(err.response.data).toString('utf8').slice(0, 400) : null;
    logger.log('elevenlabs', 'error', conversationId, 'Audio fetch failed', {
      status, body, error: err.message
    });
    await store.setAudio(conversationId, { status: 'failed' });
    return { ok: false, status, error: err.message };
  }
}

module.exports = { fetchAndStore, fetchConversationAudio };
