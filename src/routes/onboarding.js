const express = require('express');
const path = require('path');
const axios = require('axios');
const db = require('../db');
const logger = require('../services/logger');
const ghlAgency = require('../services/ghlAgency');
const elSetup = require('../services/elevenlabsSetup');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Serve the public form
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'onboarding.html'));
});

const DAILY_SUB_CAP = 10;

// Allow Webflow (and any domain) to POST to this endpoint from a browser fetch
router.options('/submit', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }).sendStatus(204);
});

// Process form submission — runs the full setup pipeline
router.post('/submit', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const form = req.body;

  // ── Validate required fields ──────────────────────────────────────────────
  const required = ['business_name', 'agent_first_name', 'agent_phone', 'agent_email', 'bot_name', 'vertical', 'meeting_type'];
  const missing = required.filter((f) => !form[f]?.trim());
  if (missing.length) {
    return res.status(400).send(`Missing required fields: ${missing.join(', ')}`);
  }

  const email = (form.agent_email || '').trim().toLowerCase();

  // ── Email deduplication ───────────────────────────────────────────────────
  try {
    const dup = await db.query(
      `SELECT id FROM subaccounts WHERE LOWER(agent_email) = $1 LIMIT 1`,
      [email]
    );
    if (dup.rows.length) {
      logger.log('onboarding', 'warn', null, 'Duplicate email rejected', { email });
      return res.status(409).send(
        `An account already exists for ${form.agent_email}. If you think this is a mistake, contact your Profit Hexagon rep.`
      );
    }
  } catch (err) {
    logger.log('onboarding', 'error', null, 'Dedup check failed', { error: err.message });
  }

  // ── Daily rate cap ────────────────────────────────────────────────────────
  try {
    const countRes = await db.query(
      `SELECT COUNT(*) FROM onboarding_submissions WHERE created_at > NOW() - INTERVAL '24 hours'`
    );
    if (parseInt(countRes.rows[0].count, 10) >= DAILY_SUB_CAP) {
      logger.log('onboarding', 'warn', null, 'Daily cap hit — submission rejected', { email });
      return res.status(429).send(
        `Maximum onboarding submissions reached for today. Please contact your Profit Hexagon rep to get set up.`
      );
    }
  } catch (err) {
    logger.log('onboarding', 'error', null, 'Rate cap check failed', { error: err.message });
  }

  // ── Insert initial submission record ──────────────────────────────────────
  let submissionId;
  try {
    const ins = await db.query(
      `INSERT INTO onboarding_submissions (status, form_data) VALUES ('processing', $1) RETURNING id`,
      [JSON.stringify(form)]
    );
    submissionId = ins.rows[0].id;
  } catch (err) {
    logger.log('onboarding', 'error', null, 'Failed to insert submission', { error: err.message });
    return res.status(500).send('Server error. Please try again.');
  }

  // Run the pipeline async — respond immediately.
  // JSON requests (fetch from Webflow page) get 200; form POSTs get redirect.
  const isJson = (req.headers['content-type'] || '').includes('application/json');
  if (isJson) {
    res.json({ ok: true });
  } else {
    res.redirect('/onboarding/success');
  }
  runPipeline(submissionId, form).catch((err) => {
    logger.log('onboarding', 'error', null, 'Pipeline crashed', { submissionId, error: err.message });
  });
});

