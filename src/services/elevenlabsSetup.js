const axios = require('axios');
const logger = require('./logger');

const EL_BASE = 'https://api.elevenlabs.io';

function elHeaders() {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('ELEVENLABS_API_KEY env var not set');
  return { 'xi-api-key': key, 'Content-Type': 'application/json' };
}

async function getAgent(agentId) {
  const res = await axios.get(`${EL_BASE}/v1/convai/agents/${agentId}`, {
    headers: elHeaders(),
    timeout: 20000,
  });
  return res.data;
}

// Clone an agent from a template, giving it a new name
async function cloneAgent(templateAgentId, newName) {
  const template = await getAgent(templateAgentId);
  const payload = {
    name: newName,
    conversation_config: template.conversation_config,
    platform_settings: template.platform_settings || {},
  };
  const res = await axios.post(`${EL_BASE}/v1/convai/agents/create`, payload, {
    headers: elHeaders(),
    timeout: 30000,
  });
  return res.data; // { agent_id, name }
}

// Update an agent's post-call webhook settings
async function setPostCallWebhook(agentId, webhookUrl, webhookSecret) {
  const agent = await getAgent(agentId);
  const ps = agent.platform_settings || {};
  ps.auth = ps.auth || {};
  ps.auth.webhook = { url: webhookUrl, secret: webhookSecret || undefined };

  await axios.patch(`${EL_BASE}/v1/convai/agents/${agentId}`,
    { platform_settings: ps },
    { headers: elHeaders(), timeout: 20000 }
  );
}

// Build the per-client custom value map for ElevenLabs agent IDs
// and configure post-call webhooks pointing to their GHL Post-Call Router.
//
// For now the post_call_router_url is a MANUAL step — Walt creates the GHL
// workflow webhook in the new sub-account and pastes the URL into the custom
// value. We note that in the checklist notification.

async function createAgentsForClient({ businessName, vertical, languages }) {
  const results = {};
  const errors = [];

  // Pick the right template per vertical
  const templateIdEn = vertical === 'chiropractic'
    ? (process.env.ELEVENLABS_CHIRO_AGENT_ID || 'agent_7401kqaqry8pffx94d2nht3yffw4')
    : (process.env.ELEVENLABS_TEMPLATE_AGENT_EN || 'agent_2001kpf1b4vme47vjawagajw23e4');

  // English agent (always created)
  try {
    const enName = `${businessName} - ${vertical === 'chiropractic' ? 'Front Desk' : 'After Hours Caller'} (EN)`;
    results.en = await cloneAgent(templateIdEn, enName);
    logger.log('elevenlabs_setup', 'info', null, 'EN agent created', { agent_id: results.en.agent_id });
  } catch (err) {
    logger.log('elevenlabs_setup', 'error', null, 'EN agent creation failed', { error: err.message });
    errors.push({ lang: 'en', error: err.message });
  }

  // Spanish agent
  if (languages === 'es' || languages === 'both') {
    try {
      const templateIdEs = process.env.ELEVENLABS_TEMPLATE_AGENT_ES || templateIdEn;
      const esName = `${businessName} - ${vertical === 'chiropractic' ? 'Front Desk' : 'After Hours Caller'} (ES)`;
      const esAgent = await cloneAgent(templateIdEs, esName);
      // Switch the language setting on the cloned agent
      await axios.patch(`${EL_BASE}/v1/convai/agents/${esAgent.agent_id}`, {
        conversation_config: { agent: { language: 'es' } },
      }, { headers: elHeaders(), timeout: 20000 });
      results.es = esAgent;
      logger.log('elevenlabs_setup', 'info', null, 'ES agent created', { agent_id: results.es.agent_id });
    } catch (err) {
      logger.log('elevenlabs_setup', 'error', null, 'ES agent creation failed', { error: err.message });
      errors.push({ lang: 'es', error: err.message });
    }
  }

  return { agents: results, errors };
}

module.exports = { cloneAgent, getAgent, setPostCallWebhook, createAgentsForClient };
