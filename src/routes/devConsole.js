const express = require('express');
const os = require('os');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const dc = require('../services/devConsole');
const logger = require('../services/logger');
const db = require('../db');
const { buildSystemPrompt } = require('../prompts');
const standardPrompt = require('../prompts/standard');

const router = express.Router();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-20250514';

// --- SQL + HTTP tool execution for Dev Console chat ----------------------

const DISALLOWED_SQL_RE = /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|rename|vacuum|analyze|attach|detach|call|merge|copy|comment|refresh)\b/i;

function isSafeSelect(sql) {
  if (!sql || typeof sql !== 'string') return false;
  const stripped = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
  if (!stripped) return false;
  if (!/^(with\b[\s\S]*?\bselect\b|select\b)/i.test(stripped)) return false;
  if (DISALLOWED_SQL_RE.test(stripped)) return false;
  if (stripped.split(';').filter((s) => s.trim()).length > 1) return false;
  return true;
}

async function runSafeQuery(sql) {
  if (!isSafeSelect(sql)) {
    return { error: 'blocked: only a single SELECT (or WITH…SELECT) is allowed — no INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE/CREATE.' };
  }
  const statementTimeoutMs = 8000;
  try {
    const { pool } = require('../db');
    const c = await pool.connect();
    try {
      await c.query('BEGIN READ ONLY');
      await c.query(`SET LOCAL statement_timeout = ${statementTimeoutMs}`);
      const r = await c.query(sql);
      await c.query('COMMIT');
      return {
        columns: r.fields.map((f) => f.name),
        rows: r.rows.slice(0, 200),
        truncated: r.rows.length > 200,
        row_count: r.rowCount
      };
    } finally {
      c.release();
    }
  } catch (err) {
    return { error: err.message };
  }
}

function extractTagValues(text, tag) {
  if (!text) return [];
  const re = new RegExp(`\\[${tag}:\\s*([^\\]]+?)\\s*\\]`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push(m[1]);
    if (out.length >= 5) break;
  }
  return out;
}

async function runLocalFetch(pathAndQuery, sessionToken) {
  if (!pathAndQuery || typeof pathAndQuery !== 'string') return { error: 'no path given' };
  if (!pathAndQuery.startsWith('/')) return { error: 'path must start with /' };
  const port = parseInt(process.env.PORT, 10) || 3000;
  const url = `http://127.0.0.1:${port}${pathAndQuery}`;
  try {
    const resp = await axios.get(url, {
      timeout: 15000,
      headers: sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {},
      validateStatus: () => true
    });
    let body = resp.data;
    if (typeof body === 'string' && body.length > 15000) body = body.slice(0, 15000) + '...[truncated]';
    return { status: resp.status, data: body };
  } catch (err) {
    return { error: err.message };
  }
}

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