router.get('/success', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Profit Hexagon — Account Setup in Progress</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: #fff; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; }
    .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 16px; max-width: 520px; width: 100%; padding: 48px 40px; text-align: center; }
    .icon { font-size: 48px; margin-bottom: 24px; }
    h1 { font-size: 24px; font-weight: 700; margin-bottom: 12px; color: #fff; }
    p { color: #aaa; line-height: 1.6; margin-bottom: 16px; }
    .highlight { color: #6c63ff; font-weight: 600; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✅</div>
    <h1>You're all set!</h1>
    <p>We received your onboarding info and are setting up your account now.</p>
    <p>You'll hear from <span class="highlight">Walt or Jeremiah within 24 hours</span> to walk you through the final steps and get your first leads uploaded.</p>
    <p style="margin-top:24px; font-size:13px; color:#555;">Profit Hexagon &mdash; AI-powered growth systems</p>
  </div>
</body>
</html>`);
});

// ── Pipeline ──────────────────────────────────────────────────────────────────

async function step(submissionId, label, fn) {
  try {
    const result = await fn();
    await db.query(
      `UPDATE onboarding_submissions
       SET completed_steps = completed_steps || $1::jsonb, updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify([label]), submissionId]
    );
    logger.log('onboarding', 'info', null, `Step complete: ${label}`, { submissionId });
    return { ok: true, result };
  } catch (err) {
    await db.query(
      `UPDATE onboarding_submissions
       SET error_log = error_log || $1::jsonb, updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify([{ step: label, error: err.message, ts: new Date().toISOString() }]), submissionId]
    );
    logger.log('onboarding', 'error', null, `Step failed: ${label}`, { submissionId, error: err.message });
    return { ok: false, error: err.message };
  }
}

async function runPipeline(submissionId, form) {
  const {
    business_name,
    agent_first_name,
    agent_last_name = '',
    agent_phone,
    agent_email,
    bot_name,
    vertical,
    meeting_type,
    meeting_link = '',
    calendar_link_mp = '',
    calendar_link_fx = '',
    loom_video_mp = '',
    loom_video_fx = '',
    business_card_link = '',
    language = 'en',
    area_codes = '',
    plan = 'unknown',
    marketplace_type = '',
  } = form;

  // Derive offer strings from vertical
  const OFFER_MAP = {
    mp:           { offer: 'Mortgage Protection',       offer_short: 'protecting your mortgage' },
    fx:           { offer: 'Final Expense',             offer_short: 'final expense coverage' },
    both:         { offer: 'Mortgage Protection',       offer_short: 'protecting your family' },
    chiropractic: { offer: 'Chiropractic Care',         offer_short: 'chiropractic services' },
    other:        { offer: business_name,               offer_short: 'our services' },
  };
  const { offer, offer_short } = OFFER_MAP[vertical] || OFFER_MAP.other;

  let locationId = null;
  let locationToken = null;
  let subaccountDbId = null;
  let agentEn = null;
  let agentEs = null;

  // ── Step 1: Create GHL sub-account ────────────────────────────────────────
  const createRes = await step(submissionId, 'create_ghl_location', async () => {
    if (!process.env.GHL_AGENCY_API_KEY || !process.env.GHL_COMPANY_ID) {
      throw new Error('GHL_AGENCY_API_KEY or GHL_COMPANY_ID not set — skipping GHL creation');
    }
    const loc = await ghlAgency.createLocation({
      businessName: business_name,
      agentPhone: agent_phone,
      agentEmail: agent_email,
    });
    locationId = loc.id;
    return loc;
  });

  if (createRes.ok) {
    await db.query(
      `UPDATE onboarding_submissions SET ghl_location_id = $1, updated_at = NOW() WHERE id = $2`,
      [locationId, submissionId]
    );
  }

  // ── Step 2: Get location-scoped token ─────────────────────────────────────
  if (locationId) {
    const tokenRes = await step(submissionId, 'get_location_token', async () => {
      locationToken = await ghlAgency.getLocationToken(locationId);
      return { ok: !!locationToken };
    });
    if (!tokenRes.ok) locationToken = null;
  }

  // ── Step 3: Set all GHL custom values ─────────────────────────────────────
  if (locationId && locationToken) {
    await step(submissionId, 'set_custom_values', async () => {
      const values = {
        bot_name,
        agent_name:            agent_first_name,
        agent_phone,
        agent_email,
        agent_business_card_link: business_card_link,
        meeting_type,
        meeting_link,
        calendar_link_mp,
        calendar_link_fx,
        loom_video_mp,
        loom_video_fx,
        offer,
        offer_short,
        language,
        marketplace_type,
        bot_use_case:          vertical,
        // ElevenLabs API key — same for all clients for now
        elevenlabs_api_key:    process.env.ELEVENLABS_API_KEY || '',
        // ghl_token: must be set manually — requires creating a PIT in GHL UI
        // post_call_router_url: must be set manually — requires GHL workflow to exist first
      };
      return ghlAgency.setCustomValues(locationId, values, locationToken);
    });
  }

  // ── Step 4: Store sub-account in our DB ───────────────────────────────────
  if (locationId) {
    const saRes = await step(submissionId, 'store_subaccount', async () => {
      const r = await db.query(
        `INSERT INTO subaccounts
           (name, ghl_location_id, status, agent_name, agent_email, agent_phone,
            bot_name, business_name, vertical, plan, config)
         VALUES ($1,$2,'active',$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (ghl_location_id) DO UPDATE
           SET name=$1, agent_name=$3, agent_email=$4, agent_phone=$5,
               bot_name=$6, business_name=$7, vertical=$8, plan=$9,
               config=$10, updated_at=NOW()
         RETURNING id`,
        [
          business_name,
          locationId,
          agent_first_name,
          agent_email,
          agent_phone,
          bot_name,
          business_name,
          vertical,
          plan,
          JSON.stringify({ meeting_type, calendar_link_mp, calendar_link_fx, area_codes, language }),
        ]
      );
      subaccountDbId = r.rows[0]?.id;
      return { id: subaccountDbId };
    });
    if (saRes.ok && subaccountDbId) {
      await db.query(
        `UPDATE onboarding_submissions SET subaccount_id = $1, updated_at = NOW() WHERE id = $2`,
        [subaccountDbId, submissionId]
      );
    }
  }

  // ── Step 5: Create ElevenLabs agents ──────────────────────────────────────
  const elRes = await step(submissionId, 'create_elevenlabs_agents', async () => {
    const { agents, errors } = await elSetup.createAgentsForClient({
      businessName: business_name,
      vertical,
      languages: language,
    });
    agentEn = agents.en?.agent_id || null;
    agentEs = agents.es?.agent_id || null;
    if (errors.length && !agentEn) throw new Error(errors.map((e) => e.error).join('; '));
    return { agentEn, agentEs, elErrors: errors };
  });

  if (elRes.ok) {
    await db.query(
      `UPDATE onboarding_submissions SET elevenlabs_agent_en=$1, elevenlabs_agent_es=$2, updated_at=NOW() WHERE id=$3`,
      [agentEn, agentEs, submissionId]
    );
    if (subaccountDbId) {
      await db.query(
        `UPDATE subaccounts SET elevenlabs_agent_id_en=$1, elevenlabs_agent_id_es=$2, updated_at=NOW() WHERE id=$3`,
        [agentEn, agentEs, subaccountDbId]
      );
    }
    // Write agent IDs back into GHL custom values if we have a token
    if (locationId && locationToken) {
      await step(submissionId, 'set_elevenlabs_custom_values', async () => {
        return ghlAgency.setCustomValues(locationId, {
          elevenlabs_agent_id_en: agentEn || '',
          elevenlabs_agent_id_es: agentEs || '',
        }, locationToken);
      });
    }
  }

  // ── Step 6: Mark complete and notify team ─────────────────────────────────
  const finalStatus = elRes.ok && createRes.ok ? 'complete' : 'partial';
  await db.query(
    `UPDATE onboarding_submissions
     SET status=$1, updated_at=NOW()
     WHERE id=$2`,
    [finalStatus, submissionId]
  );
  if (subaccountDbId) {
    await db.query(
      `UPDATE subaccounts SET onboarding_completed_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [subaccountDbId]
    );
  }

  // Notify Walt/Jeremiah via the PH Post-Call Router webhook
  const notifyUrl = process.env.GHL_POST_CALL_ROUTER_URL;
  if (notifyUrl) {
    const manualSteps = buildManualChecklist({ locationId, agentEn, agentEs, form });
    axios.post(notifyUrl, {
      type: 'new_client_onboarded',
      event_timestamp: Math.floor(Date.now() / 1000),
      data: {
        agent_name: 'Profit Hexagon Onboarding Bot',
        status: finalStatus,
        analysis: {
          transcript_summary: `New client onboarded: ${business_name} (${agent_first_name} ${agent_last_name}). Vertical: ${vertical}. Plan: ${plan}. GHL location: ${locationId || 'NEEDS MANUAL CREATION'}. EL agent EN: ${agentEn || 'failed'}. EL agent ES: ${agentEs || 'N/A'}.`,
          call_summary_title: `New Client: ${business_name}`,
          data_collection_results: {
            business_name:  { value: business_name },
            agent_name:     { value: `${agent_first_name} ${agent_last_name}` },
            agent_phone:    { value: agent_phone },
            agent_email:    { value: agent_email },
            vertical:       { value: vertical },
            plan:           { value: plan },
            ghl_location_id:{ value: locationId || 'NEEDS MANUAL CREATION' },
            el_agent_en:    { value: agentEn || 'failed' },
            el_agent_es:    { value: agentEs || 'N/A' },
            manual_steps:   { value: manualSteps.join(' | ') },
          },
        },
      },
    }).catch(() => {});
  }

  logger.log('onboarding', 'info', null, `Pipeline complete (${finalStatus})`, {
    submissionId, locationId, agentEn, agentEs,
  });
}

