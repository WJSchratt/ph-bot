const express = require('express');
const os = require('os');
const Anthropic = require('@anthropic-ai/sdk');

const dc = require('../services/devConsole');
const logger = require('../services/logger');
const db = require('../db');
const { buildSystemPrompt } = require('../prompts');
const standardPrompt = require('../prompts/standard');

const router = express.Router();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-20250514';

// --- File tree / file read -----------------------------------------------

router.get('/files', async (req, res) => {
  try {
    const files = await dc.walkFiles();
    files.sort((a, b) => a.path.localeCompare(b.path));
    res.json({ files, total: files.length });
  } catch (err) {
    logger.log('dev_console', 'error', null, 'files list failed', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

router.get('/file', async (req, res) => {
  try {
    const p = req.query.path;
    if (!p) return res.status(400).json({ error: 'path query param required' });
    const data = await dc.readFile(p);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Context bundle for the chat AI --------------------------------------

async function buildContextBundle() {
  const filesAll = await dc.walkFiles();
  const files = filesAll
    .filter((f) => /^(src\/|public\/|package\.json|Procfile|railway\.json|README\.md|\.env\.example|CLAUDE\.md)/.test(f.path))
    .map((f) => ({ path: f.path, size: f.size }));

  let recentErrors = [];
  let recentLogs = [];
  try {
    const { getLogs } = require('../services/logger');
    const all = getLogs({ limit: 200 });
    recentLogs = all.slice(0, 50);
    recentErrors = all.filter((l) => l.level === 'error').slice(0, 20);
  } catch {}

  let stats = { total: 0, active: 0, booked: 0, dnc: 0 };
  try {
    const q = await db.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE is_active = TRUE)::int AS active,
        COUNT(*) FILTER (WHERE terminal_outcome = 'appointment_booked')::int AS booked,
        COUNT(*) FILTER (WHERE terminal_outcome = 'dnc')::int AS dnc
      FROM conversations WHERE is_sandbox = FALSE`);
    stats = q.rows[0] || stats;
  } catch {}

  let recentConversations = [];
  try {
    const q = await db.query(`
      SELECT id, contact_id, location_id, first_name, last_name, product_type, terminal_outcome,
             is_active, created_at, jsonb_array_length(messages)::int AS message_count
      FROM conversations WHERE is_sandbox = FALSE
      ORDER BY last_message_at DESC NULLS LAST LIMIT 10`);
    recentConversations = q.rows;
  } catch {}

  let subaccounts = [];
  try {
    const q = await db.query(`SELECT id, name, ghl_location_id, status FROM subaccounts ORDER BY name`);
    subaccounts = q.rows;
  } catch {}

  const gitHead = await dc.gitCurrentHead().catch(() => null);
  const gitLogRecent = await dc.gitLog(5).catch(() => []);

  return {
    files,
    systemPrompt: standardPrompt,
    recentLogs,
    recentErrors,
    conversationStats: stats,
    recentConversations,
    subaccounts,
    environment: {
      node_version: process.version,
      uptime_seconds: Math.round(process.uptime()),
      memory_mb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      platform: `${os.platform()} ${os.release()}`,
      current_commit: gitHead ? gitHead.slice(0, 7) : null,
      recent_commits: gitLogRecent
    }
  };
}

router.get('/context', async (req, res) => {
  try {
    const bundle = await buildContextBundle();
    res.json(bundle);
  } catch (err) {
    logger.log('dev_console', 'error', null, 'context failed', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

// --- Chat ---------------------------------------------------------------

const KEYWORD_FILES = [
  { kw: /\bwebhook\b/i, files: ['src/routes/webhook.js'] },
  { kw: /\bparser?\b|\bpayload\b/i, files: ['src/utils/parser.js'] },
  { kw: /\bclaude\b|\bllm\b/i, files: ['src/services/claude.js'] },
  { kw: /\bprompt\b|\bsystem prompt\b/i, files: ['src/prompts/index.js', 'src/prompts/standard.js'] },
  { kw: /\bcalendar\b|\bbooking\b|\bappointment\b/i, files: ['src/services/calendar.js'] },
  { kw: /\bghl\b|\bgohigh|\bfield sync\b|\btags?\b/i, files: ['src/services/ghl.js'] },
  { kw: /\banalyzer\b|\bpull\b/i, files: ['src/routes/analyzer.js', 'src/services/ghlConversations.js'] },
  { kw: /\bstore\b|\bconversation store\b|\bdirty\b/i, files: ['src/services/conversationStore.js'] },
  { kw: /\bpost[- ]?booking\b|\breschedule\b|\bcancel\b/i, files: ['src/routes/webhook.js'] },
  { kw: /\bauth\b|\blogin\b|\bsession\b/i, files: ['src/services/auth.js', 'src/middleware/auth.js', 'src/routes/auth.js'] },
  { kw: /\bdashboard\b|\bfrontend\b|\bui\b/i, files: ['public/index.html'] },
  { kw: /\bschema\b|\bmigration\b|\bdatabase\b|\bdb\b/i, files: ['src/db/schema.sql', 'src/db/migrate_v2.sql'] },
  { kw: /\bpost[- ]?call router\b|\bpcr\b/i, files: ['src/services/postCallRouter.js'] },
  { kw: /\blogger?\b|\blog\b/i, files: ['src/services/logger.js', 'src/routes/logs.js'] }
];

async function pickRelevantFiles(message) {
  const matched = new Set();
  for (const entry of KEYWORD_FILES) {
    if (entry.kw.test(message)) entry.files.forEach((f) => matched.add(f));
  }
  if (matched.size === 0) {
    ['src/server.js', 'src/routes/webhook.js', 'src/prompts/index.js'].forEach((f) => matched.add(f));
  }
  const results = [];
  for (const p of matched) {
    try {
      const { content } = await dc.readFile(p);
      results.push({ path: p, content });
    } catch {}
  }
  return results;
}

function buildDevSystemPrompt(ctx, files) {
  const fileList = ctx.files.map((f) => `  - ${f.path} (${f.size}B)`).join('\n');
  const fileContents = files.map((f) => `\n=== FILE: ${f.path} ===\n${f.content}\n=== END FILE ===`).join('\n');
  const errSummary = (ctx.recentErrors || []).slice(0, 10).map((e) => `  - [${e.stage}] ${e.message} @ ${e.timestamp}`).join('\n');
  const statsLine = `conversations: total=${ctx.conversationStats.total} active=${ctx.conversationStats.active} booked=${ctx.conversationStats.booked} dnc=${ctx.conversationStats.dnc}`;

  return `You are the Dev Console assistant for the PH Insurance SMS bot — a Node/Express middleware between GoHighLevel (GHL) webhooks and the Claude API. The bot qualifies inbound SMS leads, books real GHL calendar appointments, handles post-booking reschedule/cancel, and syncs collected data back to GHL contact fields. The user talking to you (authenticated admin) is maintaining this codebase.

ARCHITECTURE QUICK REF:
- GHL sends a POST to /webhook/inbound — parsed by src/utils/parser.js → stored via src/services/conversationStore.js → Claude called via src/services/claude.js → reply sent via src/services/ghl.js.
- Real calendar availability is fetched from GHL and injected into Claude's prompt during scheduling (src/services/calendar.js).
- Terminal outcomes: appointment_booked / dnc / opted_out / human_handoff / fex_immediate / mp_immediate. Only DNC/opt-out deactivates the conversation. Post-booking is handled with an injected override block.
- Field sync to GHL contact runs immediately at terminal AND a 72h background job in src/server.js.
- The dashboard (public/index.html) has tabs for Overview, Wordtracks, Pipeline, QC, AI Review Queue, Sandbox, Analyzer, Settings, Logs — now also Dev Console (you).

ENVIRONMENT: ${ctx.environment.platform}, Node ${ctx.environment.node_version}, uptime ${ctx.environment.uptime_seconds}s, RSS ${ctx.environment.memory_mb}MB, HEAD ${ctx.environment.current_commit || 'unknown'}.
STATS: ${statsLine}
${errSummary ? `RECENT ERRORS:\n${errSummary}` : 'No recent errors.'}

PROJECT FILE TREE (relevant):
${fileList}

PRE-LOADED FILES RELEVANT TO THE USER'S MESSAGE:
${fileContents || '(none — ask for specific files if you need them)'}

INSTRUCTIONS:
1. Answer questions directly and concisely. Cite file paths + line numbers when referencing code.
2. When the user asks for a code change, first explain what you'll change and why. Then, if they confirm (or the ask is already unambiguous), propose changes using the schema below. Never claim to have deployed — you cannot deploy. The user will click "Apply & Deploy" after reviewing your proposed changes.
3. Proposed changes format (include this JSON block at the END of your message when proposing changes; the UI parses it). For modify, the "original" block MUST appear exactly once in the file (include enough surrounding context to make it unique):

<<<CHANGES>>>
{
  "summary": "one sentence of what all these changes do together",
  "commitMessage": "imperative commit subject line (<=72 chars)",
  "changes": [
    { "file": "src/path/to/file.js", "type": "modify", "original": "exact existing code block", "modified": "replacement code block", "description": "what this edit does" },
    { "file": "src/new/file.js", "type": "create", "content": "full file contents", "description": "why this new file exists" }
  ]
}
<<</CHANGES>>>

4. If you need a file not in the pre-loaded list, ASK the user for it — or tell them to click it in the file tree — rather than guessing.
5. Be skeptical about edits. Don't propose refactors or speculative improvements unless asked. Ship the smallest correct change.`;
}

router.post('/chat', async (req, res) => {
  try {
    const gate = dc.rateLimitChat();
    if (!gate.allowed) {
      return res.status(429).json({ error: 'rate limit hit', retry_after_s: gate.retry_after_s });
    }

    const { message, conversationHistory } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message required' });
    }

    const ctx = await buildContextBundle();
    const preloaded = await pickRelevantFiles(message);

    const system = buildDevSystemPrompt(ctx, preloaded);

    const messages = [];
    if (Array.isArray(conversationHistory)) {
      for (const m of conversationHistory) {
        if (!m || !m.role || !m.content) continue;
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        messages.push({ role: m.role, content: String(m.content).slice(0, 50000) });
      }
    }
    messages.push({ role: 'user', content: message });

    logger.log('dev_console', 'info', null, 'Chat request', {
      user: req.session?.username || null,
      message_preview: message.slice(0, 200),
      preloaded_files: preloaded.map((p) => p.path),
      history_len: messages.length
    });

    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system,
      messages
    });

    const text = (resp.content.find((b) => b.type === 'text')?.text) || '';
    const changes = parseChangesBlock(text);

    res.json({
      reply: text,
      proposed_changes: changes,
      preloaded_files: preloaded.map((p) => p.path),
      input_tokens: resp.usage?.input_tokens || 0,
      output_tokens: resp.usage?.output_tokens || 0
    });
  } catch (err) {
    logger.log('dev_console', 'error', null, 'chat failed', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

function parseChangesBlock(text) {
  if (!text) return null;
  const match = text.match(/<<<CHANGES>>>([\s\S]*?)<<<\/CHANGES>>>/);
  if (!match) return null;
  try {
    return JSON.parse(match[1].trim());
  } catch (err) {
    return { parse_error: err.message, raw: match[1].trim().slice(0, 2000) };
  }
}

// --- Generate changes (dedicated endpoint) -------------------------------

router.post('/generate-changes', async (req, res) => {
  try {
    const gate = dc.rateLimitChat();
    if (!gate.allowed) return res.status(429).json({ error: 'rate limit hit', retry_after_s: gate.retry_after_s });

    const { description, targetFiles } = req.body || {};
    if (!description) return res.status(400).json({ error: 'description required' });

    const files = [];
    const list = Array.isArray(targetFiles) && targetFiles.length ? targetFiles : null;
    const preloaded = list
      ? await Promise.all(list.map((p) => dc.readFile(p).catch((err) => ({ path: p, error: err.message }))))
      : await pickRelevantFiles(description);

    for (const f of preloaded) {
      if (f.content) files.push(f);
    }

    const ctx = await buildContextBundle();
    const system = buildDevSystemPrompt(ctx, files) + '\n\nFor THIS request: output ONLY the <<<CHANGES>>> JSON block (with a short explanatory paragraph above it). No other changes.';

    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: `Generate concrete code changes for: ${description}` }]
    });

    const text = (resp.content.find((b) => b.type === 'text')?.text) || '';
    const changes = parseChangesBlock(text);
    if (!changes) return res.status(422).json({ error: 'no changes block found', raw: text });
    res.json({ ...changes, explanation: text.split('<<<CHANGES>>>')[0].trim() });
  } catch (err) {
    logger.log('dev_console', 'error', null, 'generate-changes failed', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// --- Apply changes + push ------------------------------------------------

router.post('/apply-changes', async (req, res) => {
  const username = req.session?.username || null;
  try {
    const { changes, commitMessage } = req.body || {};
    if (!Array.isArray(changes) || !changes.length) return res.status(400).json({ error: 'changes array required' });
    if (!commitMessage || typeof commitMessage !== 'string') return res.status(400).json({ error: 'commitMessage required' });

    logger.log('dev_console', 'info', null, 'Apply changes requested', {
      username, file_count: changes.length, files: changes.map((c) => c.file), commit_message: commitMessage
    });

    const applied = [];
    const filesChanged = [];
    for (const change of changes) {
      const result = await dc.applyChange(change);
      applied.push(result);
      filesChanged.push(change.file);
    }

    const push = await dc.gitCommitAndPush({
      commitMessage: `${commitMessage}\n\nDeployed via Dev Console by ${username || 'unknown'}.`,
      username,
      filesToAdd: filesChanged
    });

    if (!push.committed) {
      return res.json({ success: false, reason: push.reason, applied, filesChanged });
    }

    logger.log('dev_console', 'info', null, 'Deploy complete', {
      commit: push.short, filesChanged, username
    });

    res.json({
      success: true,
      commitHash: push.commit_hash,
      commitShort: push.short,
      filesChanged,
      applied
    });
  } catch (err) {
    logger.log('dev_console', 'error', null, 'apply-changes failed', {
      username, error: err.message, stack: err.stack
    });
    res.status(500).json({ success: false, error: err.message, stack: err.stack });
  }
});

// --- Rollback -----------------------------------------------------------

router.post('/rollback', async (req, res) => {
  const username = req.session?.username || null;
  try {
    const result = await dc.gitRevertAndPush(username);
    res.json({ success: true, ...result });
  } catch (err) {
    logger.log('dev_console', 'error', null, 'rollback failed', { username, error: err.message, stack: err.stack });
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/git-log', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const log = await dc.gitLog(limit);
    const head = await dc.gitCurrentHead();
    res.json({ head, log });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Convenience read endpoints for the UI panels ------------------------

router.get('/conversations', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const contactId = req.query.contact_id || null;
    const where = ['is_sandbox = FALSE'];
    const params = [];
    if (contactId) {
      params.push(contactId);
      where.push(`contact_id = $${params.length}`);
    }
    params.push(limit);
    params.push(offset);
    const q = await db.query(
      `SELECT id, contact_id, location_id, first_name, last_name, product_type, terminal_outcome,
              is_active, messages, created_at, last_message_at
       FROM conversations WHERE ${where.join(' AND ')}
       ORDER BY last_message_at DESC NULLS LAST
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ conversations: q.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/logs/all', (req, res) => {
  const { getLogs } = require('../services/logger');
  const logs = getLogs({ limit: 200 });
  res.json({ logs, count: logs.length });
});

module.exports = router;
