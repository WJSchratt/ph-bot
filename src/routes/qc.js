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
    const { page = 1, limit = 20 } = req.query;
    const lim = Math.min(parseInt(limit, 10) || 20, 100);
    const off = (Math.max(parseInt(page, 10) || 1, 1) - 1) * lim;

    const result = await db.query(
      `SELECT c.id, c.contact_id, c.location_id, c.first_name, c.last_name, c.product_type,
              c.contact_stage, c.terminal_outcome, c.ai_self_score, c.last_message_at,
              jsonb_array_length(c.messages) AS message_count,
              COALESCE(s.name, c.location_id) AS subaccount_name
       FROM conversations c
       LEFT JOIN subaccounts s ON s.ghl_location_id = c.location_id
       WHERE c.is_sandbox = FALSE AND c.qc_reviewed = FALSE AND c.terminal_outcome IS NOT NULL
       ORDER BY c.last_message_at DESC
       LIMIT $1 OFFSET $2`,
      [lim, off]
    );

    const countRes = await db.query(
      `SELECT COUNT(*)::int AS total FROM conversations
       WHERE is_sandbox = FALSE AND qc_reviewed = FALSE AND terminal_outcome IS NOT NULL`
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
    const totalReviewed = stats.total_reviewed || 1;
    res.json({
      ...stats,
      pending: pendingRes.rows[0].pending,
      accuracy: ((stats.approved + stats.modified * 0.6) / totalReviewed * 100).toFixed(1)
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

module.exports = router;