function buildManualChecklist({ locationId, agentEn, agentEs, form }) {
  const steps = [];
  if (!locationId) steps.push('CREATE GHL sub-account manually (agency API key missing)');
  steps.push(`BUY phone number — area code prefs: ${form.area_codes || 'not specified'}`);
  steps.push('SUBMIT A2P Brand + Campaign in Signal House');
  steps.push('REGISTER phone with FreeCaller, Hiya, Orion');
  steps.push('CREATE PIT token in GHL sub-account → set as ghl_token custom value');
  steps.push('SET post_call_router_url custom value once GHL workflow is live');
  steps.push(`CONFIGURE EL webhook for agent ${agentEn} → point to sub-account Post-Call Router`);
  if (agentEs) steps.push(`CONFIGURE EL webhook for Spanish agent ${agentEs}`);
  steps.push('APPLY Profit Hexagon snapshot to sub-account (workflows, custom fields, pipelines)');
  steps.push('LOAD memes + family photo into media library');
  steps.push('BULK UPDATE assigned_agent on all contacts → ' + form.agent_first_name);
  steps.push('TEST outbound SMS via workflow before uploading leads');
  steps.push('SCHEDULE onboarding call');
  return steps;
}

// ── Test endpoints (requires dashboard auth) ──────────────────────────────