function buildDevSystemPrompt(ctx, files, autoContext) {
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

YOU HAVE LIVE DATA ACCESS. Two tools, used by including special tags in your response:

1. Read-only SQL against the Postgres DB — include [QUERY: SELECT ...] in your response. Only SELECT (or CTE/WITH … SELECT) is permitted; INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE/CREATE are rejected. Query results are fed back to you on the next turn. Key tables:

- conversations: id, contact_id, location_id, phone, first_name, last_name, terminal_outcome, is_active, messages (JSONB array of {role, content, timestamp}), collected_age, collected_smoker, collected_health, collected_coverage_amount, collected_coverage_for, collected_spouse_name, collected_preferred_time, collected_appointment_time, bot_name, agent_name, ghl_token, calendar_id, appointment_id, fields_dirty, last_synced_at, last_message_at, created_at, updated_at
- messages: id, conversation_id, direction (inbound/outbound), content, message_type, got_reply, reply_time_seconds, created_at, segments
- ghl_conversations: ghl_conversation_id, contact_id, contact_name, contact_phone, location_id, source (claude/botpress/other), message_count, last_message_at, terminal_outcome, ghl_date_added, ghl_date_updated, pulled_at, expires_at
- ghl_messages: ghl_conversation_id, location_id, direction, content, message_type, created_at
- subaccounts: id, name, ghl_location_id, ghl_api_key, status
- qc_reviews, ai_review_queue, app_settings, analytics_daily

2. HTTP GET against the app's own API — include [FETCH: /api/...] in your response. Runs on localhost with your session token. Useful endpoints:
- /api/logs/latest, /api/logs/errors, /api/logs?contact_id=xxx
- /api/conversations/:contactId/:locationId — full Claude-bot conversation thread
- /api/analyzer/pulled-stats?locationId=xxx, /api/analyzer/pulled-conversations?locationId=xxx&source=all
- /api/analyzer/pulled-conversation/{ghlConvId}?locationId=xxx
- /api/dev/context, /api/dev/git-log, /api/dev/conversations?contact_id=xxx

RULES FOR USING TOOLS:
- When the user asks about a specific contact / phone / conversation / live state — USE the tools first. NEVER redirect the user to "check another tab". You have full access.
- Run a query, wait for results, THEN answer.
- Include at most 3 tool tags per turn. The loop runs at most 3 iterations total.
- Example for a phone lookup: [QUERY: SELECT contact_id, location_id, phone, first_name, last_name, terminal_outcome, is_active, last_message_at FROM conversations WHERE phone LIKE '%3526721885%' LIMIT 5]
- Example for recent activity: [FETCH: /api/logs/latest]
- Example for a full thread: [FETCH: /api/conversations/OxPKj3cNSWuhDly2u8lX/K9xKBbQkhSOUZs6KzTAy]

ENVIRONMENT: ${ctx.environment.platform}, Node ${ctx.environment.node_version}, uptime ${ctx.environment.uptime_seconds}s, RSS ${ctx.environment.memory_mb}MB, HEAD ${ctx.environment.current_commit || 'unknown'}.
STATS: ${statsLine}
${errSummary ? `RECENT ERRORS:\n${errSummary}` : 'No recent errors.'}

PROJECT FILE TREE (relevant):
${fileList}

PRE-LOADED FILES RELEVANT TO THE USER'S MESSAGE:
${fileContents || '(none — ask for specific files if you need them)'}

${autoContext ? `AUTO-FETCHED CONTEXT (already queried based on keywords in the user's message):\n${autoContext}\n` : ''}

CODE-CHANGE PROPOSAL INSTRUCTIONS:
1. When the user asks for a code change, first explain what you'll change and why. Then, if they confirm (or the ask is already unambiguous), propose changes using the schema below. Never claim to have deployed — you cannot deploy. The user will click "Apply & Deploy" after reviewing.
2. Proposed-changes block (include at the END of your message when proposing changes). For modify, the "original" block MUST appear exactly once in the file — include enough surrounding context to make it unique:

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

3. If you need a file not pre-loaded, read it: tell the user to click it in the file tree, OR use [FETCH: /api/dev/file?path=src/xxx] (yes the file endpoint works via FETCH too).
4. Be skeptical about edits. Don't propose refactors or speculative improvements unless asked. Ship the smallest correct change.`;
}

