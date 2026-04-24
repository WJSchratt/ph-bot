const express = require('express');
const db = require('../db');
const store = require('../services/conversationStore');
const claude = require('../services/claude');
const logger = require('../services/logger');
const { callAnthropic } = require('../services/anthropic');
const { parseTags, determineContactStage, determineProductType, determineIsCa } = require('../utils/parser');
const router = express.Router();

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
    const { page = 1, limit = 20, search, all } = req.query;
    const lim = Math.min(parseInt(limit, 10) || 20, 100);
    const off = (Math.max(parseInt(page, 10) || 1, 1) - 1) * lim;

    // `all=true` drops the qc_reviewed + terminal_outcome filters so reviewers
    // can browse every conversation (including in-progress + already-reviewed).
    // `search` matches first/last name OR phone, case-insensitive substring.
    const includeAll = String(all || '') === 'true' || all === '1';
    const clauses = ['c.is_sandbox = FALSE'];
    const params = [];
    let p = 1;
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
    `SELECT id, direction, content, message_type, created_at, cluster_id, ghl_message_id
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
        model: 'claude-sonnet-4-20250514',
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
      model: 'claude-sonnet-4-20250514',
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
      `SELECT id, source, change_type, description, instruction, proposed_by, created_at
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
        model: 'claude-sonnet-4-20250514',
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
// Body: { message, history: [{role,content}] }
// Returns: { reply, actions: [{type,description,details}], queued_ids }
router.post('/qc/console', async (req, res) => {
  try {
    const { message, history = [] } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });

    // Gather context: current prompt snippet + top underperforming word tracks + recent QC failures
    let promptSnippet = '';
    try {
      const analyzerModule = require('./analyzer');
      const currentPrompt = await analyzerModule.getCurrentPrompt();
      promptSnippet = currentPrompt ? currentPrompt.slice(0, 3000) : '';
    } catch {}

    const wtCtx = [];
    try {
      const wtQ = await db.query(`
        SELECT wf.label, wf.example_opener,
               COUNT(DISTINCT m.ghl_conversation_id)::int AS sends,
               COUNT(DISTINCT m.ghl_conversation_id) FILTER (
                 WHERE EXISTS (SELECT 1 FROM ghl_messages ir
                   WHERE ir.ghl_conversation_id = m.ghl_conversation_id
                     AND ir.direction = 'inbound' AND ir.created_at > m.created_at)
               )::int AS replies
          FROM workflow_clusters wf
          JOIN ghl_messages m ON m.workflow_cluster_id = wf.id
         WHERE m.direction = 'outbound'
           AND m.created_at >= NOW() - '30 days'::interval
         GROUP BY wf.id, wf.label, wf.example_opener
        HAVING COUNT(DISTINCT m.ghl_conversation_id) >= 10
         ORDER BY replies::float / NULLIF(COUNT(DISTINCT m.ghl_conversation_id), 0) ASC
         LIMIT 5`
      );
      for (const r of wtQ.rows) {
        const rate = r.sends > 0 ? ((r.replies / r.sends) * 100).toFixed(1) : '0';
        wtCtx.push(`"${r.label}": ${rate}% reply rate (${r.sends} sends). Example: "${(r.example_opener || '').slice(0, 100)}"`);
      }
    } catch {}

    const qcCtx = [];
    try {
      const qcQ = await db.query(`
        SELECT qr.outcome, qr.notes, qr.modified_response
          FROM qc_reviews qr
         WHERE qr.outcome IN ('failed','modified') AND qr.created_at >= NOW() - '14 days'::interval
         ORDER BY qr.created_at DESC LIMIT 5`
      );
      for (const r of qcQ.rows) {
        const note = [r.notes, r.modified_response].filter(Boolean).join(' | ').slice(0, 120);
        if (note) qcCtx.push(`[${r.outcome}] ${note}`);
      }
    } catch {}

    const systemPrompt = `You are the bot management assistant for PH Insurance's SMS qualification bot. You help Walt and the team understand bot performance, diagnose issues, and improve word tracks and scripts.

CURRENT SYSTEM PROMPT (first 3000 chars):
${promptSnippet || '(unavailable)'}

TOP UNDERPERFORMING WORD TRACKS (last 30 days):
${wtCtx.length ? wtCtx.join('\n') : '(no data)'}

RECENT QC FAILURES/MODIFICATIONS (last 14 days):
${qcCtx.length ? qcCtx.join('\n') : '(none)'}

---
When the user asks for a change or improvement, respond with JSON in this exact format:
{
  "reply": "your conversational response here",
  "actions": [
    {
      "type": "prompt_change",
      "description": "Short label for this change",
      "details": "Exact text or instruction for what to change in the prompt"
    }
  ]
}

If no changes are needed (just answering a question), set "actions" to [].
Always return valid JSON. Keep "reply" friendly and specific.`;

    const messages = [
      ...history.slice(-10).map((h) => ({ role: h.role, content: h.content })),
      { role: 'user', content: message }
    ];

    const resp = await callAnthropic(
      {
        model: 'claude-sonnet-4-20250514',
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

module.exports = router;