router.post('/test', requireAuth, async (req, res) => {
  const defaults = {
    business_name: 'Test Business LLC',
    agent_first_name: 'Test',
    agent_last_name: 'Agent',
    agent_phone: '+15550001234',
    agent_email: `test-${Date.now()}@test.invalid`,
    bot_name: 'TestBot',
    vertical: 'mp',
    meeting_type: 'zoom',
    meeting_link: '',
    plan: 'test',
    language: 'en',
    area_codes: '',
    marketplace_type: '',
  };
  const form = { ...defaults, ...req.body, _test: true };

  let submissionId;
  try {
    const ins = await db.query(
      `INSERT INTO onboarding_submissions (status, form_data) VALUES ('processing', $1) RETURNING id`,
      [JSON.stringify(form)]
    );
    submissionId = ins.rows[0].id;
  } catch (err) {
    logger.log('onboarding', 'error', null, 'Test: failed to insert submission', { error: err.message });
    return res.status(500).json({ ok: false, error: err.message });
  }

  res.json({ ok: true, submissionId });

  runPipeline(submissionId, form).catch((err) => {
    logger.log('onboarding', 'error', null, 'Test pipeline crashed', { submissionId, error: err.message });
  });
});

router.get('/test/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ ok: false, error: 'invalid id' });
  try {
    const r = await db.query(
      `SELECT id, status, ghl_location_id, elevenlabs_agent_en, elevenlabs_agent_es,
              completed_steps, error_log, form_data, created_at, updated_at
       FROM onboarding_submissions WHERE id = $1`,
      [id]
    );
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, submission: r.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