// Pre-query the DB for data the user's message hints at, so Claude gets live
// context on the very first turn without having to emit a [QUERY:...] tag.
async function autoFetchContextForMessage(message) {
  const out = [];
  const msg = message || '';
  const lower = msg.toLowerCase();

  // Phone number pattern
  const phoneDigits = (msg.match(/\d{3,}/g) || []).find((d) => d.length >= 7);
  if (phoneDigits) {
    try {
      const q = await db.query(
        `SELECT id, contact_id, location_id, phone, first_name, last_name, terminal_outcome, is_active, last_message_at
         FROM conversations
         WHERE phone LIKE $1 OR phone LIKE $2
         ORDER BY last_message_at DESC NULLS LAST LIMIT 10`,
        [`%${phoneDigits}%`, `%${phoneDigits.replace(/\D/g, '')}%`]
      );
      if (q.rows.length) out.push(`CONVERSATIONS matching phone "${phoneDigits}":\n${JSON.stringify(q.rows, null, 2)}`);
    } catch (e) { out.push(`(phone lookup failed: ${e.message})`); }
  }

  if (/\b(error|bug|failure|crash|exception)\b/.test(lower)) {
    try {
      const { getLogs } = require('../services/logger');
      const errs = getLogs({ limit: 200 }).filter((l) => l.level === 'error').slice(0, 20);
      if (errs.length) out.push(`RECENT ERROR LOGS (${errs.length}):\n${JSON.stringify(errs, null, 2)}`);
    } catch {}
  }

  if (/\blogs?\b/.test(lower)) {
    try {
      const { getLogs } = require('../services/logger');
      const recent = getLogs({ limit: 50 });
      out.push(`LAST 50 LOG ENTRIES:\n${JSON.stringify(recent.slice(0, 50), null, 2)}`);
    } catch {}
  }

  if (/\b(deploy|commit|git|push)\b/.test(lower)) {
    try {
      const log = await dc.gitLog(15);
      out.push(`RECENT GIT LOG:\n${JSON.stringify(log, null, 2)}`);
    } catch {}
  }

  if (/\bprompt\b/.test(lower)) {
    out.push(`CURRENT STANDARD SYSTEM PROMPT (first 4000 chars):\n${standardPrompt.slice(0, 4000)}...`);
  }

  // Name search — "conversation with <NAME>" or "convo for <NAME>"
  const nameMatch = msg.match(/\b(?:conversation|convo|chat)\b[^a-zA-Z]*(?:with|for|from|of)?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
  if (nameMatch) {
    const name = nameMatch[1].trim();
    try {
      const q = await db.query(
        `SELECT id, contact_id, location_id, first_name, last_name, terminal_outcome, is_active, last_message_at
         FROM conversations
         WHERE LOWER(first_name) = LOWER($1) OR LOWER(last_name) = LOWER($1)
            OR LOWER(first_name || ' ' || COALESCE(last_name, '')) LIKE LOWER($2)
         ORDER BY last_message_at DESC NULLS LAST LIMIT 10`,
        [name.split(/\s+/)[0], `%${name}%`]
      );
      if (q.rows.length) out.push(`CONVERSATIONS matching name "${name}":\n${JSON.stringify(q.rows, null, 2)}`);
    } catch (e) { out.push(`(name lookup failed: ${e.message})`); }
  }

  return out.join('\n\n');
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
    const autoContext = await autoFetchContextForMessage(message);

    const system = buildDevSystemPrompt(ctx, preloaded, autoContext);

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
      auto_context_bytes: autoContext.length,
      history_len: messages.length
    });

    let finalText = '';
    let totalIn = 0;
    let totalOut = 0;
    const toolTrace = [];
    const MAX_TOOL_ITERATIONS = 3;
    const sessionToken = req.sessionToken || null;

    for (let iter = 0; iter < MAX_TOOL_ITERATIONS + 1; iter++) {
      const resp = await client.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system,
        messages
      });
      totalIn += resp.usage?.input_tokens || 0;
      totalOut += resp.usage?.output_tokens || 0;

      const text = (resp.content.find((b) => b.type === 'text')?.text) || '';
      finalText = text;

      const queries = extractTagValues(text, 'QUERY');
      const fetches = extractTagValues(text, 'FETCH');

      if (!queries.length && !fetches.length) break;
      if (iter >= MAX_TOOL_ITERATIONS) {
        messages.push({ role: 'assistant', content: text });
        messages.push({ role: 'user', content: 'Tool iteration limit reached — please answer now using what you already have, without emitting more [QUERY:...] or [FETCH:...] tags.' });
        continue;
      }

      const toolResultChunks = [];
      for (const q of queries) {
        const result = await runSafeQuery(q);
        toolTrace.push({ tool: 'query', input: q, result });
        toolResultChunks.push(`[QUERY RESULT for: ${q}]\n${JSON.stringify(result).slice(0, 10000)}`);
      }
      for (const f of fetches) {
        const result = await runLocalFetch(f, sessionToken);
        toolTrace.push({ tool: 'fetch', input: f, result });
        toolResultChunks.push(`[FETCH RESULT for: ${f}]\n${JSON.stringify(result).slice(0, 10000)}`);
      }

      messages.push({ role: 'assistant', content: text });
      messages.push({ role: 'user', content: `Tool results:\n\n${toolResultChunks.join('\n\n')}\n\nNow answer the original question using these results.` });
    }

    const changes = parseChangesBlock(finalText);

    res.json({
      reply: finalText,
      proposed_changes: changes,
      preloaded_files: preloaded.map((p) => p.path),
      auto_context_used: autoContext.length > 0,
      tool_trace: toolTrace,
      input_tokens: totalIn,
      output_tokens: totalOut
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
