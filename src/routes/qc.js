const express = require('express');
const axios = require('axios');
const db = require('../db');
const store = require('../services/conversationStore');
const claude = require('../services/claude');
const logger = require('../services/logger');
const { callAnthropic } = require('../services/anthropic');
const { parseTags, determineContactStage, determineProductType, determineIsCa } = require('../utils/parser');
const router = express.Router();

const GH_OWNER = 'WJSchratt';
const GH_REPO = 'ph-bot';
const GH_FILE = 'src/prompts/standard.js';

async function commitPromptToGitHub(promptText) {
  const token = process.env.GITHUB_DEPLOY_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) return { ok: false, error: 'GITHUB_DEPLOY_TOKEN (or GITHUB_TOKEN) not set in environment' };
  const headers = { Authorization: `Bearer ${token}`, 'User-Agent': 'ph-bot', Accept: 'application/vnd.github+json' };
  const apiBase = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_FILE}`;

  // Escape backticks and ${} so the template literal in the file stays valid.
  const escaped = promptText
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
  const fileContent = `module.exports = \`${escaped}\`;\n`;

  try {
    const getRes = await axios.get(apiBase, { headers });
    const sha = getRes.data.sha;
    const contentB64 = Buffer.from(fileContent).toString('base64');
    await axios.put(apiBase, {
      message: 'chore: sync standard.js from QC apply-pending [skip ci]',
      content: contentB64,
      sha
    }, { headers });
    return { ok: true };
  } catch (err) {
    const detail = err.response?.data?.message || err.message;
    return { ok: false, error: detail };
  }
}

const SAMPLE_PROFILES = [
  { first_name: 'Linda', state: 'FL', offer: 'Final Expense', existing_age: '68', existing_smoker: 'no', existing_health: 'high blood pressure', persona: 'easy_close' },
  { first_name: 'Robert', state: 'TX', offer: 'Mortgage Protection', existing_age: '45', existing_smoker: 'no', existing_health: 'good', persona: 'price_objector' },
  { first_name: 'Maria', state: 'CA', offer: 'Final Expense', existing_age: '72', existing_smoker: 'no', existing_health: 'diabetes', persona: 'confused_elderly' },
  { first_name: 'James', state: 'OH', offer: 'Mortgage Protection', existing_age: '52', existing_smoker: 'yes', existing_health: 'good', persona: 'already_covered' },
  { first_name: 'Patricia', state: 'GA', offer: 'Final Expense', existing_age: '63', existing_smoker: 'no', existing_health: 'good', persona: 'spouse_decision' },
  { first_name: 'Michael', state: 'PA', offer: 'Final Expense', existing_age: '70', existing_smoker: 'no', existing_health: 'heart issues', persona: 'hostile_dnc' },
  { first_name: 'Jennifer', state: 'NC', offer: 'Mortgage Protection', existing_age: '41', existing_smoker: 'no', existing_health: 'good', persona: 'reschedule_cancel' },
  { first_name: 'David', state: 'AZ', offer: 'Final Expense', existing_age: '65', existing_smoker: 'no', existing_health: 'good', persona: 'wrong_number' },
  { first_name: 'Susan', state: 'MI', offer: 'Final Expense', existing_age: '69', existing_smoker: 'no', existing_health: 'fair', persona: 'easy_close' },
  { first_name: 'Thomas', state: 'NY', offer: 'Mortgage Protection', existing_age: '48', existing_smoker: 'no', existing_health: 'good', persona: 'price_objector' }
];

function scenarioFilter(scenario) {
  if (!scenario || scenario === 'all') return SAMPLE_PROFILES;
  if (scenario === 'greeting') return SAMPLE_PROFILES.slice(0, 3).map((p) => ({ ...p, persona: 'wrong_number' }));
  if (scenario === 'qualification') return SAMPLE_PROFILES.slice(0, 5).map((p) => ({ ...p, persona: p.persona === 'hostile_dnc' ? 'easy_close' : p.persona }));
  if (scenario === 'scheduling') return SAMPLE_PROFILES.slice(0, 4).map((p) => ({ ...p, persona: 'easy_close' }));
  if (scenario === 'objection_handling') return SAMPLE_PROFILES.slice(0, 5).map((p) => ({ ...p, persona: p.persona === 'easy_close' ? 'price_objector' : p.persona }));
  return SAMPLE_PROFILES;
}

// Get pending QC conversations
router.get('/qc/pending', async (req, res) => {
  try {
    const { page = 1, limit = 20, search, all, vertical } = req.query;
    const lim = Math.min(parseInt(limit, 10) || 20, 100);
    const off = (Math.max(parseInt(page, 10) || 1, 1) - 1) * lim;

    // `all=true` drops the qc_reviewed + terminal_outcome filters so reviewers
    // can browse every conversation (including in-progress + already-reviewed).
    // `vertical` filters by bot vertical ('insurance', 'chiro'). Defaults to 'insurance'.
    // `search` matches first/last name OR phone, case-insensitive substring.
    const includeAll = String(all || '') === 'true' || all === '1';
    const verticalFilter = vertical && String(vertical).trim() ? String(vertical).trim() : 'insurance';
    const clauses = ['c.is_sandbox = FALSE', `COALESCE(c.vertical, 'insurance') = $1`];
    const params = [verticalFilter];
    let p = 2;
    if (!includeAll) {
      clauses.push('c.qc_reviewed = FALSE');
      clauses.push('c.terminal_outcome IS NOT NULL');
    }
    if (search && String(search).trim()) {
      params.push('%' + String(search).trim().toLowerCase() + '%');
      clauses.push(`(LOWER(c.first_name) LIKE $${p} OR LOWER(c.last_name) LIKE $${p} OR LOWER(c.first_name || ' ' || c.last_name) LIKE $${p} OR c.phone LIKE $${p})`);
      p++;
    }
    const where = 'WHERE ' + clauses.join(' AND ');
    params.push(lim); const limIdx = p++;
    params.push(off); const offIdx = p++;

    const result = await db.query(
      `SELECT c.id, c.contact_id, c.location_id, c.first_name, c.last_name, c.phone, c.product_type,
              c.contact_stage, c.terminal_outcome, c.qc_reviewed, c.ai_self_score, c.last_message_at,
              jsonb_array_length(c.messages) AS message_count,
              COALESCE(s.name, c.location_id) AS subaccount_name
       FROM conversations c
       LEFT JOIN subaccounts s ON s.ghl_location_id = c.location_id
       ${where}
       ORDER BY c.last_message_at DESC NULLS LAST
       LIMIT $${limIdx} OFFSET $${offIdx}`,
      params
    );

    const countParams = params.slice(0, p - 3); // exclude limit+offset
    const countRes = await db.query(
      `SELECT COUNT(*)::int AS total FROM conversations c ${where}`,
      countParams
    );

    res.json({
      conversations: result.rows,
      total: countRes.rows[0].total,
      page: parseInt(page, 10) || 1,
      limit: lim
    });
  } catch (err) {
    console.error('[qc/pending] error', err);
    res.status(500).json({ error: err.message });
  }
});

// QC review statistics
router.get('/qc/stats', async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const result = await db.query(
      `SELECT
         COUNT(*)::int AS total_reviewed,
         COUNT(*) FILTER (WHERE outcome = 'approved')::int AS approved,
         COUNT(*) FILTER (WHERE outcome = 'failed')::int AS failed,
         COUNT(*) FILTER (WHERE outcome = 'modified')::int AS modified
       FROM qc_reviews
       WHERE created_at >= NOW() - ($1 || ' days')::interval`,
      [parseInt(days, 10) || 30]
    );

    const pendingRes = await db.query(
      `SELECT COUNT(*)::int AS pending FROM conversations
       WHERE is_sandbox = FALSE AND qc_reviewed = FALSE AND terminal_outcome IS NOT NULL`
    );

    const stats = result.rows[0];
    const totalReviewed = stats.total_reviewed || 0;
    // Accuracy: approved = 1.0, modified = 0.6 (partial credit), failed = 0.
    // Previous bug: divided `stats.total_reviewed || 1` then *100, but the rest
    // of the frontend already runs .toFixed(1)% on it — so when stats came
    // back as "83.3" the UI showed 8330% or similar after another multiply.
    // Now we return a plain 0–100 number and the UI formats it.
    const accuracy = totalReviewed > 0
      ? (stats.approved + stats.modified * 0.6) / totalReviewed * 100
      : 0;
    res.json({
      ...stats,
      pending: pendingRes.rows[0].pending,
      accuracy: Number(accuracy.toFixed(1))
    });
  } catch (err) {
    console.error('[qc/stats] error', err);
    res.status(500).json({ error: err.message });
  }
});

