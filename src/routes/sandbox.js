const express = require('express');
const store = require('../services/conversationStore');
const claude = require('../services/claude');
const { callAnthropic } = require('../services/anthropic');
const { parseTags, determineContactStage, determineProductType, determineIsCa } = require('../utils/parser');

const router = express.Router();

const SANDBOX_CONTACT_ID = 'sandbox_user';
const SANDBOX_LOCATION_ID = 'sandbox_location';

const SIM_MODEL = 'claude-sonnet-4-6';
const SIM_MAX_TURNS = 20;

const PERSONAS = {
  easy_close: {
    name: 'Easy Close',
    description: 'Cooperative, answers everything directly, books fast. Short friendly replies, happy to share age/health/coverage details, says yes to times.'
  },
  price_objector: {
    name: 'Price Objector',
    description: 'Engages but pushes back on cost repeatedly. "that\'s too expensive", "can\'t afford that right now", "what if it goes up later". Not a hard no — eventually open if bot handles it well.'
  },
  spouse_decision: {
    name: 'Spouse Decision',
    description: 'Cannot commit without checking with spouse. Gives info but defers every decision. "I need to talk to my wife", "let me run it by my husband first", "have to check with her".'
  },
  already_covered: {
    name: 'Already Covered',
    description: 'Insists they already have coverage. Skeptical about why bot is texting. "I already have insurance", "why are you bothering me", "who gave you my number". Eventually engages if bot asks about gaps.'
  },
  hostile_dnc: {
    name: 'Hostile / DNC',
    description: 'Aggressive from the start. Wants off the list. "stop texting me", "leave me alone", profanity. Will escalate to STOP/DNC quickly. Test DNC handling.'
  },
  confused_elderly: {
    name: 'Confused / Elderly',
    description: 'Rambling, off-topic, asks about unrelated things. Types slowly, sometimes all caps. "What is this for?", tells stories, asks about their grandkids. Needs patience.'
  },
  reschedule_cancel: {
    name: 'Reschedule / Cancel',
    description: 'Books an appointment quickly, then shortly after wants to change the time — and might cancel entirely. Tests post-booking flow.'
  },
  wrong_number: {
    name: 'Wrong Number',
    description: '"Who is this?" / "Wrong number" / "I never signed up for anything". Confused about why they\'re being texted. Either warms up if bot handles well or asks to be removed.'
  },
  random: { name: 'Random', description: '__RANDOM__' }
};

function pickRandomPersona() {
  const keys = Object.keys(PERSONAS).filter((k) => k !== 'random');
  return keys[Math.floor(Math.random() * keys.length)];
}

function buildSandboxParsed(variables) {
  const v = variables || {};
  const tagList = parseTags(v.tags);
  const offer = v.offer || '';

  return {
    contact_id: SANDBOX_CONTACT_ID,
    location_id: SANDBOX_LOCATION_ID,
    phone: '',
    first_name: v.first_name || 'Walt',
    last_name: '',
    state: v.state || 'FL',
    product_type: determineProductType(offer),
    contact_stage: v.contact_stage || determineContactStage(tagList),
    is_ca: determineIsCa(v.state),
    existing_dob: '',
    existing_age: v.existing_age || '',
    existing_smoker: v.existing_smoker || '',
    existing_health: v.existing_health || '',
    existing_spouse_name: '',
    existing_mortgage_balance: '',
    existing_coverage_subject: '',
    bot_name: v.bot_name || 'Sarah',
    agent_name: v.agent_name || 'Jeremiah',
    agent_phone: '',
    agent_business_card_url: '',
    calendar_link_fx: '',
    calendar_link_mp: '',
    loom_video_fx: '',
    loom_video_mp: '',
    meeting_type: 'Phone',
    ghl_token: '',
    ghl_message_history: '',
    offer: offer,
    offer_short: '',
    language: '',
    marketplace_type: '',
    consent_status: '',
    tags: tagList
  };
}

