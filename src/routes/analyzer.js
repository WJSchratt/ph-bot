const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db');
const logger = require('../services/logger');
const standardPrompt = require('../prompts/standard');

const router = express.Router();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const ANALYZE_CACHE_TTL_MS = 60 * 60 * 1000;
let analyzeCache = { ts: 0, result: null };

const promptHistory = [];
const MAX_PROMPT_HISTORY = 10;

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

module.exports = router;
