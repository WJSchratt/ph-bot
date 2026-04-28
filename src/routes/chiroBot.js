const express = require('express');
const axios = require('axios');
const db = require('../db');
const logger = require('../services/logger');
const { callAnthropic } = require('../services/anthropic');
const store = require('../services/conversationStore');
const claude = require('../services/claude');
const defaultChiroPrompt = require('../prompts/chiro');

const router = express.Router();

const CHIRO_SB_CONTACT = 'sandbox_chiro_user';
const CHIRO_SB_LOCATION = 'sandbox_chiro_location';

// ── Prompt persistence ─────────────────────────────────────────────────────
let _cache = { text: null, fetchedAt: 0 };
const CACHE_TTL = 30 * 1000;

async function getCurrentPrompt() {
  const now = Date.now();
  if (_cache.text && now - _cache.fetchedAt < CACHE_TTL) return _cache.text;
  try {
    const q = await db.query(
      `SELECT value FROM app_settings WHERE section = 'chiro_prompt' AND key = 'current'`
    );
    const v = q.rows[0]?.value;
    _cache = { text: v || defaultChiroPrompt, fetchedAt: now };
  } catch {
    _cache = { text: defaultChiroPrompt, fetchedAt: now };
  }
  return _cache.text;
}

async function saveCurrentPrompt(text) {
  await db.query(
    `INSERT INTO app_settings (section, key, value, updated_at)
     VALUES ('chiro_prompt', 'current', $1, NOW())
     ON CONFLICT (section, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [text]
  );
  _cache = { text, fetchedAt: Date.now() };
  try {
    const prompts = require('../prompts');
    if (typeof prompts.clearChiroOverrideCache === 'function') prompts.clearChiroOverrideCache();
  } catch {}
}

// GET /api/chiro/prompt
router.get('/chiro/prompt', async (req, res) => {
  try {
    const prompt = await getCurrentPrompt();
    res.json({ prompt, is_default: prompt === defaultChiroPrompt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/chiro/prompt
router.post('/chiro/prompt', async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'prompt required' });
    await saveCurrentPrompt(prompt);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Sandbox ────────────────────────────────────────────────────────────────

// POST /api/chiro/sandbox/reset
router.post('/chiro/sandbox/reset', async (req, res) => {
  try {
    await db.query(
      `DELETE FROM conversations WHERE contact_id = $1 AND location_id = $2`,
      [CHIRO_SB_CONTACT, CHIRO_SB_LOCATION]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/chiro/sandbox/chat
// Body: { message, first_name, bot_name, doctor_name, practice_name, office_hours, calendar_link }
router.post('/chiro/sandbox/chat', async (req, res) => {
  try {
    const {
      message,
      first_name = 'Walt',
      bot_name = 'Aria',
      doctor_name = 'Dr. Johnson',
      practice_name = 'our practice',
      office_hours = 'Monday-Friday 8am-6pm',
      calendar_link = ''
    } = req.body || {};

    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'message required' });
    }

    const parsed = {
      contact_id: CHIRO_SB_CONTACT,
      location_id: CHIRO_SB_LOCATION,
      phone: '',
      first_name,
      last_name: '',
      state: 'FL',
      product_type: '',
      contact_stage: 'lead',
      is_ca: false,
      bot_vertical: 'chiro',
      doctor_name,
      practice_name,
      office_hours,
      calendar_link,
      bot_name,
      agent_name: doctor_name,
      agent_phone: '',
      agent_business_card_url: '',
      calendar_link_fx: '',
      calendar_link_mp: '',
      loom_video_fx: '',
      loom_video_mp: '',
      meeting_type: 'In-Person',
      ghl_token: '',
      ghl_message_history: '',
      offer: '',
      offer_short: '',
      language: '',
      marketplace_type: '',
      consent_status: '',
      tags: [],
      existing_dob: '',
      existing_age: '',
      existing_smoker: '',
      existing_health: '',
      existing_spouse_name: '',
      existing_mortgage_balance: '',
      existing_coverage_subject: ''
    };

    const conv = await store.upsertConversation(parsed, { is_sandbox: true });
    const history = Array.isArray(conv.messages) ? conv.messages : [];
    const result = await claude.generateResponse(conv, history, message, null, null);
    await store.appendMessageHistory(conv.id, 'user', message);
    await store.appendMessageHistory(conv.id, 'assistant', result.rawAssistantContent);

    res.json({
      messages: result.messages,
      terminal_outcome: result.terminal_outcome,
      message_type: result.message_type,
      collected_data: result.collected_data || {}
    });
  } catch (err) {
    logger.log('chiro', 'error', null, 'sandbox chat failed', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

// ── Console ────────────────────────────────────────────────────────────────

// GET /api/chiro/console/pending
router.get('/chiro/console/pending', async (req, res) => {
  try {
    const q = await db.query(
      `SELECT id, change_type, description, created_at FROM pending_prompt_changes
       WHERE status = 'pending' AND source = 'chiro_console'
       ORDER BY created_at ASC LIMIT 50`
    );
    res.json({ ok: true, edits: q.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/chiro/console
// Body: { message, history: [{role,content}] }
router.post('/chiro/console', async (req, res) => {
  try {
    const { message, history = [] } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });

    const currentPrompt = await getCurrentPrompt();

    let pendingCtx = '';
    try {
      const pQ = await db.query(
        `SELECT change_type, description FROM pending_prompt_changes
         WHERE status = 'pending' AND source = 'chiro_console'
         ORDER BY created_at ASC LIMIT 10`
      );
      if (pQ.rows.length) {
        pendingCtx = `\n\nPENDING QUEUED CHANGES (${pQ.rows.length} total):\n` +
          pQ.rows.map((r) => `[${r.change_type}] ${r.description.slice(0, 120)}`).join('\n');
      }
    } catch {}

    const systemPrompt = `You are the bot management assistant for the Profit Hexagon Chiropractic SMS scheduling bot. You can make REAL changes to the live chiro bot prompt.

HOW CHANGES WORK:
- Include a "prompt_change" action to queue a change immediately.
- The user clicks "Apply All Changes to Bot" to merge and deploy them live.
- Queue multiple changes in one response if needed.
- Be specific in "details" — write the exact new text or instruction to add/replace/remove.

THE CHIRO BOT:
- Handles SMS scheduling for chiropractic practices
- Books New Patient Exams (NPE) and follow-up appointments
- Per-sub-account config: doctor name, practice name, office hours, booking link
- Does NOT diagnose or give medical advice
- Tone: friendly, warm, efficient
- Terminal outcomes: appointment_booked, human_handoff, dnc

CURRENT CHIRO PROMPT (full):
${currentPrompt}
${pendingCtx}

---
ALWAYS respond with valid JSON, no markdown fences:
{
  "reply": "your conversational response here",
  "actions": [
    {
      "type": "prompt_change",
      "description": "Short label for the pending changes list",
      "details": "Exact text or instruction — specific enough that it can be applied precisely"
    }
  ]
}

If no actions are needed, set "actions" to [].
Always return valid JSON.`;

    const messages = [
      ...history.slice(-10).map((h) => ({ role: h.role, content: h.content })),
      { role: 'user', content: message }
    ];

    const resp = await callAnthropic(
      { model: 'claude-sonnet-4-20250514', max_tokens: 1500, system: systemPrompt, messages },
      { category: 'chiro_console', location_id: null, meta: { history_len: history.length } }
    );

    const raw = (resp.content.find((b) => b.type === 'text')?.text || '').trim();
    let reply = raw;
    let actions = [];
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        const parsed = JSON.parse(m[0]);
        reply = parsed.reply || raw;
        actions = Array.isArray(parsed.actions) ? parsed.actions : [];
      }
    } catch {}

    const queuedIds = [];
    for (const a of actions) {
      if (a.type === 'prompt_change' && a.description) {
        try {
          const ins = await db.query(
            `INSERT INTO pending_prompt_changes (source, change_type, description, proposed_by)
             VALUES ('chiro_console', 'improvement', $1, 'chiro_console') RETURNING id`,
            [`${a.description}${a.details ? ': ' + a.details : ''}`]
          );
          queuedIds.push(ins.rows[0].id);
        } catch {}
      }
    }

    res.json({ ok: true, reply, actions, queued_ids: queuedIds });
  } catch (err) {
    logger.log('chiro', 'error', null, 'console failed', { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/chiro/console/apply
router.post('/chiro/console/apply', async (req, res) => {
  try {
    const { dry_run = false } = req.body || {};
    const pendingQ = await db.query(
      `SELECT id, change_type, description FROM pending_prompt_changes
       WHERE status = 'pending' AND source = 'chiro_console'
       ORDER BY created_at ASC`
    );
    const pending = pendingQ.rows;
    if (!pending.length) return res.json({ ok: true, applied: 0, message: 'No pending changes.' });

    const currentPrompt = await getCurrentPrompt();
    const changesBlock = pending.map((p, i) => `${i + 1}. [${p.change_type}] ${p.description}`).join('\n');

    const resp = await callAnthropic(
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8000,
        system: `You are a prompt engineer merging corrections into an SMS chiropractic scheduling bot system prompt. Apply every change precisely. Preserve structure, tone rules, and JSON response format. Output ONLY the full revised prompt text — no fences, no preamble.`,
        messages: [{
          role: 'user',
          content: `CURRENT PROMPT:\n\n${currentPrompt}\n\n---\n\nPENDING EDITS (${pending.length} total):\n${changesBlock}\n\n---\n\nReturn the full updated prompt.`
        }]
      },
      { category: 'chiro_apply', location_id: null, meta: { pending_count: pending.length, dry_run } }
    );

    const newPrompt = (resp.content.find((b) => b.type === 'text')?.text || '').trim();
    if (!newPrompt) return res.status(500).json({ error: 'Claude returned empty prompt' });

    if (dry_run) return res.json({ ok: true, dry_run: true, preview: newPrompt.slice(0, 2000) });

    await saveCurrentPrompt(newPrompt);
    const ids = pending.map((p) => p.id);
    await db.query(
      `UPDATE pending_prompt_changes SET status = 'applied', resolved_at = NOW() WHERE id = ANY($1)`,
      [ids]
    );
    logger.log('chiro', 'info', null, 'chiro console apply completed', { count: pending.length });
    res.json({ ok: true, applied: pending.length, applied_ids: ids });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/chiro/push-to-github
// Commits the current DB prompt to src/prompts/chiro.js via GitHub API, triggering Railway redeploy
router.post('/chiro/push-to-github', async (req, res) => {
  try {
    const token = process.env.GITHUB_DEPLOY_TOKEN || process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPO || 'WJSchratt/ph-bot';
    if (!token) {
      return res.status(400).json({ error: 'GITHUB_DEPLOY_TOKEN env var not set. Add it in Railway → Variables.' });
    }

    const currentPrompt = await getCurrentPrompt();
    const escaped = currentPrompt.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
    const fileContent = `// Chiro front desk bot prompt — used when conv.vertical === 'chiro'\n\nconst CHIRO_PROMPT = \`${escaped}\`;\n\nmodule.exports = CHIRO_PROMPT;\n`;

    const filePath = 'src/prompts/chiro.js';
    const apiBase = `https://api.github.com/repos/${repo}/contents/${filePath}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };

    const getResp = await axios.get(apiBase, { headers });
    const sha = getResp.data.sha;

    const putResp = await axios.put(apiBase, {
      message: 'chiro: update bot prompt from console',
      content: Buffer.from(fileContent, 'utf8').toString('base64'),
      sha,
      branch: 'main'
    }, { headers });

    const commitSha = putResp.data.commit?.sha;
    const commitUrl = putResp.data.commit?.html_url;
    logger.log('chiro', 'info', null, 'pushed chiro prompt to github', { commit: commitSha });
    res.json({ ok: true, commit_sha: commitSha, commit_url: commitUrl });
  } catch (err) {
    const detail = err.response?.data?.message || err.message;
    logger.log('chiro', 'error', null, 'push-to-github failed', { error: detail });
    res.status(500).json({ error: detail });
  }
});

module.exports = router;
module.exports.getCurrentPrompt = getCurrentPrompt;
module.exports.saveCurrentPrompt = saveCurrentPrompt;
