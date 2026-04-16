const axios = require('axios');
const logger = require('./logger');

const GHL_BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-04-15';
const CONV_PAGE_SIZE = 100;
const MSG_PAGE_SIZE = 100;
const MSG_RATE_SLEEP_MS = 200;
const CONV_RATE_SLEEP_MS = 150;
const MAX_CONVERSATIONS = 5000;

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Version: VERSION,
    'Content-Type': 'application/json'
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function pullAllConversations(ghlToken, locationId, onProgress) {
  const out = [];
  let startAfterDate = null;
  let page = 0;

  while (out.length < MAX_CONVERSATIONS) {
    page++;
    const params = {
      locationId,
      limit: CONV_PAGE_SIZE,
      sortBy: 'last_message_date',
      sortOrder: 'desc'
    };
    if (startAfterDate !== null) params.startAfterDate = startAfterDate;

    let res;
    try {
      res = await axios.get(`${GHL_BASE}/conversations/search`, {
        headers: authHeaders(ghlToken),
        params,
        timeout: 30000
      });
    } catch (err) {
      logger.log('analyzer', 'error', null, 'GHL conversations/search failed', {
        location_id: locationId,
        page,
        status: err.response?.status,
        error: err.response?.data || err.message
      });
      throw err;
    }

    const convs = res.data?.conversations || [];
    if (!convs.length) break;

    for (const c of convs) {
      out.push(c);
      if (out.length >= MAX_CONVERSATIONS) break;
    }

    if (onProgress) onProgress({ fetched: out.length, page });

    if (convs.length < CONV_PAGE_SIZE) break;

    const last = convs[convs.length - 1];
    const nextCursor = Array.isArray(last.sort) && last.sort.length ? last.sort[0] : (last.lastMessageDate || null);
    if (!nextCursor || nextCursor === startAfterDate) break;
    startAfterDate = nextCursor;

    await sleep(CONV_RATE_SLEEP_MS);
  }

  logger.log('analyzer', 'info', null, 'Pulled all GHL conversations', { location_id: locationId, count: out.length, pages: page });
  return out;
}

async function pullMessages(ghlToken, conversationId) {
  const out = [];
  let lastMessageId = null;
  let iterations = 0;

  while (iterations < 50) {
    iterations++;
    const params = { limit: MSG_PAGE_SIZE };
    if (lastMessageId) params.lastMessageId = lastMessageId;

    let res;
    try {
      res = await axios.get(`${GHL_BASE}/conversations/${conversationId}/messages`, {
        headers: authHeaders(ghlToken),
        params,
        timeout: 20000
      });
    } catch (err) {
      logger.log('analyzer', 'error', null, 'GHL messages fetch failed', {
        conversation_id: conversationId,
        status: err.response?.status,
        error: err.response?.data || err.message
      });
      throw err;
    }

    const body = res.data?.messages || res.data || {};
    const msgs = Array.isArray(body.messages) ? body.messages : (Array.isArray(body) ? body : []);
    if (!msgs.length) break;
    for (const m of msgs) out.push(m);

    const nextPage = body.nextPage === true || body.hasMore === true;
    const newLastId = body.lastMessageId || msgs[msgs.length - 1]?.id;
    if (!nextPage || !newLastId || newLastId === lastMessageId) break;
    lastMessageId = newLastId;
  }

  out.sort((a, b) => {
    const ad = new Date(a.dateAdded || a.created || 0).getTime();
    const bd = new Date(b.dateAdded || b.created || 0).getTime();
    return ad - bd;
  });

  return out;
}

const CLAUDE_JSON_MARKERS = ['"messages"', '"collected_data"', '"terminal_outcome"', '"message_type"'];
const BOTPRESS_PHRASES = [
  'just reaching out',
  'looks like a while back there was a request',
  'appreciate you reaching out',
  'how familiar are you with',
  'not a problem [firstname]'
];

function isClaudeJsonPayload(text) {
  if (!text || typeof text !== 'string') return false;
  if (!text.includes('{')) return false;
  let hits = 0;
  for (const marker of CLAUDE_JSON_MARKERS) {
    if (text.includes(marker)) hits++;
  }
  return hits >= 2;
}

function isBotpressStyleOutbound(text) {
  if (!text || typeof text !== 'string') return false;
  if (text.includes('|') && text.split('|').length >= 2 && text.length > 30) return true;
  const low = text.toLowerCase();
  return BOTPRESS_PHRASES.some((p) => low.includes(p));
}

function hasBotpressTags(conversation) {
  const tags = conversation?.tags;
  if (!tags) return false;
  if (Array.isArray(tags)) return tags.some((t) => /botpress|bpz|bot-press/i.test(String(t)));
  if (typeof tags === 'string') return /botpress|bpz|bot-press/i.test(tags);
  return false;
}

function detectTerminalOutcome(messages) {
  for (const m of [...messages].reverse()) {
    if (m.direction !== 'outbound') continue;
    const text = String(m.body || m.message || '').toLowerCase();
    if (!text) continue;
    if (/removing you from our list|opted out|take care\b/.test(text)) return 'dnc';
    if (/you're booked|you are booked|perfect.*booked|confirmed for|you'll be speaking/.test(text)) return 'appointment_booked';
    if (/turning off ai|reaching out directly|connect you with|have [a-z]+ reach out/.test(text)) return 'human_handoff';
  }
  return null;
}

function classifyConversation(conversation, messages, localContactIds) {
  const msgs = Array.isArray(messages) ? messages : [];

  if (localContactIds && conversation.contactId && localContactIds.has(conversation.contactId)) {
    return { source: 'claude', reason: 'in_local_db' };
  }

  let claudeHits = 0;
  let botpressHits = 0;
  let anyOutbound = false;

  for (const m of msgs) {
    const dir = m.direction;
    const text = m.body || m.message || '';
    if (dir === 'outbound') {
      anyOutbound = true;
      if (isClaudeJsonPayload(text)) claudeHits++;
      if (isBotpressStyleOutbound(text)) botpressHits++;
    }
  }

  if (hasBotpressTags(conversation)) botpressHits += 2;

  if (claudeHits >= 1 && claudeHits >= botpressHits) return { source: 'claude', reason: 'json_payload_detected' };
  if (botpressHits >= 1) return { source: 'botpress', reason: 'botpress_patterns' };
  if (!anyOutbound) return { source: 'other', reason: 'no_outbound' };
  return { source: 'other', reason: 'no_pattern_match' };
}

function isBotpressCompleted(messages) {
  if (!Array.isArray(messages) || !messages.length) return false;
  for (const m of [...messages].reverse()) {
    if (m.direction !== 'outbound') continue;
    const t = String(m.body || m.message || '').toLowerCase();
    if (!t) continue;
    return /you're booked|you are booked|perfect.*booked|confirmed for|removing you from our list|opted out|you'll be speaking|waiting on their zoom|scheduled/.test(t);
  }
  return false;
}

module.exports = {
  pullAllConversations,
  pullMessages,
  classifyConversation,
  isClaudeJsonPayload,
  isBotpressStyleOutbound,
  detectTerminalOutcome,
  isBotpressCompleted,
  sleep,
  MSG_RATE_SLEEP_MS
};
