const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db');
const logger = require('../services/logger');
const standardPrompt = require('../prompts/standard');
const ghlConv = require('../services/ghlConversations');

const router = express.Router();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const ANALYZE_CACHE_TTL_MS = 60 * 60 * 1000;
let analyzeCache = { ts: 0, result: null };

const promptHistory = [];
const MAX_PROMPT_HISTORY = 10;

// In-memory cache of pulled GHL conversations keyed by locationId
const pulledDataCache = {};
const pullProgress = {};

function parseBotpressHistory(text) {
  if (!text || typeof text !== 'string') return [];
  const parts = [];
  const regex = /(User|Bot):\s*/gi;
  const tokens = text.split(regex).filter((t) => t !== undefined);
  let currentRole = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^(user|bot)$/i.test(t)) {
      currentRole = t.toLowerCase() === 'bot' ? 'assistant' : 'user';
    } else if (currentRole && t.trim()) {
      parts.push({ role: currentRole, content: t.trim() });
    }
  }
  return parts;
}

function looksLikeCompletion(text) {
  if (!text) return false;
  const low = text.toLowerCase();
  return /(perfect.*booked|you're booked|confirmed for|scheduled|removing you from our list|take care|opt out)/i.test(low);
}

router.get('/stats', async (req, res) => {
  try {
    const claudeStats = await db.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE terminal_outcome IS NOT NULL)::int AS completed,
        COUNT(*) FILTER (WHERE terminal_outcome = 'appointment_booked')::int AS booked,
        COUNT(*) FILTER (WHERE terminal_outcome = 'dnc')::int AS dnc,
        COUNT(*) FILTER (WHERE terminal_outcome = 'human_handoff')::int AS handoff,
        COALESCE(AVG(jsonb_array_length(messages)), 0)::float AS avg_messages
      FROM conversations
      WHERE is_sandbox = FALSE
    `);

    const outcomeRows = await db.query(`
      SELECT terminal_outcome, COUNT(*)::int AS count
      FROM conversations
      WHERE terminal_outcome IS NOT NULL AND is_sandbox = FALSE
      GROUP BY terminal_outcome
      ORDER BY count DESC
    `);

    const bpRows = await db.query(`
      SELECT id, contact_id, botpress_history, terminal_outcome
      FROM conversations
      WHERE botpress_history IS NOT NULL AND botpress_history <> ''
    `);

    let bpTotal = 0;
    let bpCompleted = 0;
    let totalExchanges = 0;
    const bpOutcomeMap = {};
    for (const r of bpRows.rows) {
      bpTotal++;
      const parsed = parseBotpressHistory(r.botpress_history);
      totalExchanges += parsed.length;
      const lastBot = [...parsed].reverse().find((p) => p.role === 'assistant');
      if (lastBot && looksLikeCompletion(lastBot.content)) {
        bpCompleted++;
        bpOutcomeMap.likely_booked = (bpOutcomeMap.likely_booked || 0) + 1;
      } else {
        bpOutcomeMap.incomplete = (bpOutcomeMap.incomplete || 0) + 1;
      }
    }

    const claude = claudeStats.rows[0] || {};
    res.json({
      claude: {
        total: claude.total || 0,
        completed: claude.completed || 0,
        booked: claude.booked || 0,
        dnc: claude.dnc || 0,
        handoff: claude.handoff || 0,
        completion_rate: claude.total ? (claude.completed / claude.total) : 0,
        avg_messages: claude.avg_messages || 0,
        outcomes: outcomeRows.rows
      },
      botpress: {
        total: bpTotal,
        completed: bpCompleted,
        completion_rate: bpTotal ? (bpCompleted / bpTotal) : 0,
        avg_exchanges: bpTotal ? (totalExchanges / bpTotal) : 0,
        outcomes: Object.entries(bpOutcomeMap).map(([outcome, count]) => ({ outcome, count }))
      }
    });
  } catch (err) {
    logger.log('analyzer', 'error', null, 'stats failed', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

router.get('/conversations', async (req, res) => {
  try {
    const botType = (req.query.bot_type || 'claude').toLowerCase();
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const outcome = req.query.outcome || null;

    if (botType === 'botpress') {
      const q = await db.query(
        `SELECT id, contact_id, first_name, last_name, location_id, product_type, terminal_outcome, created_at, botpress_history
         FROM conversations
         WHERE botpress_history IS NOT NULL AND botpress_history <> ''
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      const rows = q.rows.map((r) => {
        const parsed = parseBotpressHistory(r.botpress_history);
        return {
          id: r.id,
          bot_type: 'botpress',
          contact_id: r.contact_id,
          first_name: r.first_name,
          last_name: r.last_name,
          location_id: r.location_id,
          product_type: r.product_type,
          terminal_outcome: r.terminal_outcome,
          created_at: r.created_at,
          message_count: parsed.length
        };
      });
      return res.json({ conversations: rows });
    }

    const where = ['is_sandbox = FALSE', `jsonb_array_length(messages) > 0`];
    const params = [];
    if (outcome) {
      params.push(outcome);
      where.push(`terminal_outcome = $${params.length}`);
    }
    params.push(limit);
    params.push(offset);
    const q = await db.query(
      `SELECT id, contact_id, first_name, last_name, location_id, product_type, terminal_outcome, created_at,
              jsonb_array_length(messages)::int AS message_count,
              input_tokens, output_tokens
       FROM conversations
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const rows = q.rows.map((r) => ({ ...r, bot_type: 'claude' }));
    res.json({ conversations: rows });
  } catch (err) {
    logger.log('analyzer', 'error', null, 'list failed', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

router.get('/conversation/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const botType = (req.query.bot_type || 'claude').toLowerCase();
    const q = await db.query(
      `SELECT id, contact_id, first_name, last_name, location_id, product_type, terminal_outcome,
              created_at, messages, botpress_history, input_tokens, output_tokens,
              collected_age, collected_smoker, collected_health, collected_appointment_time
       FROM conversations WHERE id = $1`,
      [id]
    );
    if (!q.rows[0]) return res.status(404).json({ error: 'not found' });
    const conv = q.rows[0];

    if (botType === 'botpress') {
      const parsed = parseBotpressHistory(conv.botpress_history);
      return res.json({
        conversation: {
          ...conv,
          bot_type: 'botpress',
          message_count: parsed.length
        },
        messages: parsed.map((p) => ({
          direction: p.role === 'assistant' ? 'outbound' : 'inbound',
          content: p.content
        }))
      });
    }

    const msgQ = await db.query(
      `SELECT id, direction, content, message_type, created_at, got_reply, reply_time_seconds
       FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [id]
    );
    res.json({
      conversation: { ...conv, bot_type: 'claude', message_count: msgQ.rows.length },
      messages: msgQ.rows
    });
  } catch (err) {
    logger.log('analyzer', 'error', null, 'detail failed', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

async function fetchConversationSamples(limit = 8) {
  const claudeQ = await db.query(
    `SELECT first_name, last_name, product_type, terminal_outcome, messages
     FROM conversations
     WHERE is_sandbox = FALSE AND jsonb_array_length(messages) > 2
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  const botpressQ = await db.query(
    `SELECT first_name, last_name, product_type, terminal_outcome, botpress_history
     FROM conversations
     WHERE botpress_history IS NOT NULL AND botpress_history <> ''
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return { claude: claudeQ.rows, botpress: botpressQ.rows };
}

function serializeMessages(messages) {
  if (!Array.isArray(messages)) return '';
  return messages.slice(0, 30).map((m) => `[${m.role === 'assistant' ? 'BOT' : 'USER'}] ${typeof m.content === 'string' ? m.content.slice(0, 500) : ''}`).join('\n');
}

function serializeBotpress(history) {
  const parsed = parseBotpressHistory(history);
  return parsed.map((p) => `[${p.role === 'assistant' ? 'BOT' : 'USER'}] ${p.content.slice(0, 500)}`).join('\n');
}

router.post('/analyze', async (req, res) => {
  try {
    if (analyzeCache.result && (Date.now() - analyzeCache.ts) < ANALYZE_CACHE_TTL_MS) {
      return res.json({ ...analyzeCache.result, cached: true, cached_age_ms: Date.now() - analyzeCache.ts });
    }

    const samples = await fetchConversationSamples(6);
    const claudeBlocks = samples.claude.map((c, i) => `=== CLAUDE CONVERSATION ${i + 1} (outcome: ${c.terminal_outcome || 'open'}, product: ${c.product_type || '?'}) ===\n${serializeMessages(c.messages)}`).join('\n\n');
    const bpBlocks = samples.botpress.map((c, i) => `=== BOTPRESS CONVERSATION ${i + 1} (outcome: ${c.terminal_outcome || 'open'}, product: ${c.product_type || '?'}) ===\n${serializeBotpress(c.botpress_history)}`).join('\n\n');

    const userContent = `Compare these two SMS qualification bot implementations handling real insurance leads.

## CLAUDE BOT CONVERSATIONS (${samples.claude.length})
${claudeBlocks || '(none)'}

## BOTPRESS CONVERSATIONS (${samples.botpress.length})
${bpBlocks || '(none)'}

Provide a structured analysis:
1. Overall performance comparison (which bot converts better, which is more natural)
2. Claude bot drop-off points (where leads disengage)
3. What Claude bot does better than Botpress
4. What Botpress does better than Claude bot
5. Specific, actionable prompt improvements for the Claude bot (with exact suggested phrasing)

Keep it under 2000 words. Use clear section headers.`;

    const resp = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 3000,
      system: 'You are a conversational AI quality analyst. You compare two bot implementations against real conversations and produce actionable findings. Be specific, cite examples, and recommend concrete prompt changes.',
      messages: [{ role: 'user', content: userContent }]
    });

    const textBlock = resp.content.find((b) => b.type === 'text');
    const analysis = textBlock ? textBlock.text : '';
    const result = {
      analysis,
      sample_counts: { claude: samples.claude.length, botpress: samples.botpress.length },
      input_tokens: resp.usage?.input_tokens || 0,
      output_tokens: resp.usage?.output_tokens || 0,
      generated_at: new Date().toISOString()
    };
    analyzeCache = { ts: Date.now(), result };
    res.json({ ...result, cached: false });
  } catch (err) {
    logger.log('analyzer', 'error', null, 'analyze failed', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

async function getCurrentPrompt() {
  try {
    const q = await db.query(
      `SELECT value FROM app_settings WHERE section = 'analyzer_prompt' AND key = 'current'`
    );
    if (q.rows[0] && q.rows[0].value) return q.rows[0].value;
  } catch {}
  return standardPrompt;
}

async function saveCurrentPrompt(text) {
  await db.query(
    `INSERT INTO app_settings (section, key, value, updated_at)
     VALUES ('analyzer_prompt', 'current', $1, NOW())
     ON CONFLICT (section, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [text]
  );
}

router.get('/prompt', async (req, res) => {
  try {
    const current = await getCurrentPrompt();
    res.json({
      prompt: current,
      is_default: current === standardPrompt,
      history: promptHistory.map((p) => ({ savedAt: p.savedAt, preview: p.text.slice(0, 120) }))
    });
  } catch (err) {
    logger.log('analyzer', 'error', null, 'get prompt failed', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

router.post('/prompt', async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'prompt is required' });
    }
    const previous = await getCurrentPrompt();
    promptHistory.unshift({ text: previous, savedAt: new Date().toISOString() });
    while (promptHistory.length > MAX_PROMPT_HISTORY) promptHistory.pop();
    await saveCurrentPrompt(prompt);
    res.json({ ok: true, history_size: promptHistory.length });
  } catch (err) {
    logger.log('analyzer', 'error', null, 'save prompt failed', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

router.post('/prompt/revert', async (req, res) => {
  try {
    const index = parseInt(req.body?.index, 10);
    if (!Number.isFinite(index) || index < 0 || index >= promptHistory.length) {
      return res.status(400).json({ error: 'invalid history index' });
    }
    const target = promptHistory[index];
    const current = await getCurrentPrompt();
    promptHistory.unshift({ text: current, savedAt: new Date().toISOString() });
    while (promptHistory.length > MAX_PROMPT_HISTORY) promptHistory.pop();
    await saveCurrentPrompt(target.text);
    res.json({ ok: true, reverted_to: target.savedAt });
  } catch (err) {
    logger.log('analyzer', 'error', null, 'revert failed', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

router.post('/generate-prompt', async (req, res) => {
  try {
    const { current_prompt, change_description } = req.body || {};
    if (!change_description) return res.status(400).json({ error: 'change_description is required' });
    const base = current_prompt || (await getCurrentPrompt());

    const samples = await fetchConversationSamples(4);
    const sampleText = [
      ...samples.claude.map((c, i) => `=== CLAUDE SAMPLE ${i + 1} ===\n${serializeMessages(c.messages)}`),
      ...samples.botpress.map((c, i) => `=== BOTPRESS SAMPLE ${i + 1} ===\n${serializeBotpress(c.botpress_history)}`)
    ].join('\n\n');

    const resp = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      system: `You are a prompt engineer rewriting an SMS bot system prompt. Apply the requested changes precisely while preserving the existing structure, tone rules, and JSON response format. Output ONLY the full revised prompt text with no markdown fences, no commentary, no "here is the updated prompt" preamble.`,
      messages: [
        {
          role: 'user',
          content: `CURRENT SYSTEM PROMPT:\n\n${base}\n\n---\n\nREQUESTED CHANGES:\n${change_description}\n\n---\n\nREAL CONVERSATION SAMPLES (for context on how the bot currently behaves):\n${sampleText}\n\n---\n\nRewrite the full system prompt with the requested changes applied. Preserve anything that wasn't asked to change.`
        }
      ]
    });
    const textBlock = resp.content.find((b) => b.type === 'text');
    const generated = textBlock ? textBlock.text : '';
    res.json({
      generated_prompt: generated,
      input_tokens: resp.usage?.input_tokens || 0,
      output_tokens: resp.usage?.output_tokens || 0
    });
  } catch (err) {
    logger.log('analyzer', 'error', null, 'generate-prompt failed', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// ============================================================
// GHL PULL: background job that fetches all convos for a location
// ============================================================

async function findGhlTokenForLocation(locationId) {
  try {
    const fromSub = await db.query(
      `SELECT ghl_api_key FROM subaccounts WHERE ghl_location_id = $1 AND ghl_api_key IS NOT NULL AND ghl_api_key <> ''`,
      [locationId]
    );
    if (fromSub.rows[0]?.ghl_api_key) return fromSub.rows[0].ghl_api_key;
  } catch {}
  try {
    const fromConv = await db.query(
      `SELECT ghl_token FROM conversations
       WHERE location_id = $1 AND ghl_token IS NOT NULL AND ghl_token <> ''
       ORDER BY updated_at DESC LIMIT 1`,
      [locationId]
    );
    if (fromConv.rows[0]?.ghl_token) return fromConv.rows[0].ghl_token;
  } catch {}
  return null;
}

function extractTextFromGhlMessage(m) {
  return String(m.body || m.message || m.content || '').trim();
}

function countNonEmptyMessages(messages) {
  return (messages || []).filter((m) => extractTextFromGhlMessage(m)).length;
}

function isSmsMessage(m) {
  const mt = String(m.messageType || m.type || '').toUpperCase();
  if (!mt) return true;
  return mt.includes('SMS') || mt === '1' || mt === '2';
}

async function loadLocalContactIdsForLocation(locationId) {
  try {
    const q = await db.query(
      `SELECT DISTINCT contact_id FROM conversations WHERE location_id = $1 AND is_sandbox = FALSE`,
      [locationId]
    );
    return new Set(q.rows.map((r) => r.contact_id).filter(Boolean));
  } catch {
    return new Set();
  }
}

function buildSourceStats(conversations, sourceFilter) {
  const subset = sourceFilter === 'all'
    ? conversations
    : conversations.filter((c) => c.source === sourceFilter);
  let completed = 0;
  let totalMsgs = 0;
  const outcomes = {};
  for (const c of subset) {
    totalMsgs += c.message_count || 0;
    if (c.completed) completed++;
    const out = c.outcome || 'incomplete';
    outcomes[out] = (outcomes[out] || 0) + 1;
  }
  const count = subset.length;
  return {
    count,
    completed,
    completion_rate: count ? completed / count : 0,
    avg_messages: count ? totalMsgs / count : 0,
    outcomes
  };
}

function summarizeConversation(conv, msgs, classification) {
  const filtered = (msgs || []).filter(isSmsMessage);
  const terminal = ghlConv.detectTerminalOutcome(filtered);
  let completed = false;
  let outcome = terminal || 'incomplete';
  if (classification.source === 'claude') {
    completed = !!terminal;
  } else if (classification.source === 'botpress') {
    completed = ghlConv.isBotpressCompleted(filtered);
    if (!terminal && completed) outcome = 'likely_booked';
  } else {
    completed = !!terminal;
  }

  const contactName = conv.contactName || conv.fullName || [conv.contactFirstName, conv.contactLastName].filter(Boolean).join(' ') || '';

  return {
    id: conv.id,
    contactId: conv.contactId,
    locationId: conv.locationId,
    contactName: contactName.trim(),
    phone: conv.phone || conv.contactPhone || '',
    lastMessageDate: conv.lastMessageDate || (Array.isArray(conv.sort) && conv.sort[0]) || null,
    source: classification.source,
    reason: classification.reason,
    message_count: filtered.length,
    completed,
    outcome,
    messages: filtered.map((m) => ({
      id: m.id,
      direction: m.direction || 'unknown',
      body: extractTextFromGhlMessage(m),
      dateAdded: m.dateAdded || m.created || null,
      messageType: m.messageType || m.type || null
    }))
  };
}

async function runPullJob(locationId, ghlToken) {
  pullProgress[locationId] = {
    status: 'pulling',
    stage: 'conversations',
    fetched: 0,
    total: 0,
    messages_fetched: 0,
    started_at: new Date().toISOString(),
    error: null
  };

  try {
    logger.log('analyzer', 'info', null, 'Pulling GHL conversations', { locationId });

    const convs = await ghlConv.pullAllConversations(ghlToken, locationId, ({ fetched }) => {
      pullProgress[locationId].fetched = fetched;
    });
    pullProgress[locationId].total = convs.length;
    pullProgress[locationId].stage = 'messages';

    const localIds = await loadLocalContactIdsForLocation(locationId);

    const out = [];
    for (let i = 0; i < convs.length; i++) {
      const c = convs[i];
      let msgs = [];
      try {
        msgs = await ghlConv.pullMessages(ghlToken, c.id);
      } catch (err) {
        msgs = [];
      }
      const filtered = msgs.filter(isSmsMessage);
      const classification = ghlConv.classifyConversation(c, filtered, localIds);
      const summary = summarizeConversation(c, filtered, classification);
      out.push(summary);

      pullProgress[locationId].messages_fetched = i + 1;
      if (ghlConv.MSG_RATE_SLEEP_MS) await ghlConv.sleep(ghlConv.MSG_RATE_SLEEP_MS);
    }

    const stats = {
      total: out.length,
      claude: buildSourceStats(out, 'claude'),
      botpress: buildSourceStats(out, 'botpress'),
      other: buildSourceStats(out, 'other'),
      combined: buildSourceStats(out, 'all')
    };

    pulledDataCache[locationId] = {
      conversations: out,
      pulled_at: Date.now(),
      stats
    };

    pullProgress[locationId] = {
      status: 'complete',
      stage: 'done',
      fetched: out.length,
      total: out.length,
      messages_fetched: out.length,
      started_at: pullProgress[locationId].started_at,
      completed_at: new Date().toISOString(),
      counts: {
        claude: stats.claude.count,
        botpress: stats.botpress.count,
        other: stats.other.count
      }
    };

    logger.log('analyzer', 'info', null, 'GHL pull complete', {
      locationId,
      total: out.length,
      claude: stats.claude.count,
      botpress: stats.botpress.count,
      other: stats.other.count
    });
  } catch (err) {
    pullProgress[locationId] = {
      ...(pullProgress[locationId] || {}),
      status: 'error',
      error: err.message,
      completed_at: new Date().toISOString()
    };
    logger.log('analyzer', 'error', null, 'Pull job failed', { locationId, error: err.message, stack: err.stack });
  }
}

router.post('/pull', async (req, res) => {
  try {
    const locationId = req.body?.locationId;
    if (!locationId) return res.status(400).json({ error: 'locationId is required' });

    let token = req.body?.ghlToken || null;
    if (!token) token = await findGhlTokenForLocation(locationId);
    if (!token) {
      return res.status(400).json({ error: 'No GHL token found for this location. Provide ghlToken, or add one under Settings → Subaccounts.' });
    }

    if (pullProgress[locationId]?.status === 'pulling') {
      return res.json({ status: 'pulling', locationId, progress: pullProgress[locationId] });
    }

    runPullJob(locationId, token).catch((err) => {
      logger.log('analyzer', 'error', null, 'runPullJob unhandled', { locationId, error: err.message, stack: err.stack });
    });

    res.json({ status: 'pulling', locationId, startedAt: new Date().toISOString() });
  } catch (err) {
    logger.log('analyzer', 'error', null, 'pull dispatch failed', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

router.get('/pull-status', (req, res) => {
  const locationId = req.query.locationId;
  if (!locationId) return res.status(400).json({ error: 'locationId required' });
  const progress = pullProgress[locationId] || { status: 'idle' };
  const cache = pulledDataCache[locationId];
  res.json({
    locationId,
    progress,
    pulled_at: cache?.pulled_at || null,
    counts: cache ? {
      total: cache.stats.total,
      claude: cache.stats.claude.count,
      botpress: cache.stats.botpress.count,
      other: cache.stats.other.count
    } : null
  });
});

router.get('/pulled-stats', (req, res) => {
  const locationId = req.query.locationId;
  if (!locationId) return res.status(400).json({ error: 'locationId required' });
  const cache = pulledDataCache[locationId];
  if (!cache) return res.status(404).json({ error: 'no pulled data for this location — run /pull first' });
  res.json({
    locationId,
    pulled_at: cache.pulled_at,
    stats: cache.stats
  });
});

router.get('/pulled-conversations', (req, res) => {
  const locationId = req.query.locationId;
  if (!locationId) return res.status(400).json({ error: 'locationId required' });
  const cache = pulledDataCache[locationId];
  if (!cache) return res.status(404).json({ error: 'no pulled data' });

  const source = (req.query.source || 'all').toLowerCase();
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
  const offset = parseInt(req.query.offset, 10) || 0;
  const search = (req.query.search || '').toLowerCase();

  let list = cache.conversations;
  if (source !== 'all') list = list.filter((c) => c.source === source);
  if (search) {
    list = list.filter((c) => `${c.contactName || ''} ${c.phone || ''}`.toLowerCase().includes(search));
  }

  const total = list.length;
  const page = list.slice(offset, offset + limit).map((c) => ({
    id: c.id,
    contactId: c.contactId,
    contactName: c.contactName,
    phone: c.phone,
    lastMessageDate: c.lastMessageDate,
    source: c.source,
    message_count: c.message_count,
    completed: c.completed,
    outcome: c.outcome
  }));
  res.json({ locationId, source, total, conversations: page });
});

router.get('/pulled-conversation/:conversationId', (req, res) => {
  const locationId = req.query.locationId;
  if (!locationId) return res.status(400).json({ error: 'locationId required' });
  const cache = pulledDataCache[locationId];
  if (!cache) return res.status(404).json({ error: 'no pulled data' });
  const conv = cache.conversations.find((c) => c.id === req.params.conversationId);
  if (!conv) return res.status(404).json({ error: 'conversation not in cache' });
  res.json({ conversation: conv });
});

// ============================================================
// Override /analyze and /generate-prompt to use pulled cache when locationId given
// ============================================================

function serializePulledConversation(c, maxLen = 500) {
  return (c.messages || []).slice(0, 30).map((m) => `[${m.direction === 'outbound' ? 'BOT' : 'USER'}] ${String(m.body || '').slice(0, maxLen)}`).join('\n');
}

function samplePulled(cache, source, count) {
  if (!cache) return [];
  const list = source === 'all'
    ? cache.conversations
    : cache.conversations.filter((c) => c.source === source);
  const incomplete = list.filter((c) => !c.completed);
  const completed = list.filter((c) => c.completed);
  const picked = [];
  for (let i = 0; i < count; i++) {
    if (i % 2 === 0 && incomplete.length) picked.push(incomplete.shift());
    else if (completed.length) picked.push(completed.shift());
    else if (incomplete.length) picked.push(incomplete.shift());
    else break;
  }
  return picked;
}

router.post('/analyze-pulled', async (req, res) => {
  try {
    const { locationId, source } = req.body || {};
    if (!locationId) return res.status(400).json({ error: 'locationId required' });
    const cache = pulledDataCache[locationId];
    if (!cache) return res.status(404).json({ error: 'no pulled data — run /pull first' });

    const filterSource = (source || 'all').toLowerCase();

    let userContent;
    if (filterSource === 'all') {
      const claudeSamples = samplePulled(cache, 'claude', 5);
      const bpSamples = samplePulled(cache, 'botpress', 5);
      const claudeBlocks = claudeSamples.map((c, i) => `=== CLAUDE #${i + 1} (${c.outcome}, ${c.message_count} msgs) ===\n${serializePulledConversation(c)}`).join('\n\n');
      const bpBlocks = bpSamples.map((c, i) => `=== BOTPRESS #${i + 1} (${c.outcome}, ${c.message_count} msgs) ===\n${serializePulledConversation(c)}`).join('\n\n');
      userContent = `Compare these two SMS qualification bot implementations on real production conversations for GHL location ${locationId}.

## Stats (this pull)
- Total: ${cache.stats.total}
- Claude: ${cache.stats.claude.count} (completion ${(cache.stats.claude.completion_rate * 100).toFixed(1)}%)
- BotPress: ${cache.stats.botpress.count} (completion ${(cache.stats.botpress.completion_rate * 100).toFixed(1)}%)
- Other: ${cache.stats.other.count}

## CLAUDE CONVERSATIONS (${claudeSamples.length})
${claudeBlocks || '(none)'}

## BOTPRESS CONVERSATIONS (${bpSamples.length})
${bpBlocks || '(none)'}

Produce a structured analysis (<2000 words):
1. Performance comparison (which bot converts better, naturalness)
2. Claude bot drop-off points
3. What Claude does better / worse than BotPress
4. Specific prompt improvements with exact phrasing`;
    } else {
      const samples = samplePulled(cache, filterSource, 10);
      const blocks = samples.map((c, i) => `=== ${filterSource.toUpperCase()} #${i + 1} (${c.outcome}, ${c.message_count} msgs) ===\n${serializePulledConversation(c)}`).join('\n\n');
      const stats = cache.stats[filterSource] || { count: 0, completion_rate: 0, avg_messages: 0 };
      userContent = `Analyze these ${filterSource} bot conversations for GHL location ${locationId}.

## Stats
- Count: ${stats.count}
- Completion rate: ${(stats.completion_rate * 100).toFixed(1)}%
- Avg messages: ${stats.avg_messages.toFixed(1)}

## CONVERSATIONS
${blocks || '(none)'}

Produce a focused analysis (<1500 words):
1. Common drop-off points
2. Response quality issues
3. Specific improvements with exact phrasing`;
    }

    const resp = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 3000,
      system: 'You are a conversational AI quality analyst. Be specific, cite examples, and recommend concrete prompt changes.',
      messages: [{ role: 'user', content: userContent }]
    });
    const textBlock = resp.content.find((b) => b.type === 'text');
    res.json({
      analysis: textBlock ? textBlock.text : '',
      source: filterSource,
      locationId,
      pulled_at: cache.pulled_at,
      sample_counts: filterSource === 'all'
        ? { claude: Math.min(cache.stats.claude.count, 5), botpress: Math.min(cache.stats.botpress.count, 5) }
        : { [filterSource]: Math.min(cache.stats[filterSource].count, 10) },
      input_tokens: resp.usage?.input_tokens || 0,
      output_tokens: resp.usage?.output_tokens || 0,
      generated_at: new Date().toISOString()
    });
  } catch (err) {
    logger.log('analyzer', 'error', null, 'analyze-pulled failed', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

router.post('/generate-prompt-pulled', async (req, res) => {
  try {
    const { current_prompt, change_description, locationId, source } = req.body || {};
    if (!change_description) return res.status(400).json({ error: 'change_description required' });
    const base = current_prompt || (await getCurrentPrompt());

    let sampleText = '';
    if (locationId && pulledDataCache[locationId]) {
      const cache = pulledDataCache[locationId];
      const filterSource = (source || 'all').toLowerCase();
      const samples = filterSource === 'all'
        ? [...samplePulled(cache, 'claude', 3), ...samplePulled(cache, 'botpress', 3)]
        : samplePulled(cache, filterSource, 6);
      sampleText = samples.map((c, i) => `=== SAMPLE #${i + 1} (${c.source}, ${c.outcome}) ===\n${serializePulledConversation(c)}`).join('\n\n');
    }

    const resp = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      system: `You are a prompt engineer rewriting an SMS bot system prompt. Apply the requested changes precisely while preserving the existing structure, tone rules, and JSON response format. Output ONLY the full revised prompt text with no markdown fences, no commentary, no preamble.`,
      messages: [
        {
          role: 'user',
          content: `CURRENT SYSTEM PROMPT:\n\n${base}\n\n---\n\nREQUESTED CHANGES:\n${change_description}\n\n---\n\nREAL CONVERSATION SAMPLES (prioritized: incomplete / drop-offs) to inform the rewrite:\n${sampleText || '(no samples available — rely solely on the requested changes)'}\n\n---\n\nRewrite the full system prompt with the requested changes applied. Preserve anything not asked to change.`
        }
      ]
    });
    const textBlock = resp.content.find((b) => b.type === 'text');
    res.json({
      generated_prompt: textBlock ? textBlock.text : '',
      input_tokens: resp.usage?.input_tokens || 0,
      output_tokens: resp.usage?.output_tokens || 0,
      samples_used: sampleText ? sampleText.length : 0
    });
  } catch (err) {
    logger.log('analyzer', 'error', null, 'generate-prompt-pulled failed', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

module.exports = router;
