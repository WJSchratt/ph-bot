const crypto = require('crypto');
const express = require('express');
const logger = require('../services/logger');
const store = require('../services/elevenlabsStore');
const epHandler = require('../services/epHandler');
const audio = require('../services/elevenlabsAudio');
const { extractToken } = require('../services/auth');

const router = express.Router();

// ElevenLabs signature format:   t=<unix>,v0=<sha256_hex>
// Signed payload: `${t}.${rawBody}` — identical pattern to Stripe/LinkedIn
// and to ElevenLabs' own webhooks.constructEvent in @elevenlabs/elevenlabs-js.
// 30-minute replay window per ElevenLabs docs.
const MAX_SIG_AGE_SECS = 30 * 60;

function parseSigHeader(h) {
  if (!h || typeof h !== 'string') return {};
  return Object.fromEntries(
    h.split(',').map((p) => {
      const i = p.indexOf('=');
      return i === -1 ? [p.trim(), ''] : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    })
  );
}

function verifySignature(rawBody, header, secret) {
  if (!secret) return { ok: false, reason: 'server_missing_secret' };
  if (!header) return { ok: false, reason: 'missing_header' };
  const parts = parseSigHeader(header);
  const t = parts.t;
  const v0 = parts.v0;
  if (!t || !v0) return { ok: false, reason: 'malformed_header' };
  const ts = parseInt(t, 10);
  if (!ts || Number.isNaN(ts)) return { ok: false, reason: 'bad_timestamp' };
  const age = Math.floor(Date.now() / 1000) - ts;
  if (age > MAX_SIG_AGE_SECS) return { ok: false, reason: 'stale_signature' };
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || '', 'utf8');
  const mac = crypto.createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${t}.`, 'utf8'), body]))
    .digest('hex');
  try {
    const a = Buffer.from(mac, 'hex');
    const b = Buffer.from(v0, 'hex');
    if (a.length !== b.length) return { ok: false, reason: 'len_mismatch' };
    return { ok: crypto.timingSafeEqual(a, b), reason: 'mismatch' };
  } catch {
    return { ok: false, reason: 'hex_decode_error' };
  }
}

function isDryRunAuthorized(req) {
  if (req.query.dryRun !== '1') return false;
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) return false;
  const tok = extractToken(req);
  if (!tok) return false;
  try {
    const a = Buffer.from(tok);
    const b = Buffer.from(adminKey);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

async function processTranscriptPayload(body, { dryRun }) {
  const { data, type } = store.parsePayload(body);
  const row = store.extractRow(data);

  if (!row.conversation_id) {
    return { ok: false, reason: 'no_conversation_id' };
  }

  // Dedup: the PK on conversation_id + ON CONFLICT upsert makes retries idempotent.
  await store.upsertBase(row, body);

  const isEp = epHandler.isEpCall(row.agent_id, row.agent_name);
  let epResult = null;
  if (isEp) {
    try {
      epResult = await epHandler.processEpCall({
        payload: data,
        row,
        conversationId: row.conversation_id,
        dryRun
      });
    } catch (err) {
      logger.log('elevenlabs', 'error', row.conversation_id, 'EP handler threw', {
        error: err.message, stack: err.stack
      });
    }
  } else {
    // Non-EP agents: just store the row. GHL updates stay on the existing
    // Post-Call Router workflow (which doesn't need audio).
    logger.log('elevenlabs', 'info', row.conversation_id, 'Non-EP call stored (no GHL update)', {
      agent_name: row.agent_name
    });
  }

  // Audio fetch runs async after the 200 so we never exceed the ~10s ElevenLabs
  // retry timeout. Fire-and-forget: errors are captured in the row.
  if (row.has_audio) {
    setImmediate(async () => {
      const res = await audio.fetchAndStore(row.conversation_id, { dryRun });
      if (res.ok && res.url && isEp) {
        await epHandler.finalizeEpRecording(row.conversation_id, res.url).catch((err) => {
          logger.log('elevenlabs', 'error', row.conversation_id, 'finalizeEpRecording threw', {
            error: err.message
          });
        });
      }
    });
  }

  return { ok: true, conversation_id: row.conversation_id, is_ep: isEp, ep: epResult, type };
}

// Raw body parser is scoped to this handler so the server-global express.json()
// parser doesn't swallow the bytes we need for HMAC. We also keep the route
// mount OUTSIDE the /api/* requireAuth middleware (see server.js).
const rawJson = express.raw({ type: '*/*', limit: '10mb' });

router.post('/webhook', rawJson, async (req, res) => {
  const rawBody = req.body; // Buffer
  let parsed;
  try {
    parsed = JSON.parse((rawBody || Buffer.from('')).toString('utf8') || '{}');
  } catch (err) {
    logger.log('elevenlabs', 'warn', null, 'Webhook body was not JSON', { error: err.message });
    return res.status(400).json({ error: 'invalid_json' });
  }

  const dryRunAllowed = isDryRunAuthorized(req);
  const sigHeader = req.get('ElevenLabs-Signature') || req.get('elevenlabs-signature');

  if (!dryRunAllowed) {
    const check = verifySignature(rawBody, sigHeader, process.env.ELEVENLABS_WEBHOOK_SECRET);
    if (!check.ok) {
      logger.log('elevenlabs', 'warn', null, 'Webhook signature rejected', { reason: check.reason });
      return res.status(401).json({ error: 'signature_invalid', reason: check.reason });
    }
  }

  // Return 200 fast. ElevenLabs auto-disables the webhook after 10 consecutive
  // failures, so we acknowledge immediately and kick real work into setImmediate.
  const type = parsed.type || 'post_call_transcription';

  if (type === 'post_call_audio') {
    // We pull audio via the REST API after the transcript event; the streaming
    // chunked-audio webhook is not used yet. Ack and move on.
    logger.log('elevenlabs', 'info', parsed.data?.conversation_id || null, 'post_call_audio webhook acknowledged (skipped)', {});
    return res.status(200).json({ ok: true, skipped: 'post_call_audio' });
  }

  // Respond immediately, process async.
  res.status(200).json({ ok: true, received: true, dryRun: dryRunAllowed });

  try {
    const out = await processTranscriptPayload(parsed, { dryRun: dryRunAllowed });
    if (!out.ok) {
      logger.log('elevenlabs', 'warn', null, 'Webhook processing returned not-ok', out);
    }
  } catch (err) {
    logger.log('elevenlabs', 'error', null, 'Webhook processing threw', {
      error: err.message, stack: err.stack
    });
  }
});

// Synchronous variant for tests/dry runs: blocks until processing finishes so
// the test script can assert on the end state. Only available when dryRun=1 +
// ADMIN_API_KEY. Identical payload handling otherwise.
router.post('/webhook/sync', rawJson, async (req, res) => {
  if (!isDryRunAuthorized(req)) {
    return res.status(401).json({ error: 'dryrun_auth_required' });
  }
  let parsed;
  try {
    parsed = JSON.parse((req.body || Buffer.from('')).toString('utf8') || '{}');
  } catch (err) {
    return res.status(400).json({ error: 'invalid_json' });
  }
  try {
    const out = await processTranscriptPayload(parsed, { dryRun: true });
    return res.status(200).json(out);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