// Submit a QC review
router.post('/qc/review', async (req, res) => {
  try {
    const { conversation_id, reviewer, outcome, modified_response, notes } = req.body;
    if (!conversation_id || !reviewer || !outcome) {
      return res.status(400).json({ error: 'conversation_id, reviewer, and outcome are required' });
    }
    if (!['approved', 'failed', 'modified'].includes(outcome)) {
      return res.status(400).json({ error: 'outcome must be approved, failed, or modified' });
    }

    const reviewRes = await db.query(
      `INSERT INTO qc_reviews (conversation_id, reviewer, outcome, modified_response, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [conversation_id, reviewer, outcome, modified_response || null, notes || null]
    );

    await db.query(
      `UPDATE conversations SET qc_reviewed = TRUE, updated_at = NOW() WHERE id = $1`,
      [conversation_id]
    );

    res.json({ ok: true, review: reviewRes.rows[0] });
  } catch (err) {
    console.error('[qc/review] error', err);
    res.status(500).json({ error: err.message });
  }
});

// Pull a random unreviewed conversation
router.post('/qc/pull-random', async (req, res) => {
  try {
    const convRes = await db.query(
      `SELECT id, contact_id, location_id FROM conversations
       WHERE is_sandbox = FALSE AND qc_reviewed = FALSE AND terminal_outcome IS NOT NULL
       ORDER BY RANDOM() LIMIT 1`
    );
    if (!convRes.rows.length) {
      return res.json({ conversation: null, messages: [] });
    }
    const conv = convRes.rows[0];
    const fullRes = await db.query(`SELECT * FROM conversations WHERE id = $1`, [conv.id]);
    const msgsRes = await db.query(
      `SELECT id, direction, content, message_type, got_reply, reply_time_seconds, created_at
       FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [conv.id]
    );
    res.json({ conversation: fullRes.rows[0], messages: msgsRes.rows });
  } catch (err) {
    console.error('[qc/pull-random] error', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Unified conversation view — merges ghl_messages (complete archive)
// with local messages table (for Claude turn attribution).
//
// Returns every message in timestamp order, each tagged with source:
//   user         → inbound
//   claude       → outbound + matched in local messages table
//   botpress     → outbound + matches Botpress content patterns
//   ghl_workflow → outbound + first outbound of the thread (drip opener)
//   unknown      → outbound + none of the above (likely manual agent)
//
// Backs the QC Portal detail view, Analyzer detail view, and Word
// Track cluster detail view. One endpoint, one source of truth.
// ============================================================
const ghlConv = require('../services/ghlConversations');

async function buildUnifiedThread(ghlConversationId, locationId) {
  const msgsQ = await db.query(
    `SELECT id, direction, content, message_type, created_at, cluster_id, ghl_message_id, delivery_status
       FROM ghl_messages
      WHERE ghl_conversation_id = $1 AND location_id = $2
      ORDER BY created_at ASC`,
    [ghlConversationId, locationId]
  );
  const ghlRows = msgsQ.rows;

  // Pull local Claude bot messages by contact_id so we can match timestamps.
  // A content/timestamp match = this outbound came from our Claude bot.
  const convQ = await db.query(
    `SELECT contact_id FROM ghl_conversations WHERE ghl_conversation_id = $1 AND location_id = $2`,
    [ghlConversationId, locationId]
  );
  const contactId = convQ.rows[0]?.contact_id;

  const claudeSet = new Set(); // content fingerprints (first 80 chars) from local msgs
  const claudeTimestamps = []; // [{ts, content}] for fuzzy match
  if (contactId) {
    const localQ = await db.query(
      `SELECT m.content, m.created_at, m.message_type
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE c.contact_id = $1 AND c.location_id = $2 AND m.direction = 'outbound'`,
      [contactId, locationId]
    );
    for (const r of localQ.rows) {
      const fp = String(r.content || '').trim().slice(0, 80).toLowerCase();
      if (fp) {
        claudeSet.add(fp);
        claudeTimestamps.push({ ts: new Date(r.created_at).getTime(), content: fp });
      }
    }
  }

  // Fingerprint index for dedup when merging local messages. A message is "same"
  // if content-first-80-chars matches AND timestamps are within a ~5-min window.
  // GHL's pulled timestamps can drift a few seconds vs. our local store; short
  // inbound replies like "STOP" or "Yes" also match on content alone since
  // those are practically always unique per conversation.
  const BUCKET_MS = 300000; // 5 minutes
  const fpKey = (content, bucket) => {
    const body = String(content || '').trim().slice(0, 80).toLowerCase();
    return body + '|' + bucket;
  };
  const fpAdd = (seen, content, ts) => {
    const bucket = Math.floor((ts || 0) / BUCKET_MS);
    seen.add(fpKey(content, bucket));
    // Register adjacent buckets too so a sub-second spread across a boundary
    // still dedups (e.g. one source at 21:47:59.999, other at 21:48:00.001).
    seen.add(fpKey(content, bucket - 1));
    seen.add(fpKey(content, bucket + 1));
    const body = String(content || '').trim().toLowerCase();
    if (body.length > 0 && body.length <= 12) seen.add('shortbody|' + body);
  };
  const fpHas = (seen, content, ts) => {
    const bucket = Math.floor((ts || 0) / BUCKET_MS);
    if (seen.has(fpKey(content, bucket))) return true;
    const body = String(content || '').trim().toLowerCase();
    if (body.length > 0 && body.length <= 12 && seen.has('shortbody|' + body)) return true;
    return false;
  };
  const seenFp = new Set();

  let firstOutboundFound = false;
  const out = [];
  for (const r of ghlRows) {
    let source;
    if (r.direction === 'inbound') {
      source = 'user';
    } else {
      const fp = String(r.content || '').trim().slice(0, 80).toLowerCase();
      const ts = r.created_at ? new Date(r.created_at).getTime() : 0;
      // Claude match: exact-ish content or timestamp-within-2s + some content overlap.
      const byContent = claudeSet.has(fp);
      const byTimestamp = claudeTimestamps.some((c) => Math.abs(c.ts - ts) < 2000 && c.content.slice(0, 40) === fp.slice(0, 40));
      if (byContent || byTimestamp) {
        source = 'claude';
      } else if (ghlConv.isBotpressStyleOutbound(r.content || '') || ghlConv.isClaudeJsonPayload(r.content || '')) {
        // JSON payload in ghl_messages that didn't match local messages is a
        // stale Claude send from before the local store existed — still Claude.
        source = ghlConv.isClaudeJsonPayload(r.content || '') ? 'claude' : 'botpress';
      } else if (!firstOutboundFound) {
        source = 'ghl_workflow';
      } else {
        source = 'unknown';
      }
      firstOutboundFound = true;
    }
    const ts = r.created_at ? new Date(r.created_at).getTime() : 0;
    fpAdd(seenFp, r.content, ts);
    out.push({
      id: r.id,
      ghl_message_id: r.ghl_message_id,
      direction: r.direction,
      content: r.content,
      message_type: r.message_type,
      created_at: r.created_at,
      cluster_id: r.cluster_id,
      delivery_status: r.delivery_status || null,
      source,
      editable: source === 'claude'
    });
  }

  // --- Merge local conversations.messages JSONB + messages table ---
  // When GHL pull is stale/incomplete (common — pulls are manual), the local
  // store often has the actual bot turns that haven't synced back yet. We
  // append anything not already represented in ghl_messages, then resort.
  if (contactId) {
    const localConvQ = await db.query(
      `SELECT id, messages FROM conversations
        WHERE contact_id = $1 AND location_id = $2
        ORDER BY last_message_at DESC NULLS LAST
        LIMIT 1`,
      [contactId, locationId]
    );
    const convRow = localConvQ.rows[0];
    if (convRow) {
      const jsonbMsgs = Array.isArray(convRow.messages) ? convRow.messages : [];
      for (const m of jsonbMsgs) {
        const ts = m.timestamp ? new Date(m.timestamp).getTime() : 0;
        const isOutbound = m.role === 'assistant';
        let text = String(m.content || '');
        if (isOutbound && text.includes('{') && text.includes('"messages"')) {
          // Claude responses store as raw JSON; extract the messages array.
          try {
            const parsed = JSON.parse(text);
            if (parsed && Array.isArray(parsed.messages) && parsed.messages.length) {
              text = parsed.messages.join('\n');
            }
          } catch { /* fall through, keep raw */ }
        }
        if (fpHas(seenFp, text, ts)) continue;
        fpAdd(seenFp, text, ts);
        out.push({
          id: null,
          ghl_message_id: null,
          direction: isOutbound ? 'outbound' : 'inbound',
          content: text,
          message_type: null,
          created_at: m.timestamp || null,
          cluster_id: null,
          source: isOutbound ? 'claude' : 'user',
          editable: isOutbound
        });
      }

      // Also merge rows from messages table (keyed by conversation_id) — these
      // are the persisted per-turn rows that may include cluster_ids the JSONB
      // doesn't have. Dedup against everything we've already collected.
      const tableMsgsQ = await db.query(
        `SELECT id, direction, content, message_type, created_at
           FROM messages WHERE conversation_id = $1
          ORDER BY created_at ASC`,
        [convRow.id]
      );
      for (const m of tableMsgsQ.rows) {
        const ts = m.created_at ? new Date(m.created_at).getTime() : 0;
        if (fpHas(seenFp, m.content, ts)) continue;
        fpAdd(seenFp, m.content, ts);
        out.push({
          id: null,
          ghl_message_id: null,
          direction: m.direction,
          content: m.content,
          message_type: m.message_type,
          created_at: m.created_at,
          cluster_id: null,
          source: m.direction === 'inbound' ? 'user' : 'claude',
          editable: m.direction === 'outbound'
        });
      }
    }
  }

  // Sort merged results by timestamp ascending so the thread reads naturally.
  out.sort((a, b) => {
    const at = a.created_at ? new Date(a.created_at).getTime() : 0;
    const bt = b.created_at ? new Date(b.created_at).getTime() : 0;
    return at - bt;
  });
  return out;
}

router.get('/qc/conversation-thread/:ghl_conversation_id', async (req, res) => {
  try {
    const { ghl_conversation_id } = req.params;
    const location_id = req.query.location_id;
    if (!location_id) return res.status(400).json({ error: 'location_id required' });
    const meta = await db.query(
      `SELECT gc.*, COALESCE(s.name, gc.location_id) AS subaccount_name
         FROM ghl_conversations gc
         LEFT JOIN subaccounts s ON s.ghl_location_id = gc.location_id
        WHERE gc.ghl_conversation_id = $1 AND gc.location_id = $2`,
      [ghl_conversation_id, location_id]
    );
    if (!meta.rows[0]) return res.status(404).json({ error: 'not found' });
    const thread = await buildUnifiedThread(ghl_conversation_id, location_id);
    res.json({ conversation: meta.rows[0], thread });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Lookup by local conversation id → resolve to ghl_conversation_id + render.
router.get('/qc/conversation-thread-by-local/:local_id', async (req, res) => {
  try {
    const localId = parseInt(req.params.local_id, 10);
    const convQ = await db.query(
      `SELECT c.*, COALESCE(s.name, c.location_id) AS subaccount_name
         FROM conversations c
         LEFT JOIN subaccounts s ON s.ghl_location_id = c.location_id
        WHERE c.id = $1`,
      [localId]
    );
    const conv = convQ.rows[0];
    if (!conv) return res.status(404).json({ error: 'not found' });
    // Find the matching ghl_conversations row.
    const ghlQ = await db.query(
      `SELECT ghl_conversation_id FROM ghl_conversations
        WHERE contact_id = $1 AND location_id = $2
        ORDER BY last_message_at DESC LIMIT 1`,
      [conv.contact_id, conv.location_id]
    );
    const ghlId = ghlQ.rows[0]?.ghl_conversation_id;
    if (!ghlId) {
      // Fallback: build from local messages only.
      const msgs = await db.query(
        `SELECT id, direction, content, message_type, created_at
           FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
        [localId]
      );
      return res.json({
        conversation: conv,
        thread: msgs.rows.map((m) => ({
          ...m,
          source: m.direction === 'inbound' ? 'user' : 'claude',
          editable: m.direction === 'outbound'
        })),
        fallback: 'local_only'
      });
    }
    const thread = await buildUnifiedThread(ghlId, conv.location_id);
    res.json({ conversation: conv, thread, ghl_conversation_id: ghlId });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Get full conversation by ID (for QC panel)
router.get('/conversations/:id/full', async (req, res) => {
  try {
    const { id } = req.params;
    const convRes = await db.query(`SELECT * FROM conversations WHERE id = $1`, [id]);
    if (!convRes.rows.length) return res.status(404).json({ error: 'not found' });
    const msgsRes = await db.query(
      `SELECT id, direction, content, message_type, got_reply, reply_time_seconds, segments, created_at
       FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [id]
    );
    res.json({ conversation: convRes.rows[0], messages: msgsRes.rows });
  } catch (err) {
    console.error('[conversation/full] error', err);
    res.status(500).json({ error: err.message });
  }
});

// Generate Sample Wordtracks: simulate N conversations, score them with Claude,
// and return a batch grid for human review.
const sandboxRoutes = require('./sandbox');
async function runSimConversation(profile) {
  const variables = {
    first_name: profile.first_name,
    state: profile.state,
    offer: profile.offer,
    bot_name: 'Sarah',
    agent_name: 'Jeremiah',
    contact_stage: 'lead',
    existing_age: profile.existing_age,
    existing_smoker: profile.existing_smoker,
    existing_health: profile.existing_health,
    tags: ''
  };

  // Reset & create sandbox conversation for this profile
  await store.deleteSandboxConversation();
  const parsed = {
    contact_id: 'sandbox_user',
    location_id: 'sandbox_location',
    phone: '',
    first_name: variables.first_name || 'Test',
    last_name: '',
    state: variables.state || 'FL',
    product_type: determineProductType(variables.offer),
    contact_stage: variables.contact_stage || 'lead',
    is_ca: determineIsCa(variables.state),
    existing_dob: '',
    existing_age: variables.existing_age || '',
    existing_smoker: variables.existing_smoker || '',
    existing_health: variables.existing_health || '',
    existing_spouse_name: '',
    existing_mortgage_balance: '',
    existing_coverage_subject: '',
    bot_name: variables.bot_name || 'Sarah',
    agent_name: variables.agent_name || 'Jeremiah',
    agent_phone: '',
    agent_business_card_url: '',
    calendar_link_fx: '', calendar_link_mp: '', loom_video_fx: '', loom_video_mp: '',
    meeting_type: 'Phone',
    ghl_token: '',
    ghl_message_history: '',
    offer: variables.offer || '',
    offer_short: '', language: '', marketplace_type: '', consent_status: '',
    tags: []
  };

  const conv0 = await store.upsertConversation(parsed, { is_sandbox: true });

  const thread = [];
  const personaSystem = `You are a ${profile.persona.replace(/_/g, ' ')} insurance lead named ${profile.first_name} from ${profile.state}. Reply short, casual, lowercase, real-human texting. No quotes, no json, just the SMS text. If you'd abandon the conversation, reply exactly <<<END_SIM>>>.`;

  let terminal = null;
  for (let turn = 0; turn < 16; turn++) {
    // Lead reply
    const msgs = thread.map((m) => m.role === 'bot' ? { role: 'user', content: m.text } : { role: 'assistant', content: m.text });
    if (!msgs.length) msgs.push({ role: 'user', content: '(the agent has not replied yet — send your first short message as the lead)' });
    const leadResp = await callAnthropic(
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        system: personaSystem,
        messages: msgs
      },
      {
        category: 'qc_sim_score',
        location_id: parsed.location_id || null,
        meta: { phase: 'lead_reply', persona: profile.persona }
      }
    );
    const leadText = (leadResp.content.find((b) => b.type === 'text')?.text || '').trim();
    if (!leadText || /^<<<END_SIM>>>$/.test(leadText)) { terminal = terminal || 'lead_abandoned'; break; }
    thread.push({ role: 'lead', text: leadText });

    const conv = await store.upsertConversation(parsed, { is_sandbox: true });
    const history = Array.isArray(conv.messages) ? conv.messages : [];
    const bot = await claude.generateResponse(conv, history, leadText);
    await store.appendMessageHistory(conv.id, 'user', leadText);
    await store.appendMessageHistory(conv.id, 'assistant', bot.rawAssistantContent);
    for (const m of (bot.messages || [])) thread.push({ role: 'bot', text: m, message_type: bot.message_type });
    if (bot.terminal_outcome) { terminal = bot.terminal_outcome; break; }
  }

  // Auto-score with Claude
  const transcript = thread.map((m, i) => `${i + 1}. ${m.role === 'bot' ? 'BOT' : 'LEAD'}: ${m.text}`).join('\n');
  const scoreResp = await callAnthropic(
    {
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      system: `You are grading a SMS qualification bot conversation. Respond ONLY with JSON: { "score": 0-100, "grade": "Good|OK|Wrong", "reason": "one sentence" }. Good ≥80, OK 50-79, Wrong <50.`,
      messages: [{ role: 'user', content: `Persona: ${profile.persona}\nOutcome: ${terminal || 'incomplete'}\n\nTranscript:\n${transcript}` }]
    },
    {
      category: 'qc_sim_score',
      location_id: parsed.location_id || null,
      meta: { phase: 'scoring', persona: profile.persona, terminal: terminal || 'incomplete' }
    }
  );
  let score = { score: null, grade: 'OK', reason: '' };
  try {
    const t = (scoreResp.content.find((b) => b.type === 'text')?.text || '').trim();
    const m = t.match(/\{[\s\S]*\}/);
    if (m) score = { ...score, ...JSON.parse(m[0]) };
  } catch {}

  return {
    profile,
    thread,
    terminal_outcome: terminal,
    turns: thread.length,
    score
  };
}

router.post('/qc/generate-sample-wordtracks', async (req, res) => {
  try {
    const { scenario = 'all' } = req.body || {};
    const profiles = scenarioFilter(scenario);
    const results = [];
    for (const profile of profiles) {
      try {
        const result = await runSimConversation(profile);
        results.push(result);
      } catch (err) {
        logger.log('qc', 'error', null, 'Sample sim failed', { profile: profile.first_name, error: err.message });
        results.push({ profile, error: err.message });
      }
    }

    // Create pending_prompt_changes entries for any "Wrong" grades
    for (const r of results) {
      if (r.score && r.score.grade === 'Wrong') {
        try {
          await db.query(
            `INSERT INTO pending_prompt_changes (source, change_type, description, proposed_by)
             VALUES ('qc', 'correction', $1, 'qc_auto_generator')`,
            [`Simulated sample with "${r.profile.persona}" persona graded Wrong: ${r.score.reason || 'no reason'}`]
          );
        } catch {}
      }
    }

    res.json({ scenario, count: results.length, results });
  } catch (err) {
    logger.log('qc', 'error', null, 'generate-sample-wordtracks failed', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

router.post('/qc/flag-wrong', async (req, res) => {
  try {
    const { description, conversation_id } = req.body || {};
    if (!description) return res.status(400).json({ error: 'description required' });
    await db.query(
      `INSERT INTO pending_prompt_changes (source, change_type, description, example_conversation_id, proposed_by)
       VALUES ('qc', 'correction', $1, $2, $3)`,
      [description, conversation_id || null, req.session?.username || null]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Unified "All Conversations" — every conversation that has at least one
// inbound reply, regardless of source (claude/botpress/other/drip).
//
// Bug-fix notes vs. prior version:
//  1. LEFT JOIN → LATERAL: old plain LEFT JOIN produced N rows per Claude
//     conversation when a contact had N ghl_conversations rows (e.g. re-opened
//     contact). LATERAL + LIMIT 1 guarantees 1:1.
//  2. Inbound filter broadened: old `EXISTS messages WHERE direction='inbound'`
//     excluded conversations whose history lived only in the JSONB column (rows
//     predating consistent messages-table logging). Now checks JSONB as well.
//  3. Search now matches GHL contact_name, phone, and individual name parts in
//     addition to the full concatenated name — fixes mismatches where GHL sent
//     a different first_name to the webhook than what appears in the GHL UI.
//  4. Count query uses same LATERAL so the count matches the row set.
// ============================================================
router.get('/qc/all-conversations', async (req, res) => {
  try {
    const { page = 1, limit = 20, search, source, from_date } = req.query;
    const lim = Math.min(parseInt(limit, 10) || 20, 200);
    const off = (Math.max(parseInt(page, 10) || 1, 1) - 1) * lim;

    const baseParams = [];
    let p = 1;

    // Claude-bot side: primary source is local `conversations` table — always
    // current regardless of GHL pull cadence. LATERAL join fetches the most
    // recent ghl_conversations row (if any) for enrichment only.
    const claudeClauses = [
      `c.is_sandbox = FALSE`,
      // Broadened: check messages table first, fall back to JSONB history.
      // Old conversations may only have JSONB entries if they predate consistent
      // messages-table logging, so requiring the table row alone excluded them.
      `(EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'inbound')
        OR jsonb_array_length(COALESCE(c.messages,'[]'::jsonb)) > 0)`
    ];

    // Non-Claude side: botpress / drip / GHL-only contacts (not in our conversations table).
    // Show a conversation if:
    //  a) we've pulled its messages and found at least one inbound, OR
    //  b) we've pulled its messages and the count is > 0 (updateConversationAggregates set it).
    // This means drip-only contacts who've never replied are excluded, but any
    // conversation that has been pulled and has activity shows up even if we
    // later re-check the inbound filter via ghl_messages.
    const ghlOnlyClauses = [
      `NOT EXISTS (SELECT 1 FROM conversations cx WHERE cx.contact_id = gc.contact_id AND cx.location_id = gc.location_id)`,
      `(gc.message_count > 0 OR EXISTS (SELECT 1 FROM ghl_messages im WHERE im.ghl_conversation_id = gc.ghl_conversation_id AND im.location_id = gc.location_id AND im.direction = 'inbound'))`
    ];

    // source filter: 'claude' → skip ghl-only side; non-claude → skip claude side
    let includeClaude = !source || source === 'all' || source === 'claude';
    let includeGhlOnly = !source || source === 'all' || (source !== 'claude');

    if (source && source !== 'all') {
      if (source !== 'claude') {
        baseParams.push(source);
        ghlOnlyClauses.push(`gc.source = $${p++}`);
      }
    }
    if (search && String(search).trim()) {
      const sVal = '%' + String(search).trim().toLowerCase() + '%';
      baseParams.push(sVal);
      // Claude side: match full name, each part, phone, OR the GHL contact_name.
      // The GHL contact_name check catches cases where the webhook received a
      // different first_name than the GHL UI shows (typo in GHL data at send time).
      claudeClauses.push(`(
        LOWER(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,''))) LIKE $${p}
        OR LOWER(COALESCE(c.first_name,'')) LIKE $${p}
        OR LOWER(COALESCE(c.last_name,'')) LIKE $${p}
        OR COALESCE(c.phone,'') LIKE $${p}
        OR LOWER(COALESCE(gc.contact_name,'')) LIKE $${p}
      )`);
      ghlOnlyClauses.push(`(
        LOWER(COALESCE(gc.contact_name,'')) LIKE $${p}
        OR COALESCE(gc.contact_phone,'') LIKE $${p}
      )`);
      p++;
    }
    if (from_date && /^\d{4}-\d{2}-\d{2}$/.test(String(from_date))) {
      baseParams.push(from_date);
      claudeClauses.push(`c.last_message_at >= $${p}::date`);
      ghlOnlyClauses.push(`gc.last_message_at >= $${p}::date`);
      p++;
    }

    const claudeWhere = 'WHERE ' + claudeClauses.join(' AND ');
    const ghlOnlyWhere = 'WHERE ' + ghlOnlyClauses.join(' AND ');
    const params = [...baseParams, lim, off];
    const limIdx = p; const offIdx = p + 1;

    // Claude bot conversations — driven by local conversations table (always fresh).
    // LATERAL join gets at most 1 ghl_conversations row (most recent) per contact,
    // preventing the N-duplicate problem when a contact has multiple GHL threads.
    // contact_name falls back to ghl contact_name when local name fields are blank.
    const claudeSelect = includeClaude ? `
      SELECT c.id AS conv_pk,
             gc.ghl_conversation_id,
             c.location_id,
             c.contact_id,
             COALESCE(NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), ''), gc.contact_name) AS contact_name,
             c.phone AS contact_phone,
             'claude'::varchar AS source,
             GREATEST(
               (SELECT COUNT(*)::int FROM messages m WHERE m.conversation_id = c.id),
               jsonb_array_length(COALESCE(c.messages,'[]'::jsonb))
             ) AS message_count,
             c.terminal_outcome,
             c.product_type,
             GREATEST(c.last_message_at, gc.last_message_at) AS last_message_at,
             COALESCE(s.name, c.location_id) AS subaccount_name,
             c.id AS claude_conv_id
        FROM conversations c
        LEFT JOIN LATERAL (
          SELECT ghl_conversation_id, last_message_at, contact_name
          FROM ghl_conversations
          WHERE contact_id = c.contact_id AND location_id = c.location_id
          ORDER BY last_message_at DESC NULLS LAST
          LIMIT 1
        ) gc ON TRUE
        LEFT JOIN subaccounts s ON s.ghl_location_id = c.location_id
       ${claudeWhere}` : '';

    // Non-Claude conversations from GHL (botpress, drip) that aren't in our bot table.
    const ghlOnlySelect = includeGhlOnly ? `
      SELECT gc.id AS conv_pk,
             gc.ghl_conversation_id,
             gc.location_id,
             gc.contact_id,
             gc.contact_name,
             gc.contact_phone,
             gc.source,
             gc.message_count,
             gc.terminal_outcome,
             NULL::varchar AS product_type,
             gc.last_message_at,
             COALESCE(s.name, gc.location_id) AS subaccount_name,
             NULL::int AS claude_conv_id
        FROM ghl_conversations gc
        LEFT JOIN subaccounts s ON s.ghl_location_id = gc.location_id
       ${ghlOnlyWhere}` : '';

    const unionSql = [claudeSelect, ghlOnlySelect].filter(Boolean).join(' UNION ALL ');

    const q = await db.query(
      `SELECT * FROM (${unionSql}) combined
        ORDER BY last_message_at DESC NULLS LAST
        LIMIT $${limIdx} OFFSET $${offIdx}`,
      params
    );

    // Count uses same LATERAL so it matches the actual row set (no duplicate inflation).
    const countQ = await db.query(
      `SELECT COUNT(*)::int AS total FROM (
         ${[
           includeClaude ? `
             SELECT 1 FROM conversations c
             LEFT JOIN LATERAL (
               SELECT contact_name FROM ghl_conversations
               WHERE contact_id = c.contact_id AND location_id = c.location_id
               ORDER BY last_message_at DESC NULLS LAST LIMIT 1
             ) gc ON TRUE
             ${claudeWhere}` : '',
           includeGhlOnly ? `SELECT 1 FROM ghl_conversations gc ${ghlOnlyWhere}` : ''
         ].filter(Boolean).join(' UNION ALL ')}
       ) counted`,
      baseParams
    );

    res.json({ conversations: q.rows, total: countQ.rows[0]?.total || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Pull all known locations from GHL — surfaces conversations that only
// exist in GHL (drip/botpress contacts who haven't triggered our webhook).
// Uses tokens stored in conversations or subaccounts tables; no credentials
// needed from the caller.
// ============================================================
async function findGhlTokenForLocationLocal(locationId) {
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

router.post('/qc/pull-all-locations', async (req, res) => {
  try {
    const fullRepull = !!req.body?.fullRepull;
    const onlyLocationId = req.body?.locationId || null; // optional: target a single location

    // Gather every location that has a usable GHL token.
    const [convLocs, subLocs] = await Promise.all([
      db.query(`SELECT DISTINCT location_id FROM conversations WHERE ghl_token IS NOT NULL AND ghl_token <> '' AND is_sandbox = FALSE`),
      db.query(`SELECT DISTINCT ghl_location_id AS location_id FROM subaccounts WHERE ghl_api_key IS NOT NULL AND ghl_api_key <> ''`)
    ]);
    const seen = new Set();
    let locationIds = [];
    for (const r of [...convLocs.rows, ...subLocs.rows]) {
      if (!seen.has(r.location_id)) { seen.add(r.location_id); locationIds.push(r.location_id); }
    }
    if (onlyLocationId) locationIds = locationIds.filter(id => id === onlyLocationId);

    if (!locationIds.length) {
      return res.json({ ok: true, message: 'No locations with stored GHL tokens found.', started: [] });
    }

    const jobs = require('../services/jobs');
    const ghlConv = require('../services/ghlConversations');
    const started = [];

    for (const locationId of locationIds) {
      const token = await findGhlTokenForLocationLocal(locationId);
      if (!token) continue;

      const jobId = await jobs.createJob({
        type: fullRepull ? 'ghl_full_repull' : 'ghl_incremental_pull',
        params: { locationId, fullRepull },
        startedBy: req.session?.username || 'qc_pull_all'
      });

      jobs.spawn(jobId, async (reporter) => {
        reporter.report({ message: `Pulling ${locationId}…` });
        const result = await ghlConv.pullAndStore(token, locationId, (p) => {
          reporter.report({ current: p.fetched, message: `pulling: ${p.fetched} fetched` });
        }, { fullRepull });
        reporter.report({ message: 'done' });
        return result;
      });

      started.push({ locationId, jobId });
    }

    // When a full repull is triggered, write the sync timestamp once all
    // spawned jobs complete. Poll the jobs table every 5s in the background;
    // avoids coupling timestamp accuracy to whichever job finishes last.
    if (fullRepull && started.length > 0) {
      const batchJobIds = started.map((s) => s.jobId);
      (async () => {
        try {
          while (true) {
            await new Promise((r) => setTimeout(r, 5000));
            const q = await db.query(
              `SELECT COUNT(*) FILTER (WHERE status IN ('queued', 'running'))::int AS pending FROM jobs WHERE id = ANY($1)`,
              [batchJobIds]
            );
            if (!q.rows[0]?.pending) break;
          }
          await db.query(
            `INSERT INTO app_settings (section, key, value) VALUES ('ghl_sync', 'last_full_repull_at', $1)
             ON CONFLICT (section, key) DO UPDATE SET value = EXCLUDED.value`,
            [new Date().toISOString()]
          );
          logger.log('qc', 'info', null, 'full_repull sync timestamp updated', { jobs: batchJobIds.length });
        } catch (e) {
          logger.log('qc', 'error', null, 'sync timestamp write failed', { error: e.message });
        }
      })();
    }

    logger.log('qc', 'info', null, 'pull-all-locations triggered', { count: started.length, fullRepull, by: req.session?.username });
    res.json({ ok: true, started, fullRepull, location_count: started.length });
  } catch (err) {
    logger.log('qc', 'error', null, 'pull-all-locations failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Botpress archive tab — pulls from ghl_messages WHERE source='botpress'
// AND the conversation had at least one inbound reply (not drip-into-void).
// Tagged explicitly as archive in the UI; edits feed the same pending queue.
// ============================================================
router.get('/qc/botpress-archive', async (req, res) => {
  try {
    const { page = 1, limit = 20, location_id } = req.query;
    const lim = Math.min(parseInt(limit, 10) || 20, 100);
    const off = (Math.max(parseInt(page, 10) || 1, 1) - 1) * lim;
    const params = [];
    let locFilter = '';
    if (location_id) { params.push(location_id); locFilter = ` AND gc.location_id = $${params.length}`; }
    params.push(lim); params.push(off);

    const q = await db.query(
      `SELECT gc.id AS conv_pk,
              gc.ghl_conversation_id,
              gc.location_id,
              gc.contact_name,
              gc.contact_phone,
              gc.message_count,
              gc.terminal_outcome,
              gc.last_message_at,
              COALESCE(s.name, gc.location_id) AS subaccount_name
         FROM ghl_conversations gc
         LEFT JOIN subaccounts s ON s.ghl_location_id = gc.location_id
        WHERE gc.source = 'botpress'
          AND EXISTS (SELECT 1 FROM ghl_messages im
                        WHERE im.ghl_conversation_id = gc.ghl_conversation_id
                          AND im.location_id = gc.location_id
                          AND im.direction = 'inbound')
          ${locFilter}
        ORDER BY gc.last_message_at DESC NULLS LAST
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ conversations: q.rows, archive_tag: 'Archive / OldBot / Botpress' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/qc/botpress-archive/:ghl_conversation_id', async (req, res) => {
  try {
    const { ghl_conversation_id } = req.params;
    const { location_id } = req.query;
    if (!location_id) return res.status(400).json({ error: 'location_id required' });
    const conv = await db.query(
      `SELECT gc.*, COALESCE(s.name, gc.location_id) AS subaccount_name
         FROM ghl_conversations gc
         LEFT JOIN subaccounts s ON s.ghl_location_id = gc.location_id
        WHERE gc.ghl_conversation_id = $1 AND gc.location_id = $2`,
      [ghl_conversation_id, location_id]
    );
    if (!conv.rows[0]) return res.status(404).json({ error: 'not found' });
    const msgs = await db.query(
      `SELECT id, direction, content, message_type, cluster_id, created_at
         FROM ghl_messages
        WHERE ghl_conversation_id = $1 AND location_id = $2
        ORDER BY created_at ASC`,
      [ghl_conversation_id, location_id]
    );
    res.json({
      conversation: conv.rows[0],
      messages: msgs.rows,
      archive_tag: 'Archive / OldBot / Botpress'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /qc/flag-message — reviewer clicks a bot bubble and submits a replacement.
// source='claude'        → prompt_fix, goes into pending_prompt_changes for Apply
// source='botpress'|'ghl_workflow' → wordtrack_fix, dev-queue reminder for Walt
router.post('/qc/flag-message', async (req, res) => {
  try {
    const { original, replacement, source, conversation_id } = req.body || {};
    if (!original || !replacement) return res.status(400).json({ error: 'original and replacement required' });
    const isWordtrack = source === 'botpress' || source === 'ghl_workflow';
    const changeType = isWordtrack ? 'wordtrack_fix' : 'prompt_fix';
    const description = (isWordtrack ? '[WORD TRACK FIX]\n' : '[PROMPT FIX]\n') +
      `ORIGINAL:\n${original}\n\nREPLACEMENT:\n${replacement}`;
    const r = await db.query(
      `INSERT INTO pending_prompt_changes (source, change_type, description, proposed_by, example_conversation_id)
       VALUES ($1, $2, $3, 'qc_flag', $4) RETURNING id`,
      [isWordtrack ? 'wordtrack' : 'claude', changeType, description, conversation_id || null]
    );
    logger.log('qc', 'info', null, 'message flagged', { source, changeType, id: r.rows[0].id });
    res.json({ ok: true, id: r.rows[0].id, change_type: changeType, is_wordtrack: isWordtrack });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Cluster filter — "show every attempt at word track X" across all
// conversations. Pulls outbound cluster messages + their reply (if any).
// ============================================================
router.get('/qc/by-cluster/:cluster_id', async (req, res) => {
  try {
    const clusterId = parseInt(req.params.cluster_id, 10);
    const { limit = 50, source } = req.query;
    const lim = Math.min(parseInt(limit, 10) || 50, 200);
    const params = [clusterId, lim];
    let srcFilter = '';
    if (source === 'claude' || source === 'botpress' || source === 'other') {
      params.splice(1, 0, source);
      srcFilter = ` AND gc.source = $2`;
    }
    const cluster = (await db.query(
      `SELECT id, label, description, source, example_text, cluster_size
         FROM word_track_clusters WHERE id = $1`,
      [clusterId]
    )).rows[0];
    if (!cluster) return res.status(404).json({ error: 'cluster not found' });

    const q = await db.query(
      `SELECT m.id AS msg_id, m.ghl_conversation_id, m.location_id, m.content, m.created_at,
              gc.contact_name, gc.contact_phone, gc.source, gc.terminal_outcome,
              (SELECT content FROM ghl_messages im
                 WHERE im.ghl_conversation_id = m.ghl_conversation_id
                   AND im.location_id = m.location_id
                   AND im.direction = 'inbound'
                   AND im.created_at > m.created_at
                 ORDER BY im.created_at ASC LIMIT 1) AS reply_content
         FROM ghl_messages m
         JOIN ghl_conversations gc ON gc.ghl_conversation_id = m.ghl_conversation_id AND gc.location_id = m.location_id
        WHERE m.cluster_id = $1
          AND m.direction = 'outbound'
          ${srcFilter}
        ORDER BY m.created_at DESC
        LIMIT $${params.length}`,
      params
    );
    res.json({ cluster, samples: q.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// BATCHED FLUSH — takes every pending_prompt_changes row, sends ONE
// Claude call (category=qc_batch_apply) that rewrites the system prompt
// incorporating all of them. Marks each row as 'applied'.
//
// This is the core "you have X edits pending → apply" flow. Do NOT call
// this per-edit. The UI accumulates edits locally, then POSTs once.
// ============================================================
router.get('/qc/pending-edits-count', async (req, res) => {
  try {
    const q = await db.query(
      `SELECT COUNT(*)::int AS n FROM pending_prompt_changes WHERE status = 'pending'`
    );
    res.json({ pending: q.rows[0]?.n || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/qc/pending-edits', async (req, res) => {
  try {
    const q = await db.query(
      `SELECT id, source, change_type, description, proposed_by, created_at
         FROM pending_prompt_changes
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT 50`
    );
    res.json({ ok: true, edits: q.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/qc/apply-pending', async (req, res) => {
  try {
    const { dry_run = false } = req.body || {};
    const pendingQ = await db.query(
      `SELECT id, source, change_type, description, example_conversation_id, proposed_by, created_at
         FROM pending_prompt_changes
        WHERE status = 'pending'
        ORDER BY created_at ASC`
    );
    const pending = pendingQ.rows;
    if (!pending.length) {
      return res.json({ ok: true, pending_count: 0, applied: 0, message: 'No pending edits.' });
    }

    const analyzerModule = require('./analyzer');
    const getCurrentPrompt = analyzerModule.getCurrentPrompt;
    const saveCurrentPrompt = analyzerModule.saveCurrentPrompt;
    const currentPrompt = await getCurrentPrompt();

    const changesBlock = pending.map((p, i) => {
      const typeTag = p.change_type ? `[${p.change_type}]` : '';
      const source = p.source ? ` (from ${p.source})` : '';
      return `${i + 1}. ${typeTag}${source} ${p.description}`;
    }).join('\n');

    const system = `You are a prompt engineer merging a batch of QC-reviewer corrections and improvements into an SMS bot system prompt. Apply every change precisely. Preserve the existing structure, tone rules, knowledge base content, and JSON response format contract. If two changes conflict, favor the newer one and note the conflict in a brief trailing comment block. Output ONLY the full revised prompt text with no markdown fences and no preamble.`;
    const userContent = `CURRENT SYSTEM PROMPT:\n\n${currentPrompt}\n\n---\n\nPENDING EDITS TO APPLY (${pending.length} total):\n${changesBlock}\n\n---\n\nReturn the full updated system prompt.`;

    const resp = await callAnthropic(
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 10000,
        system,
        messages: [{ role: 'user', content: userContent }]
      },
      {
        category: 'qc_batch_apply',
        location_id: null,
        meta: { pending_count: pending.length, dry_run: !!dry_run }
      }
    );

    const newPrompt = (resp.content.find((b) => b.type === 'text')?.text || '').trim();
    if (!newPrompt) {
      return res.status(500).json({ error: 'Claude returned empty prompt' });
    }

    if (dry_run) {
      return res.json({
        ok: true, dry_run: true, pending_count: pending.length,
        preview: newPrompt.slice(0, 2000),
        applied_ids: []
      });
    }

    await saveCurrentPrompt(newPrompt);
    const ids = pending.map((p) => p.id);
    await db.query(
      `UPDATE pending_prompt_changes SET status = 'applied', resolved_at = NOW() WHERE id = ANY($1)`,
      [ids]
    );
    logger.log('qc', 'info', null, 'QC batch apply completed', { count: pending.length, by: req.session?.username });
    res.json({ ok: true, pending_count: pending.length, applied: pending.length, applied_ids: ids });
  } catch (err) {
    logger.log('qc', 'error', null, 'apply-pending failed', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// ============================================================
// BOT CONSOLE — alerts + Claude chat for word track / prompt changes
// ============================================================

// GET /qc/alerts — auto-generated alerts from word track perf + QC failures
router.get('/qc/alerts', async (req, res) => {
  try {
    const days = parseInt(req.query.days, 10) || 30;
    const alerts = [];

    // Word track workflows with low reply rates (min 20 sends to be significant)
    const wtQ = await db.query(`
      SELECT wf.id, wf.label, wf.example_opener,
             COALESCE(m.sends, 0) AS sends,
             COALESCE(m.replies, 0) AS replies,
             COALESCE(m.drop_offs, 0) AS drop_offs,
             COALESCE(m.bookings, 0) AS bookings
        FROM workflow_clusters wf
        LEFT JOIN (
          SELECT workflow_cluster_id,
                 COUNT(DISTINCT ghl_conversation_id)::int AS sends,
                 COUNT(DISTINCT ghl_conversation_id) FILTER (WHERE in_at IS NOT NULL)::int AS replies,
                 COUNT(DISTINCT ghl_conversation_id) FILTER (WHERE in_at IS NULL)::int AS drop_offs,
                 COUNT(DISTINCT ghl_conversation_id) FILTER (WHERE booked)::int AS bookings
            FROM (
              SELECT s.workflow_cluster_id, s.ghl_conversation_id, s.location_id,
                     (SELECT MIN(created_at) FROM ghl_messages im
                       WHERE im.ghl_conversation_id = s.ghl_conversation_id
                         AND im.location_id = s.location_id
                         AND im.direction = 'inbound'
                         AND im.created_at > s.out_at) AS in_at,
                     EXISTS (
                       SELECT 1 FROM conversations c
                        WHERE c.contact_id = (
                          SELECT contact_id FROM ghl_conversations gc
                           WHERE gc.ghl_conversation_id = s.ghl_conversation_id LIMIT 1)
                          AND c.terminal_outcome = 'appointment_booked'
                     ) AS booked
                FROM (
                  SELECT DISTINCT ON (m.ghl_conversation_id, m.location_id)
                         m.workflow_cluster_id, m.ghl_conversation_id, m.location_id, m.created_at AS out_at
                    FROM ghl_messages m
                   WHERE m.workflow_cluster_id IS NOT NULL
                     AND m.direction = 'outbound'
                     AND m.created_at >= NOW() - ($1 || ' days')::interval
                   ORDER BY m.ghl_conversation_id, m.location_id, m.created_at ASC
                ) s
            ) x GROUP BY workflow_cluster_id
        ) m ON m.workflow_cluster_id = wf.id
       WHERE COALESCE(m.sends, 0) >= 20
       ORDER BY (COALESCE(m.replies,0)::float / NULLIF(m.sends,0)) ASC NULLS LAST
       LIMIT 10`,
      [days]
    );

    for (const r of wtQ.rows) {
      const sends = Number(r.sends) || 0;
      const replies = Number(r.replies) || 0;
      const rate = sends > 0 ? replies / sends : 0;
      if (rate < 0.12) {
        alerts.push({
          type: 'word_track',
          severity: rate < 0.06 ? 'critical' : 'warning',
          title: `Low reply rate: "${r.label || 'Unnamed workflow'}"`,
          detail: `${(rate * 100).toFixed(1)}% reply rate on ${sends} sends. ${r.drop_offs} contacts dropped off without replying.`,
          example: r.example_opener ? r.example_opener.slice(0, 120) : null,
          workflow_id: r.id,
          metric: { sends, replies, rate }
        });
      }
    }

    // Word track clusters (individual message clusters) with low reply rates
    const clQ = await db.query(`
      SELECT wtc.id, wtc.label, wtc.example_text,
             COUNT(DISTINCT m.ghl_conversation_id)::int AS sends,
             COUNT(DISTINCT m.ghl_conversation_id) FILTER (
               WHERE EXISTS (
                 SELECT 1 FROM ghl_messages ir
                  WHERE ir.ghl_conversation_id = m.ghl_conversation_id
                    AND ir.location_id = m.location_id
                    AND ir.direction = 'inbound'
                    AND ir.created_at > m.created_at
               )
             )::int AS replies
        FROM word_track_clusters wtc
        JOIN ghl_messages m ON m.cluster_id = wtc.id
       WHERE m.direction = 'outbound'
         AND m.created_at >= NOW() - ($1 || ' days')::interval
       GROUP BY wtc.id, wtc.label, wtc.example_text
      HAVING COUNT(DISTINCT m.ghl_conversation_id) >= 15
       ORDER BY (COUNT(DISTINCT m.ghl_conversation_id) FILTER (
                   WHERE EXISTS (
                     SELECT 1 FROM ghl_messages ir
                      WHERE ir.ghl_conversation_id = m.ghl_conversation_id
                        AND ir.location_id = m.location_id
                        AND ir.direction = 'inbound'
                        AND ir.created_at > m.created_at
                   )
                 ))::float / NULLIF(COUNT(DISTINCT m.ghl_conversation_id), 0) ASC
       LIMIT 8`,
      [days]
    );

    for (const r of clQ.rows) {
      const sends = Number(r.sends) || 0;
      const replies = Number(r.replies) || 0;
      const rate = sends > 0 ? replies / sends : 0;
      if (rate < 0.10) {
        alerts.push({
          type: 'word_track_cluster',
          severity: rate < 0.05 ? 'critical' : 'warning',
          title: `Weak word track: "${r.label || 'Unlabeled cluster'}"`,
          detail: `${(rate * 100).toFixed(1)}% reply rate on ${sends} sends.`,
          example: r.example_text ? r.example_text.slice(0, 120) : null,
          cluster_id: r.id,
          metric: { sends, replies, rate }
        });
      }
    }

    // Recent QC failures
    const qcQ = await db.query(`
      SELECT COUNT(*)::int AS failed,
             COUNT(*) FILTER (WHERE outcome = 'modified')::int AS modified
        FROM qc_reviews
       WHERE created_at >= NOW() - '7 days'::interval`
    );
    const qcRow = qcQ.rows[0];
    if ((qcRow.failed || 0) >= 2) {
      alerts.push({
        type: 'qc_failures',
        severity: qcRow.failed >= 5 ? 'critical' : 'warning',
        title: `${qcRow.failed} QC failures in the last 7 days`,
        detail: `${qcRow.modified} conversations were marked "Modified" (bot said something wrong). Review the QC portal for details.`,
        example: null,
        metric: { failed: qcRow.failed, modified: qcRow.modified }
      });
    }

    // Pending prompt changes
    const pendQ = await db.query(`SELECT COUNT(*)::int AS n FROM pending_prompt_changes WHERE status = 'pending'`);
    const pendN = pendQ.rows[0]?.n || 0;
    if (pendN > 0) {
      alerts.push({
        type: 'pending_changes',
        severity: 'info',
        title: `${pendN} prompt change${pendN === 1 ? '' : 's'} queued and waiting`,
        detail: 'Go to the QC portal and hit "Apply Edits" to apply them to the live bot.',
        example: null,
        metric: { pending: pendN }
      });
    }

    // Sort: critical first, then warning, then info
    const order = { critical: 0, warning: 1, info: 2 };
    alerts.sort((a, b) => (order[a.severity] || 0) - (order[b.severity] || 0));

    res.json({ ok: true, alerts, days });
  } catch (err) {
    logger.log('qc', 'error', null, 'alerts failed', { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /qc/console — Claude chat for bot management
// Body: { message, history: [{role,content}], conversation_id?: number }
// Returns: { reply, actions: [{type,description,details}], queued_ids }
router.post('/qc/console', async (req, res) => {
  try {
    const { message, history = [], conversation_id } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });

    // ── Full dashboard context ──────────────────────────────────────────────
    let promptSnippet = '';
    try {
      const analyzerModule = require('./analyzer');
      const cur = await analyzerModule.getCurrentPrompt();
      promptSnippet = cur ? cur.slice(0, 4000) : '';
    } catch {}

    // Overall conversation outcomes (last 30 days)
    let overallCtx = '';
    try {
      const oQ = await db.query(`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE terminal_outcome = 'appointment_booked')::int AS booked,
               COUNT(*) FILTER (WHERE terminal_outcome = 'human_handoff')::int AS handoffs,
               COUNT(*) FILTER (WHERE terminal_outcome = 'dnc')::int AS dnc,
               COUNT(*) FILTER (WHERE terminal_outcome IS NULL AND is_active)::int AS active,
               COUNT(*) FILTER (WHERE terminal_outcome = 'disqualified')::int AS disqualified
          FROM conversations
         WHERE created_at >= NOW() - '30 days'::interval AND is_sandbox = FALSE`);
      const o = oQ.rows[0] || {};
      const bookRate = o.total > 0 ? ((o.booked / o.total) * 100).toFixed(1) : '0';
      overallCtx = `Total convos: ${o.total} | Booked: ${o.booked} (${bookRate}%) | Handoffs: ${o.handoffs} | DNC: ${o.dnc} | Active: ${o.active}`;
    } catch {}

    // Message reply rates:
    //  Part 1 — overall stats (works even for personalized/unique messages)
    //  Part 2 — repeated template stats (word tracks / Botpress templates sent 3+ times)
    const wtCtx = [];
    let wtErr = null;
    try {
      // Overall: how many outbound messages got any inbound reply after them
      const overallMsgQ = await db.query(`
        SELECT COUNT(*)::int AS total_out,
               COUNT(*) FILTER (
                 WHERE EXISTS (
                   SELECT 1 FROM ghl_messages ir
                    WHERE ir.ghl_conversation_id = m.ghl_conversation_id
                      AND ir.location_id = m.location_id
                      AND ir.direction = 'inbound'
                      AND ir.created_at > m.created_at
                 )
               )::int AS got_reply
          FROM ghl_messages m
         WHERE m.direction = 'outbound'
           AND LENGTH(COALESCE(m.content, '')) > 5`);
      const om = overallMsgQ.rows[0] || {};
      const totalOut = om.total_out || 0;
      if (totalOut === 0) {
        wtCtx.push('(no outbound messages in ghl_messages table yet)');
      } else {
        const overallRate = ((om.got_reply / totalOut) * 100).toFixed(1);
        wtCtx.push(`Overall: ${totalOut} outbound messages, ${om.got_reply} got a reply (${overallRate}% reply rate)`);

        // Per-conversation reply rate: what % of conversations had at least one inbound after an outbound
        const convRateQ = await db.query(`
          SELECT COUNT(DISTINCT m.ghl_conversation_id)::int AS convos_with_out,
                 COUNT(DISTINCT m.ghl_conversation_id) FILTER (
                   WHERE EXISTS (
                     SELECT 1 FROM ghl_messages ir
                      WHERE ir.ghl_conversation_id = m.ghl_conversation_id
                        AND ir.location_id = m.location_id
                        AND ir.direction = 'inbound'
                   )
                 )::int AS convos_with_reply
            FROM ghl_messages m
           WHERE m.direction = 'outbound'`);
        const cr = convRateQ.rows[0] || {};
        if (cr.convos_with_out > 0) {
          const cRate = ((cr.convos_with_reply / cr.convos_with_out) * 100).toFixed(1);
          wtCtx.push(`Conversation engagement: ${cr.convos_with_reply}/${cr.convos_with_out} conversations had at least one reply (${cRate}%)`);
        }

        // Repeated templates (word tracks / Botpress): messages sent 3+ times with same text
        const tmplQ = await db.query(`
          SELECT LEFT(m.content, 160) AS snippet,
                 COUNT(*)::int AS sends,
                 COUNT(*) FILTER (
                   WHERE EXISTS (
                     SELECT 1 FROM ghl_messages ir
                      WHERE ir.ghl_conversation_id = m.ghl_conversation_id
                        AND ir.location_id = m.location_id
                        AND ir.direction = 'inbound'
                        AND ir.created_at > m.created_at
                   )
                 )::int AS replies
            FROM ghl_messages m
           WHERE m.direction = 'outbound'
             AND LENGTH(COALESCE(m.content, '')) > 10
           GROUP BY LEFT(m.content, 160)
          HAVING COUNT(*) >= 3
           ORDER BY sends DESC
           LIMIT 30`);
        if (tmplQ.rows.length) {
          wtCtx.push('\nRepeated message templates (word tracks / drip):');
          for (const r of tmplQ.rows) {
            const rate = r.sends > 0 ? ((r.replies / r.sends) * 100).toFixed(1) : '0';
            wtCtx.push(`  ${rate}% reply (${r.sends} sends): "${r.snippet}"`);
          }
        }
      }
    } catch (e) {
      wtErr = e.message;
      logger.log('qc', 'error', null, 'console msg-rate query failed', { error: e.message });
    }

    // QC review history (last 30 days)
    const qcCtx = [];
    try {
      const qcQ = await db.query(`
        SELECT outcome, notes, modified_response, created_at
          FROM qc_reviews
         WHERE created_at >= NOW() - '30 days'::interval
         ORDER BY created_at DESC LIMIT 20`);
      for (const r of qcQ.rows) {
        const note = [r.notes, r.modified_response].filter(Boolean).join(' | ').slice(0, 150);
        if (note) qcCtx.push(`[${r.outcome}] ${note}`);
      }
    } catch {}

    // Pending changes queue
    let pendingCtx = '';
    try {
      const pQ = await db.query(`SELECT COUNT(*)::int AS n FROM pending_prompt_changes WHERE status = 'pending'`);
      const n = pQ.rows[0]?.n || 0;
      if (n > 0) {
        const listQ = await db.query(`SELECT change_type, description FROM pending_prompt_changes WHERE status = 'pending' ORDER BY created_at ASC LIMIT 10`);
        pendingCtx = `\n\nPENDING QUEUED CHANGES (${n} total):\n` + listQ.rows.map(r => `[${r.change_type}] ${r.description.slice(0, 120)}`).join('\n');
      }
    } catch {}

    // Sub-account breakdown
    let subCtx = '';
    try {
      const sQ = await db.query(`
        SELECT COALESCE(s.name, c.location_id) AS name,
               COUNT(*)::int AS convos,
               COUNT(*) FILTER (WHERE c.terminal_outcome = 'appointment_booked')::int AS booked
          FROM conversations c
          LEFT JOIN subaccounts s ON s.ghl_location_id = c.location_id
         WHERE c.created_at >= NOW() - '30 days'::interval AND c.is_sandbox = FALSE
         GROUP BY c.location_id, s.name ORDER BY convos DESC LIMIT 10`);
      if (sQ.rows.length) {
        subCtx = '\n\nSUB-ACCOUNT BREAKDOWN (last 30 days):\n' + sQ.rows.map(r => `${r.name}: ${r.convos} convos, ${r.booked} booked`).join('\n');
      }
    } catch {}

    // If reviewing a specific conversation, load its thread
    let convCtx = '';
    if (conversation_id) {
      try {
        const convR = await db.query(`SELECT first_name, last_name, product_type, terminal_outcome, messages FROM conversations WHERE id = $1`, [conversation_id]);
        if (convR.rows[0]) {
          const cv = convR.rows[0];
          const msgs = (cv.messages || []).map((m) => `[${m.role === 'user' ? 'Lead' : 'Bot'}]: ${String(m.content || '').slice(0, 300)}`).join('\n');
          convCtx = `\n\nCONVERSATION BEING REVIEWED:\nContact: ${cv.first_name || ''} ${cv.last_name || ''} | Product: ${cv.product_type || ''} | Outcome: ${cv.terminal_outcome || 'in-progress'}\nThread:\n${msgs || '(no messages)'}`;
        }
      } catch {}
    }

    // Recent conversations (last 7 days) — lets Claude reference specific chats by ID
    let recentConvsCtx = '';
    try {
      const rcQ = await db.query(`
        SELECT c.id AS local_id,
               gc.ghl_conversation_id,
               gc.location_id,
               gc.contact_name,
               gc.terminal_outcome,
               gc.last_message_at,
               gc.source
          FROM ghl_conversations gc
          LEFT JOIN conversations c ON c.contact_id = gc.contact_id AND c.location_id = gc.location_id
         WHERE gc.last_message_at >= NOW() - '7 days'::interval
         ORDER BY gc.last_message_at DESC
         LIMIT 40`);
      if (rcQ.rows.length) {
        recentConvsCtx = '\n\nRECENT CONVERSATIONS (last 7 days — use these IDs in open_conversation actions):\n' +
          rcQ.rows.map(r => {
            const dt = r.last_message_at
              ? new Date(r.last_message_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
              : '?';
            const outcome = r.terminal_outcome || 'in-progress';
            const localId = (r.local_id !== null && r.local_id !== undefined) ? r.local_id : 'null';
            return `[${dt}] ${r.contact_name || '(no name)'} | outcome:${outcome} | local_id:${localId} | ghl_id:${r.ghl_conversation_id} | loc:${r.location_id}`;
          }).join('\n');
      }
    } catch {}

    const systemPrompt = `You are the bot management assistant for PH Insurance's SMS qualification bot. You have FULL ABILITY to make changes to the live bot AND to look up specific conversations.

HOW CHANGES WORK:
- When you include a "prompt_change" action, it gets saved to a queue immediately.
- The user sees the queued changes and clicks "Apply All Changes to Bot" to deploy them live.
- You can queue multiple changes in one response.
- Be specific in "details" — write the exact new text or instruction to add/replace/remove.

HOW CONVERSATION LOOKUPS WORK:
- The RECENT CONVERSATIONS section below lists every conversation from the last 7 days with its IDs.
- When the user asks about a specific person or date range, find the matching rows and include "open_conversation" actions.
- The UI will render a clickable button for each open_conversation action so the user can jump straight to that chat.

EXISTING UI FEATURES (tell the user about these instead of saying "contact your dev team"):
- All Conversations tab is already sorted newest-first by default.
- There is a date-from filter input on the All Conversations tab — the user can pick a date to show only conversations on or after that date.
- The user can search by name or phone in the search box on the All Conversations tab.

CURRENT SYSTEM PROMPT (first 4000 chars):
${promptSnippet || '(unavailable)'}

OVERALL PERFORMANCE (last 30 days):
${overallCtx || '(no data)'}${subCtx}

OUTBOUND MESSAGE REPLY RATES:
${wtCtx.length ? wtCtx.join('\n') : wtErr ? `(query error: ${wtErr})` : '(no outbound message data yet)'}

QC REVIEW HISTORY (last 30 days):
${qcCtx.length ? qcCtx.join('\n') : '(none)'}${pendingCtx}${convCtx}${recentConvsCtx}

---
ALWAYS respond with JSON in this exact format (no exceptions, no markdown fences):
{
  "reply": "your conversational response here",
  "actions": [
    {
      "type": "prompt_change",
      "description": "Short label for the pending changes list",
      "details": "Exact text or instruction — be specific enough that a developer can apply it precisely"
    },
    {
      "type": "open_conversation",
      "local_conv_id": 1234,
      "ghl_conv_id": "abc123xyz",
      "location_id": "K9xKBb...",
      "contact_name": "John Smith",
      "description": "John Smith — dnc (Apr 25)"
    }
  ]
}

Action type rules:
- "prompt_change": queue a bot prompt edit. Required fields: description, details.
- "open_conversation": point the user to a specific conversation in the UI. Required fields: ghl_conv_id, location_id. Optional: local_conv_id (use when local_id is not null in RECENT CONVERSATIONS), contact_name, description. Include one per conversation you want to highlight.

If no actions are needed, set "actions" to [].
When you queue changes, tell the user what you queued and that they can click Apply to deploy.
When pointing to conversations, tell the user what you found and that they can click the buttons below to open them.
Always return valid JSON.`;

    const messages = [
      ...history.slice(-10).map((h) => ({ role: h.role, content: h.content })),
      { role: 'user', content: message }
    ];

    const resp = await callAnthropic(
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        system: systemPrompt,
        messages
      },
      { category: 'qc_console', location_id: null, meta: { history_len: history.length } }
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

    // Queue any prompt_change actions to pending_prompt_changes
    const queuedIds = [];
    for (const a of actions) {
      if (a.type === 'prompt_change' && a.description) {
        try {
          const ins = await db.query(
            `INSERT INTO pending_prompt_changes (source, change_type, description, proposed_by)
             VALUES ('console', 'improvement', $1, 'bot_console')
             RETURNING id`,
            [`${a.description}${a.details ? ': ' + a.details : ''}`]
          );
          queuedIds.push(ins.rows[0].id);
        } catch {}
      }
    }

    res.json({ ok: true, reply, actions, queued_ids: queuedIds });
  } catch (err) {
    logger.log('qc', 'error', null, 'console chat failed', { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /qc/conv-counts — diagnostic: how many conversations in each table
// and what date ranges they cover. Use to spot gaps between GHL pulls and local data.
router.get('/qc/conv-counts', async (req, res) => {
  try {
    const [local, ghlConvs, ghlMsgs, localOnly, ghlOnly] = await Promise.all([
      db.query(`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE is_sandbox = FALSE)::int AS non_sandbox,
               MIN(last_message_at) AS oldest,
               MAX(last_message_at) AS newest,
               COUNT(*) FILTER (WHERE last_message_at >= NOW() - '7 days'::interval AND is_sandbox = FALSE)::int AS last_7d,
               COUNT(*) FILTER (WHERE last_message_at >= NOW() - '1 day'::interval AND is_sandbox = FALSE)::int AS last_24h
          FROM conversations`),
      db.query(`
        SELECT COUNT(*)::int AS total,
               MIN(last_message_at) AS oldest,
               MAX(last_message_at) AS newest,
               COUNT(*) FILTER (WHERE last_message_at >= NOW() - '7 days'::interval)::int AS last_7d,
               COUNT(*) FILTER (WHERE last_message_at >= NOW() - '1 day'::interval)::int AS last_24h
          FROM ghl_conversations`),
      db.query(`SELECT COUNT(*)::int AS total FROM ghl_messages`),
      db.query(`
        SELECT COUNT(*)::int AS total
          FROM conversations c
         WHERE c.is_sandbox = FALSE
           AND NOT EXISTS (SELECT 1 FROM ghl_conversations gc WHERE gc.contact_id = c.contact_id AND gc.location_id = c.location_id)`),
      db.query(`
        SELECT COUNT(*)::int AS total
          FROM ghl_conversations gc
         WHERE NOT EXISTS (SELECT 1 FROM conversations c WHERE c.contact_id = gc.contact_id AND c.location_id = gc.location_id)`)
    ]);
    res.json({
      conversations_table: local.rows[0],
      ghl_conversations_table: ghlConvs.rows[0],
      ghl_messages_total: ghlMsgs.rows[0].total,
      local_only_no_ghl_row: localOnly.rows[0].total,
      ghl_only_no_local_row: ghlOnly.rows[0].total
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /qc/sync-status — returns last sync timestamps for the freshness indicator.
router.get('/qc/sync-status', async (req, res) => {
  try {
    const q = await db.query(
      `SELECT key, value FROM app_settings WHERE section = 'ghl_sync' AND key IN ('last_full_repull_at', 'last_sync_at')`
    );
    const byKey = Object.fromEntries(q.rows.map(r => [r.key, r.value]));
    const fullRaw = byKey['last_full_repull_at'] || null;
    const syncRaw = byKey['last_sync_at'] || null;
    // Use whichever is more recent as the headline "last sync" time.
    const candidates = [fullRaw, syncRaw].filter(Boolean).map(v => new Date(v));
    const latest = candidates.length ? new Date(Math.max(...candidates.map(d => d.getTime()))) : null;
    const hours_ago = latest ? Math.floor((Date.now() - latest.getTime()) / 3600000) : null;
    res.json({
      last_full_repull_at: fullRaw ? new Date(fullRaw).toISOString() : null,
      last_sync_at: syncRaw ? new Date(syncRaw).toISOString() : null,
      last_any_sync_at: latest ? latest.toISOString() : null,
      hours_ago
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /qc/refresh-conversation — re-pulls a single conversation's messages
// from GHL and updates ghl_messages in place. Used by the per-contact refresh
// button in the QC portal so reviewers can get fresh messages without waiting
// for the next daily repull.
router.post('/qc/refresh-conversation', async (req, res) => {
  try {
    const { ghl_conversation_id, location_id } = req.body || {};
    if (!ghl_conversation_id || !location_id) {
      return res.status(400).json({ error: 'ghl_conversation_id and location_id required' });
    }
    const token = await findGhlTokenForLocationLocal(location_id);
    if (!token) return res.status(400).json({ error: 'No GHL token found for this location' });

    const ghlConvSvc = require('../services/ghlConversations');
    const result = await ghlConvSvc.pullMessagesWithRetry(token, ghl_conversation_id);
    if (!result.ok) {
      return res.status(502).json({ error: 'GHL fetch failed: ' + result.error });
    }
    const filtered = result.messages.filter(ghlConvSvc.isSmsMessage);
    await ghlConvSvc.replaceMessagesForConversation(ghl_conversation_id, location_id, filtered);

    // Keep ghl_conversations aggregates current so message_count and source stay accurate.
    const convIdQ = await db.query(
      `SELECT contact_id FROM ghl_conversations WHERE ghl_conversation_id = $1 AND location_id = $2`,
      [ghl_conversation_id, location_id]
    );
    const convRow = { id: ghl_conversation_id, contactId: convIdQ.rows[0]?.contact_id, location_id };
    const classification = ghlConvSvc.classifyConversation(convRow, filtered, new Set());
    const lastMs = filtered.reduce((acc, m) => {
      const t = new Date(m.dateAdded || m.created || 0).getTime();
      return t > acc ? t : acc;
    }, 0);
    await ghlConvSvc.updateConversationAggregates(ghl_conversation_id, location_id, {
      source: classification.source,
      messageCount: filtered.length,
      lastMessageAt: lastMs ? new Date(lastMs).toISOString() : null
    });

    logger.log('qc', 'info', null, 'refresh-conversation complete', {
      ghl_conversation_id, location_id, messages_pulled: filtered.length
    });
    res.json({ ok: true, messages_pulled: filtered.length });
  } catch (err) {
    logger.log('qc', 'error', null, 'refresh-conversation failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Commit the current live prompt (DB override) back to standard.js on GitHub.
// Railway detects the push and auto-deploys, keeping the file canonical.
// Requires GITHUB_TOKEN env var on Railway. Called by the Changes tab after
// apply-pending succeeds.
// ============================================================
router.post('/qc/commit-prompt-to-github', async (req, res) => {
  try {
    const analyzerModule = require('./analyzer');
    const currentPrompt = await analyzerModule.getCurrentPrompt();
    if (!currentPrompt) {
      return res.status(400).json({ ok: false, error: 'No live prompt found — run apply-pending first' });
    }
    const result = await commitPromptToGitHub(currentPrompt);
    if (result.ok) {
      logger.log('qc', 'info', null, 'commit-prompt-to-github: success', { by: req.session?.username });
    } else {
      logger.log('qc', 'warn', null, 'commit-prompt-to-github: failed', { error: result.error });
    }
    res.json(result);
  } catch (err) {
    logger.log('qc', 'error', null, 'commit-prompt-to-github error', { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================================
// Sync file-based standard.js → DB override
// Fixes the "I edited standard.js but production still uses old prompt"
// problem. Reads the current standard.js content and saves it as the
// DB override so the bot picks it up within 30 seconds.
// ============================================================
router.post('/qc/sync-standard-to-db', async (req, res) => {
  try {
    const standardText = require('../prompts/standard');
    const { clearOverrideCache } = require('../prompts');
    await db.query(
      `INSERT INTO app_settings (section, key, value)
       VALUES ('analyzer_prompt', 'current', $1)
       ON CONFLICT (section, key) DO UPDATE SET value = EXCLUDED.value`,
      [standardText]
    );
    clearOverrideCache();
    logger.log('qc', 'info', null, 'sync-standard-to-db: file synced to DB override', { by: req.session?.username });
    res.json({ ok: true, message: 'standard.js synced to live bot. Changes active within 30 seconds.' });
  } catch (err) {
    logger.log('qc', 'error', null, 'sync-standard-to-db failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Ask Claude console — explain bot behavior, suggest prompt fixes,
// preview rule changes. Called from the Sandbox "Ask Claude" panel.
// ============================================================
router.post('/qc/ask-claude', async (req, res) => {
  try {
    const { question, conversation, mode = 'explain' } = req.body;
    if (!question) return res.status(400).json({ error: 'question required' });

    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic();
    const analyzerModule = require('./analyzer');
    const standardPrompt = require('../prompts/standard');
    const currentPrompt = await analyzerModule.getCurrentPrompt() || standardPrompt;

    const modeInstructions = {
      explain: 'Explain exactly WHY the bot responded the way it did, citing the specific rule or section of the system prompt. Be specific and direct — no filler.',
      suggest: 'Suggest a specific new rule or modification to the system prompt that fixes this behavior. Write the actual prompt text to add or change.',
      preview: 'Show how the bot SHOULD respond with an improved rule. Draft both the rule change and the ideal bot response for the given conversation.'
    };

    const systemPrompt = `You are an expert at debugging and improving AI SMS qualification bot prompts. You help operators understand why the bot behaved a certain way and how to fix it.

THE BOT'S CURRENT SYSTEM PROMPT:
---
${currentPrompt}
---

Task: ${modeInstructions[mode] || modeInstructions.explain}

Respond ONLY with a JSON object — no markdown, no backticks:
{
  "explanation": "clear plain-English explanation",
  "suggested_rule": "exact prompt text to add or modify, or null",
  "suggested_rule_location": "where in the prompt this belongs, e.g. 'after BANNED WORDS section', or null",
  "confidence": "high|medium|low"
}`;

    const userContent = conversation
      ? `CONVERSATION:\n${conversation}\n\nQUESTION: ${question}`
      : question;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }]
    });

    const text = response.content[0]?.text || '';
    let parsed = { explanation: text, suggested_rule: null };
    try {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
    } catch {}

    logger.log('qc', 'info', null, 'ask-claude console query', { mode, has_conversation: !!conversation });
    res.json({ ok: true, ...parsed });
  } catch (err) {
    logger.log('qc', 'error', null, 'ask-claude error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Queue a suggested rule change from the Ask Claude console.
router.post('/qc/queue-prompt-change', async (req, res) => {
  try {
    const { rule_text, source = 'ask_claude', note } = req.body;
    if (!rule_text) return res.status(400).json({ error: 'rule_text required' });
    const description = note ? `${rule_text}\n\n[Context: ${note}]` : rule_text;
    await db.query(
      `INSERT INTO pending_prompt_changes (source, change_type, description, proposed_by)
       VALUES ($1, 'prompt_fix', $2, 'ask_claude_console')`,
      [source, description]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