router.post('/message', async (req, res) => {
  const startedAt = Date.now();
  try {
    const { variables, message } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }

    const parsed = buildSandboxParsed(variables);
    const conv = await store.upsertConversation(parsed, { is_sandbox: true });

    // Reactivate if terminal (sandbox doesn't have cooldown)
    if (!conv.is_active && conv.terminal_outcome) {
      await store.reactivateConversation(conv.id);
      conv.is_active = true;
      conv.terminal_outcome = null;
    }

    // Log inbound
    await store.logMessage({
      conversationId: conv.id,
      contactId: SANDBOX_CONTACT_ID,
      locationId: SANDBOX_LOCATION_ID,
      direction: 'inbound',
      content: message.trim()
    });

    // Build history
    const history = Array.isArray(conv.messages) ? conv.messages : [];

    // Call Claude
    const claudeResult = await claude.generateResponse(conv, history, message.trim());

    // Persist history
    await store.appendMessageHistory(conv.id, 'user', message.trim());
    await store.appendMessageHistory(conv.id, 'assistant', claudeResult.rawAssistantContent);

    // Apply collected data
    await store.applyCollectedData(conv.id, claudeResult.collected_data);

    // Log outbound messages
    for (const msg of claudeResult.messages) {
      await store.logMessage({
        conversationId: conv.id,
        contactId: SANDBOX_CONTACT_ID,
        locationId: SANDBOX_LOCATION_ID,
        direction: 'outbound',
        content: msg,
        messageType: claudeResult.message_type
      });
    }

    // Terminal outcome (just mark it, no GHL/PCR side effects)
    if (claudeResult.terminal_outcome) {
      await store.setTerminalOutcome(conv.id, claudeResult.terminal_outcome);
    }

    return res.json({
      messages: claudeResult.messages,
      collected_data: claudeResult.collected_data,
      terminal_outcome: claudeResult.terminal_outcome,
      message_type: claudeResult.message_type,
      elapsed_ms: Date.now() - startedAt
    });
  } catch (err) {
    console.error('[sandbox/message] error', err);
    return res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

router.post('/reset', async (req, res) => {
  try {
    const deleted = await store.deleteSandboxConversation();
    return res.json({ ok: true, deleted });
  } catch (err) {
    console.error('[sandbox/reset] error', err);
    return res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// --- AI-Simulated sandbox: Claude plays both sides ---

function buildPersonaSystem(personaKey, variables) {
  const p = PERSONAS[personaKey] || PERSONAS.easy_close;
  const v = variables || {};
  const leadBg = [
    v.first_name ? `Your first name is ${v.first_name}.` : '',
    v.state ? `You live in ${v.state}.` : '',
    v.offer ? `You reportedly inquired about ${v.offer} coverage.` : '',
    v.existing_age ? `You are ${v.existing_age} years old.` : '',
    v.existing_health ? `Your health: ${v.existing_health}.` : '',
    v.existing_smoker ? `Smoker status: ${v.existing_smoker}.` : ''
  ].filter(Boolean).join(' ');

  return `You are roleplaying as a LEAD receiving an SMS from an insurance agent's bot. You are NOT the bot.

PERSONA: ${p.name}
${p.description}

BACKGROUND: ${leadBg || '(no background provided — fill in realistic details as needed)'}

CONVERSATION CONTEXT (optional, from the user): ${v.context || '(none)'}

HOW TO TEXT LIKE A REAL HUMAN:
- Short, lowercase, casual. Sometimes typos. Often 2-5 words.
- Questions end without punctuation half the time.
- Don't introduce yourself. Don't say "as a lead" or break character.
- Don't ever reveal you are an AI.
- You're replying to a text, not writing an email.
- Sometimes ignore a question and ask your own. Real people do that.

RESPONSE FORMAT: Output ONLY the text you would send as the next SMS reply. No quotes, no JSON, no explanation. Just the text of the SMS. If you would stop texting entirely (ignored or gave up), reply with exactly: <<<END_SIM>>>`;
}

async function generateLeadReply(personaKey, variables, conversation) {
  const system = buildPersonaSystem(personaKey, variables);
  const messages = [];
  // The bot's messages become "user" from the lead-AI's perspective
  // (lead sees the bot's texts); the lead's own prior replies are "assistant".
  for (const m of conversation) {
    if (m.role === 'bot') messages.push({ role: 'user', content: m.text });
    else if (m.role === 'lead') messages.push({ role: 'assistant', content: m.text });
  }
  // If no prior bot message, prompt lead to open the convo
  if (!messages.length) {
    messages.push({ role: 'user', content: '(no message from the agent yet — start the conversation as the lead would, e.g. a short curious or annoyed reply to a drip text)' });
  }
  const resp = await callAnthropic(
    {
      model: SIM_MODEL,
      max_tokens: 400,
      system,
      messages
    },
    {
      category: 'sandbox_sim',
      location_id: SANDBOX_LOCATION_ID,
      meta: { persona: personaKey }
    }
  );
  const text = (resp.content.find((b) => b.type === 'text')?.text || '').trim();
  return {
    text,
    input_tokens: resp.usage?.input_tokens || 0,
    output_tokens: resp.usage?.output_tokens || 0
  };
}

router.post('/simulate', async (req, res) => {
  try {
    const { variables, persona, max_turns } = req.body || {};
    let personaKey = persona && PERSONAS[persona] ? persona : 'easy_close';
    if (personaKey === 'random') personaKey = pickRandomPersona();
    const cap = Math.min(parseInt(max_turns, 10) || SIM_MAX_TURNS, 30);

    // Reset sandbox conversation to start fresh
    await store.deleteSandboxConversation();

    const parsed = buildSandboxParsed(variables);
    const conv0 = await store.upsertConversation(parsed, { is_sandbox: true });

    const thread = []; // { role: 'lead' | 'bot', text, message_type?, terminal_outcome? }
    let terminal = null;
    let totalIn = 0;
    let totalOut = 0;

    for (let turn = 0; turn < cap; turn++) {
      // 1) Lead generates a message
      const leadGen = await generateLeadReply(personaKey, variables, thread);
      totalIn += leadGen.input_tokens;
      totalOut += leadGen.output_tokens;
      if (!leadGen.text || /^<<<END_SIM>>>$/.test(leadGen.text.trim())) {
        terminal = terminal || 'lead_abandoned';
        break;
      }
      thread.push({ role: 'lead', text: leadGen.text });

      await store.logMessage({
        conversationId: conv0.id,
        contactId: SANDBOX_CONTACT_ID,
        locationId: SANDBOX_LOCATION_ID,
        direction: 'inbound',
        content: leadGen.text
      });

      // 2) Bot responds through the real Claude pipeline
      const conv = await store.upsertConversation(parsed, { is_sandbox: true });
      const history = Array.isArray(conv.messages) ? conv.messages : [];
      const botResult = await claude.generateResponse(conv, history, leadGen.text);
      totalIn += botResult.input_tokens || 0;
      totalOut += botResult.output_tokens || 0;

      await store.appendMessageHistory(conv.id, 'user', leadGen.text);
      await store.appendMessageHistory(conv.id, 'assistant', botResult.rawAssistantContent);
      await store.applyCollectedData(conv.id, botResult.collected_data);

      for (const msg of (botResult.messages || [])) {
        await store.logMessage({
          conversationId: conv.id,
          contactId: SANDBOX_CONTACT_ID,
          locationId: SANDBOX_LOCATION_ID,
          direction: 'outbound',
          content: msg,
          messageType: botResult.message_type
        });
        thread.push({ role: 'bot', text: msg, message_type: botResult.message_type });
      }

      if (botResult.terminal_outcome) {
        terminal = botResult.terminal_outcome;
        await store.setTerminalOutcome(conv.id, botResult.terminal_outcome);
        break;
      }
    }

    res.json({
      persona: personaKey,
      persona_name: PERSONAS[personaKey]?.name,
      variables,
      thread,
      terminal_outcome: terminal,
      turns: thread.length,
      tokens: { input: totalIn, output: totalOut },
      max_turns: cap
    });
  } catch (err) {
    console.error('[sandbox/simulate] error', err);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

router.get('/personas', (req, res) => {
  const list = Object.entries(PERSONAS).map(([key, p]) => ({ key, name: p.name, description: p.description === '__RANDOM__' ? 'Pick a random persona each run.' : p.description }));
  res.json({ personas: list });
});

module.exports = router;
