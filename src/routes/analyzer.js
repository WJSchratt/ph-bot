const express = require('express');
const db = require('../db');
const logger = require('../services/logger');
const standardPrompt = require('../prompts/standard');
const ghlConv = require('../services/ghlConversations');
const { callAnthropic } = require('../services/anthropic');

const router = express.Router();

const ANALYZE_CACHE_TTL_MS = 60 * 60 * 1000;
let analyzeCache = { ts: 0, result: null };

const promptHistory = [];
const MAX_PROMPT_HISTORY = 10;

// Pull progress is in-memory (ephemeral); actual pulled data lives in Postgres.
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

    const resp = await callAnthropic(
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 3000,
        system: 'You are a conversational AI quality analyst. You compare two bot implementations against real conversations and produce actionable findings. Be specific, cite examples, and recommend concrete prompt changes.',
        messages: [{ role: 'user', content: userContent }]
      },
      {
        category: 'analyzer_analysis',
        location_id: null,
        meta: { scope: 'cross_account', claude_samples: samples.claude.length, botpress_samples: samples.botpress.length }
      }
    );

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

    const resp = await callAnthropic(
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8000,
        system: `You are a prompt engineer rewriting an SMS bot system prompt. Apply the requested changes precisely while preserving the existing structure, tone rules, and JSON response format. Output ONLY the full revised prompt text with no markdown fences, no commentary, no "here is the updated prompt" preamble.`,
        messages: [
          {
            role: 'user',
            content: `CURRENT SYSTEM PROMPT:\n\n${base}\n\n---\n\nREQUESTED CHANGES:\n${change_description}\n\n---\n\nREAL CONVERSATION SAMPLES (for context on how the bot currently behaves):\n${sampleText}\n\n---\n\nRewrite the full system prompt with the requested changes applied. Preserve anything that wasn't asked to change.`
          }
        ]
      },
      { category: 'analyzer_prompt_gen', location_id: null, meta: { scope: 'cross_account' } }
    );
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
    const result = await ghlConv.pullAndStore(ghlToken, locationId, (p) => {
      pullProgress[locationId].stage = p.phase;
      if (p.phase === 'conversations') {
        pullProgress[locationId].fetched = p.fetched;
      } else {
        pullProgress[locationId].total = p.total;
        pullProgress[locationId].messages_fetched = p.fetched;
      }
    });

    const counts = await dbCountsForLocation(locationId);
    pullProgress[locationId] = {
      status: 'complete',
      stage: 'done',
      fetched: counts.total,
      total: counts.total,
      messages_fetched: result.messages_fetched_for,
      started_at: pullProgress[locationId].started_at,
      completed_at: new Date().toISOString(),
      incremental: result.incremental,
      counts
    };

    logger.log('analyzer', 'info', null, 'GHL pull complete', {
      locationId, counts, incremental: result.incremental
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

async function dbCountsForLocation(locationId) {
  const q = await db.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE source = 'claude')::int AS claude,
       COUNT(*) FILTER (WHERE source = 'botpress')::int AS botpress,
       COUNT(*) FILTER (WHERE source = 'other')::int AS other,
       MAX(pulled_at) AS last_pulled,
       MAX(ghl_date_updated) AS last_updated
     FROM ghl_conversations WHERE location_id = $1`,
    [locationId]
  );
  const r = q.rows[0] || {};
  return {
    total: r.total || 0,
    claude: r.claude || 0,
    botpress: r.botpress || 0,
    other: r.other || 0,
    last_pulled: r.last_pulled,
    last_updated: r.last_updated
  };
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

router.get('/pull-status', async (req, res) => {
  const locationId = req.query.locationId;
  if (!locationId) return res.status(400).json({ error: 'locationId required' });
  try {
    const counts = await dbCountsForLocation(locationId);
    const progress = pullProgress[locationId] || { status: counts.total > 0 ? 'idle' : 'idle' };
    res.json({
      locationId,
      progress,
      pulled_at: counts.last_pulled ? new Date(counts.last_pulled).getTime() : null,
      counts: counts.total > 0 ? {
        total: counts.total, claude: counts.claude, botpress: counts.botpress, other: counts.other
      } : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/pulled-stats', async (req, res) => {
  const locationId = req.query.locationId;
  if (!locationId) return res.status(400).json({ error: 'locationId required' });
  try {
    const q = await db.query(
      `SELECT source,
              COUNT(*)::int AS count,
              COUNT(*) FILTER (WHERE terminal_outcome IS NOT NULL)::int AS completed,
              COALESCE(AVG(message_count), 0)::float AS avg_messages
       FROM ghl_conversations WHERE location_id = $1 GROUP BY source`,
      [locationId]
    );
    const outcomesQ = await db.query(
      `SELECT source, terminal_outcome, COUNT(*)::int AS count
       FROM ghl_conversations WHERE location_id = $1 AND terminal_outcome IS NOT NULL
       GROUP BY source, terminal_outcome`,
      [locationId]
    );
    if (!q.rows.length) return res.status(404).json({ error: 'no pulled data for this location — run /pull first' });

    const outcomesBySource = {};
    for (const r of outcomesQ.rows) {
      if (!outcomesBySource[r.source]) outcomesBySource[r.source] = {};
      outcomesBySource[r.source][r.terminal_outcome] = r.count;
    }

    const buildForSource = (src) => {
      const row = q.rows.find((r) => r.source === src) || { count: 0, completed: 0, avg_messages: 0 };
      return {
        count: row.count,
        completed: row.completed,
        completion_rate: row.count ? row.completed / row.count : 0,
        avg_messages: Number(row.avg_messages) || 0,
        outcomes: outcomesBySource[src] || {}
      };
    };

    const claude = buildForSource('claude');
    const botpress = buildForSource('botpress');
    const other = buildForSource('other');
    const totalCount = claude.count + botpress.count + other.count;
    const totalCompleted = claude.completed + botpress.completed + other.completed;
    const combinedOutcomes = {};
    [claude.outcomes, botpress.outcomes, other.outcomes].forEach((o) => {
      for (const [k, v] of Object.entries(o)) combinedOutcomes[k] = (combinedOutcomes[k] || 0) + v;
    });
    const combined = {
      count: totalCount,
      completed: totalCompleted,
      completion_rate: totalCount ? totalCompleted / totalCount : 0,
      avg_messages: totalCount
        ? (claude.avg_messages * claude.count + botpress.avg_messages * botpress.count + other.avg_messages * other.count) / totalCount
        : 0,
      outcomes: combinedOutcomes
    };

    const counts = await dbCountsForLocation(locationId);
    res.json({
      locationId,
      pulled_at: counts.last_pulled ? new Date(counts.last_pulled).getTime() : null,
      expires_in_days: 90,
      stats: { total: totalCount, claude, botpress, other, combined }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/pulled-conversations', async (req, res) => {
  const locationId = req.query.locationId;
  if (!locationId) return res.status(400).json({ error: 'locationId required' });
  try {
    const source = (req.query.source || 'all').toLowerCase();
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const offset = parseInt(req.query.offset, 10) || 0;
    const search = req.query.search ? `%${req.query.search.toLowerCase()}%` : null;

    const where = ['location_id = $1'];
    const params = [locationId];
    if (source !== 'all') {
      params.push(source);
      where.push(`source = $${params.length}`);
    }
    if (search) {
      params.push(search);
      where.push(`(LOWER(COALESCE(contact_name, '')) LIKE $${params.length} OR COALESCE(contact_phone, '') LIKE $${params.length})`);
    }
    const totalQ = await db.query(
      `SELECT COUNT(*)::int AS total FROM ghl_conversations WHERE ${where.join(' AND ')}`,
      params
    );
    params.push(limit);
    params.push(offset);
    const listQ = await db.query(
      `SELECT ghl_conversation_id, contact_id, contact_name, contact_phone, source,
              message_count, last_message_at, terminal_outcome, ghl_date_updated
       FROM ghl_conversations
       WHERE ${where.join(' AND ')}
       ORDER BY last_message_at DESC NULLS LAST
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const page = listQ.rows.map((r) => ({
      id: r.ghl_conversation_id,
      contactId: r.contact_id,
      contactName: r.contact_name,
      phone: r.contact_phone,
      lastMessageDate: r.last_message_at,
      source: r.source,
      message_count: r.message_count,
      completed: !!r.terminal_outcome,
      outcome: r.terminal_outcome || 'incomplete'
    }));
    res.json({ locationId, source, total: totalQ.rows[0]?.total || 0, conversations: page });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/pulled-conversation/:conversationId', async (req, res) => {
  const locationId = req.query.locationId;
  if (!locationId) return res.status(400).json({ error: 'locationId required' });
  try {
    const metaQ = await db.query(
      `SELECT ghl_conversation_id, contact_id, contact_name, contact_phone, source,
              message_count, last_message_at, terminal_outcome, ghl_date_added, ghl_date_updated,
              pulled_at, expires_at
       FROM ghl_conversations WHERE ghl_conversation_id = $1 AND location_id = $2`,
      [req.params.conversationId, locationId]
    );
    if (!metaQ.rows[0]) return res.status(404).json({ error: 'conversation not found' });
    const meta = metaQ.rows[0];
    const msgsQ = await db.query(
      `SELECT direction, content, message_type, created_at
       FROM ghl_messages
       WHERE ghl_conversation_id = $1 AND location_id = $2
       ORDER BY created_at ASC, id ASC`,
      [req.params.conversationId, locationId]
    );
    res.json({
      conversation: {
        id: meta.ghl_conversation_id,
        contactId: meta.contact_id,
        contactName: meta.contact_name,
        phone: meta.contact_phone,
        source: meta.source,
        message_count: meta.message_count,
        lastMessageDate: meta.last_message_at,
        outcome: meta.terminal_outcome || 'incomplete',
        pulled_at: meta.pulled_at,
        expires_at: meta.expires_at,
        messages: msgsQ.rows.map((m) => ({
          direction: m.direction,
          body: m.content,
          dateAdded: m.created_at,
          messageType: m.message_type
        }))
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Override /analyze and /generate-prompt to use pulled cache when locationId given
// ============================================================

async function samplePulledFromDb(locationId, source, count) {
  const params = [locationId];
  let where = 'location_id = $1';
  if (source !== 'all') {
    params.push(source);
    where += ` AND source = $${params.length}`;
  }
  params.push(count);
  const q = await db.query(
    `SELECT ghl_conversation_id, contact_name, contact_phone, source, message_count,
            terminal_outcome, last_message_at
     FROM ghl_conversations
     WHERE ${where}
     ORDER BY (terminal_outcome IS NULL) DESC, last_message_at DESC NULLS LAST
     LIMIT $${params.length}`,
    params
  );
  const out = [];
  for (const row of q.rows) {
    const msgsQ = await db.query(
      `SELECT direction, content FROM ghl_messages
       WHERE ghl_conversation_id = $1 AND location_id = $2
       ORDER BY created_at ASC, id ASC LIMIT 30`,
      [row.ghl_conversation_id, locationId]
    );
    out.push({
      id: row.ghl_conversation_id,
      source: row.source,
      contactName: row.contact_name,
      phone: row.contact_phone,
      message_count: row.message_count,
      completed: !!row.terminal_outcome,
      outcome: row.terminal_outcome || 'incomplete',
      messages: msgsQ.rows.map((m) => ({ direction: m.direction, body: m.content }))
    });
  }
  return out;
}

function serializePulledConversation(c, maxLen = 500) {
  return (c.messages || []).slice(0, 30).map((m) => `[${m.direction === 'outbound' ? 'BOT' : 'USER'}] ${String(m.body || '').slice(0, maxLen)}`).join('\n');
}

router.post('/analyze-pulled', async (req, res) => {
  try {
    const { locationId, source } = req.body || {};
    if (!locationId) return res.status(400).json({ error: 'locationId required' });

    const filterSource = (source || 'all').toLowerCase();
    const counts = await dbCountsForLocation(locationId);
    if (!counts.total) return res.status(404).json({ error: 'no pulled data — run /pull first' });

    let userContent;
    if (filterSource === 'all') {
      const claudeSamples = await samplePulledFromDb(locationId, 'claude', 5);
      const bpSamples = await samplePulledFromDb(locationId, 'botpress', 5);
      const claudeBlocks = claudeSamples.map((c, i) => `=== CLAUDE #${i + 1} (${c.outcome}, ${c.message_count} msgs) ===\n${serializePulledConversation(c)}`).join('\n\n');
      const bpBlocks = bpSamples.map((c, i) => `=== BOTPRESS #${i + 1} (${c.outcome}, ${c.message_count} msgs) ===\n${serializePulledConversation(c)}`).join('\n\n');
      userContent = `Compare these two SMS qualification bot implementations on real production conversations for GHL location ${locationId}.

## Stats
- Total: ${counts.total}
- Claude: ${counts.claude}
- BotPress: ${counts.botpress}
- Other: ${counts.other}

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
      const samples = await samplePulledFromDb(locationId, filterSource, 10);
      const blocks = samples.map((c, i) => `=== ${filterSource.toUpperCase()} #${i + 1} (${c.outcome}, ${c.message_count} msgs) ===\n${serializePulledConversation(c)}`).join('\n\n');
      userContent = `Analyze these ${filterSource} bot conversations for GHL location ${locationId}.

## CONVERSATIONS (${samples.length})
${blocks || '(none)'}

Produce a focused analysis (<1500 words):
1. Common drop-off points
2. Response quality issues
3. Specific improvements with exact phrasing`;
    }

    const resp = await callAnthropic(
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 3000,
        system: 'You are a conversational AI quality analyst. Be specific, cite examples, and recommend concrete prompt changes.',
        messages: [{ role: 'user', content: userContent }]
      },
      { category: 'analyzer_analysis', location_id: locationId || null, meta: { scope: 'pulled', source: filterSource } }
    );
    const textBlock = resp.content.find((b) => b.type === 'text');
    res.json({
      analysis: textBlock ? textBlock.text : '',
      source: filterSource,
      locationId,
      pulled_at: counts.last_pulled,
      sample_counts: filterSource === 'all'
        ? { claude: Math.min(counts.claude, 5), botpress: Math.min(counts.botpress, 5) }
        : { [filterSource]: Math.min(counts[filterSource] || 0, 10) },
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
    if (locationId) {
      const filterSource = (source || 'all').toLowerCase();
      const samples = filterSource === 'all'
        ? [...(await samplePulledFromDb(locationId, 'claude', 3)), ...(await samplePulledFromDb(locationId, 'botpress', 3))]
        : await samplePulledFromDb(locationId, filterSource, 6);
      sampleText = samples.map((c, i) => `=== SAMPLE #${i + 1} (${c.source}, ${c.outcome}) ===\n${serializePulledConversation(c)}`).join('\n\n');
    }

    const resp = await callAnthropic(
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8000,
        system: `You are a prompt engineer rewriting an SMS bot system prompt. Apply the requested changes precisely while preserving the existing structure, tone rules, and JSON response format. Output ONLY the full revised prompt text with no markdown fences, no commentary, no preamble.`,
        messages: [
          {
            role: 'user',
            content: `CURRENT SYSTEM PROMPT:\n\n${base}\n\n---\n\nREQUESTED CHANGES:\n${change_description}\n\n---\n\nREAL CONVERSATION SAMPLES (prioritized: incomplete / drop-offs) to inform the rewrite:\n${sampleText || '(no samples available — rely solely on the requested changes)'}\n\n---\n\nRewrite the full system prompt with the requested changes applied. Preserve anything not asked to change.`
          }
        ]
      },
      { category: 'analyzer_prompt_gen', location_id: locationId || null, meta: { scope: 'pulled', source: source || 'all' } }
    );
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
module.exports.getCurrentPrompt = getCurrentPrompt;
module.exports.saveCurrentPrompt = saveCurrentPrompt;
