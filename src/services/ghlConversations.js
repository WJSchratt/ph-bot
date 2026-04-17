const axios = require('axios');
const logger = require('./logger');
const db = require('../db');

const GHL_BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-04-15';
const CONV_PAGE_SIZE = 50;
const MSG_PAGE_SIZE = 100;
const MSG_RATE_SLEEP_MS = 50;
const MSG_PARALLEL = 5;
const CONV_RATE_SLEEP_MS = 100;
const MAX_CONVERSATIONS = 10000;

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
  // 200 iters × 100/page = up to 20,000 messages/conversation. Realistic
  // conversations are far smaller; this is a safety cap.
  const MAX_ITERS = 200;

  while (iterations < MAX_ITERS) {
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
        iteration: iterations,
        status: err.response?.status,
        error: err.response?.data || err.message
      });
      throw err;
    }

    const body = res.data?.messages || res.data || {};
    const msgs = Array.isArray(body.messages) ? body.messages : (Array.isArray(body) ? body : []);
    if (!msgs.length) break;
    for (const m of msgs) out.push(m);

    // Previous version trusted body.nextPage/hasMore, but GHL omits these or
    // returns them as false even mid-stream — which truncated every >100-msg
    // conversation. Instead: paginate until we get a short page or the cursor
    // stops advancing.
    if (msgs.length < MSG_PAGE_SIZE) break;
    const newLastId = body.lastMessageId || msgs[msgs.length - 1]?.id;
    if (!newLastId || newLastId === lastMessageId) break;
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

// ============================================================================
// Persistent storage: pullAndStore writes conversations + messages to Postgres
// as they arrive. Survives deploys, supports incremental re-pulls.
// ============================================================================

function tsOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(typeof v === 'number' ? v : String(v));
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

// Include SMS + MMS; exclude everything else (email, call, voicemail, facebook,
// instagram, webchat, etc.). Previous version only checked for "SMS" which
// silently dropped every MMS message from ghl_messages.
const NON_SMS_TYPE_MARKERS = ['EMAIL', 'CALL', 'VOICEMAIL', 'FACEBOOK', 'INSTAGRAM', 'WEBCHAT', 'LIVE_CHAT', 'REVIEW', 'GMB', 'ACTIVITY', 'CUSTOM_EMAIL'];
function isSmsMessage(m) {
  const mt = String(m.messageType || m.type || '').toUpperCase();
  if (!mt) return true;
  if (mt.includes('SMS') || mt.includes('MMS') || mt === '1' || mt === '2') return true;
  for (const marker of NON_SMS_TYPE_MARKERS) if (mt.includes(marker)) return false;
  // Unknown type — include by default (don't silently drop like we used to).
  return true;
}

function messageText(m) {
  return String(m.body || m.message || m.content || '').trim();
}

function extractContactName(c) {
  return (c.contactName || c.fullName || [c.contactFirstName, c.contactLastName].filter(Boolean).join(' ') || '').trim();
}

async function upsertGhlConversation(row) {
  await db.query(
    `INSERT INTO ghl_conversations
       (ghl_conversation_id, contact_id, contact_name, contact_phone, location_id,
        source, ghl_date_added, ghl_date_updated, pulled_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(), NOW() + INTERVAL '90 days')
     ON CONFLICT (ghl_conversation_id, location_id) DO UPDATE SET
       contact_id = COALESCE(EXCLUDED.contact_id, ghl_conversations.contact_id),
       contact_name = COALESCE(NULLIF(EXCLUDED.contact_name, ''), ghl_conversations.contact_name),
       contact_phone = COALESCE(NULLIF(EXCLUDED.contact_phone, ''), ghl_conversations.contact_phone),
       ghl_date_added = COALESCE(EXCLUDED.ghl_date_added, ghl_conversations.ghl_date_added),
       ghl_date_updated = COALESCE(EXCLUDED.ghl_date_updated, ghl_conversations.ghl_date_updated),
       pulled_at = NOW(),
       expires_at = NOW() + INTERVAL '90 days'`,
    [
      row.ghl_conversation_id,
      row.contact_id || null,
      row.contact_name || null,
      row.contact_phone || null,
      row.location_id,
      row.source || 'other',
      row.ghl_date_added,
      row.ghl_date_updated
    ]
  );
}

async function replaceMessagesForConversation(ghlConversationId, locationId, messages) {
  // Nuke + reinsert all messages for this conversation. Safe because GHL
  // gives us an authoritative view of the full thread on every pull.
  // After the Bug 3 pipeline fix, this is also the idempotent way to rebuild
  // truncated threads — whatever's in the DB gets replaced with the complete
  // set from GHL.
  await db.query(
    `DELETE FROM ghl_messages WHERE ghl_conversation_id = $1 AND location_id = $2`,
    [ghlConversationId, locationId]
  );
  if (!messages.length) return;

  const values = [];
  const params = [];
  let p = 1;
  for (const m of messages) {
    values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
    params.push(
      ghlConversationId,
      locationId,
      m.direction || null,
      messageText(m) || null,
      m.messageType || m.type || null,
      tsOrNull(m.dateAdded || m.created),
      m.id || null
    );
  }
  await db.query(
    `INSERT INTO ghl_messages (ghl_conversation_id, location_id, direction, content, message_type, created_at, ghl_message_id) VALUES ${values.join(', ')}`,
    params
  );
}

async function updateConversationAggregates(ghlConversationId, locationId, { source, messageCount, lastMessageAt }) {
  await db.query(
    `UPDATE ghl_conversations
     SET source = COALESCE($3, source),
         message_count = COALESCE($4, message_count),
         last_message_at = COALESCE($5, last_message_at)
     WHERE ghl_conversation_id = $1 AND location_id = $2`,
    [ghlConversationId, locationId, source || null, messageCount, lastMessageAt || null]
  );
}

async function getIncrementalCursorMs(locationId) {
  const q = await db.query(
    `SELECT MAX(ghl_date_updated) AS max_updated FROM ghl_conversations WHERE location_id = $1`,
    [locationId]
  );
  const v = q.rows[0]?.max_updated;
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.getTime();
}

async function getKnownConversationUpdatedMap(locationId) {
  const q = await db.query(
    `SELECT ghl_conversation_id, ghl_date_updated FROM ghl_conversations WHERE location_id = $1`,
    [locationId]
  );
  const map = new Map();
  for (const r of q.rows) {
    map.set(r.ghl_conversation_id, r.ghl_date_updated ? new Date(r.ghl_date_updated).getTime() : 0);
  }
  return map;
}

async function loadLocalClaudeContactIds(locationId) {
  try {
    const q = await db.query(
      `SELECT DISTINCT contact_id FROM conversations WHERE location_id = $1 AND is_sandbox = FALSE`,
      [locationId]
    );
    return new Set(q.rows.map((r) => r.contact_id).filter(Boolean));
  } catch {
    return new Set();
  }
}

async function processInParallel(items, concurrency, workerFn) {
  let i = 0;
  const runners = [];
  for (let w = 0; w < concurrency; w++) {
    runners.push((async () => {
      while (true) {
        const idx = i++;
        if (idx >= items.length) return;
        await workerFn(items[idx], idx);
      }
    })());
  }
  await Promise.all(runners);
}

async function pullAndStore(ghlToken, locationId, progressCallback, options = {}) {
  const progress = (p) => { if (typeof progressCallback === 'function') progressCallback(p); };
  const fullRepull = !!options.fullRepull;

  // Full repull: ignore the incremental cursor and re-fetch every conversation
  // GHL will give us. Used after pipeline fixes to rebuild a complete dataset.
  const cursorMs = fullRepull ? null : await getIncrementalCursorMs(locationId);
  const isIncremental = cursorMs !== null;

  logger.log('analyzer', 'info', null, 'pullAndStore started', {
    locationId, incremental: isIncremental, cursor: cursorMs ? new Date(cursorMs).toISOString() : null
  });

  // --- Pull conversations, upsert as pages arrive ---
  let startAfterDate = null;
  let page = 0;
  let totalFetched = 0;
  const fetchedIds = []; // ghl_conversation_id list in the order we saw them
  const updatedByGhl = new Map(); // id → last ghl_date_updated ms

  outer: while (totalFetched < MAX_CONVERSATIONS) {
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
        headers: { Authorization: `Bearer ${ghlToken}`, Version: VERSION },
        params,
        timeout: 30000
      });
    } catch (err) {
      logger.log('analyzer', 'error', null, 'GHL conversations/search failed', {
        location_id: locationId, page,
        status: err.response?.status,
        error: err.response?.data || err.message
      });
      throw err;
    }

    const convs = res.data?.conversations || [];
    if (!convs.length) break;

    for (const c of convs) {
      const lastMsgTs = c.lastMessageDate || (Array.isArray(c.sort) && c.sort[0]) || 0;
      if (isIncremental && lastMsgTs && lastMsgTs < cursorMs) {
        // Reached data we already have up to date — stop.
        break outer;
      }
      await upsertGhlConversation({
        ghl_conversation_id: c.id,
        contact_id: c.contactId || null,
        contact_name: extractContactName(c),
        contact_phone: c.phone || c.contactPhone || null,
        location_id: locationId,
        source: 'other',
        ghl_date_added: tsOrNull(c.dateAdded || c.createdAt),
        ghl_date_updated: tsOrNull(c.lastMessageDate || c.dateUpdated)
      });
      fetchedIds.push(c.id);
      updatedByGhl.set(c.id, typeof lastMsgTs === 'number' ? lastMsgTs : new Date(lastMsgTs || 0).getTime());
      totalFetched++;
      if (totalFetched >= MAX_CONVERSATIONS) break outer;
    }

    progress({ phase: 'conversations', fetched: totalFetched, page });

    if (convs.length < CONV_PAGE_SIZE) break;
    const last = convs[convs.length - 1];
    const nextCursor = Array.isArray(last.sort) && last.sort.length ? last.sort[0] : last.lastMessageDate;
    if (!nextCursor || nextCursor === startAfterDate) break;
    startAfterDate = nextCursor;

    await sleep(CONV_RATE_SLEEP_MS);
  }

  logger.log('analyzer', 'info', null, 'Conversations stored', {
    locationId, count: totalFetched, pages: page, incremental: isIncremental
  });

  // --- Pick which conversations need messages fetched ---
  const knownUpdated = await getKnownConversationUpdatedMap(locationId);

  // Also include any DB-known conversations that have zero messages yet.
  const emptyQ = await db.query(
    `SELECT c.ghl_conversation_id
     FROM ghl_conversations c
     LEFT JOIN (SELECT ghl_conversation_id, COUNT(*) AS n FROM ghl_messages WHERE location_id = $1 GROUP BY ghl_conversation_id) m
       ON m.ghl_conversation_id = c.ghl_conversation_id
     WHERE c.location_id = $1 AND (m.n IS NULL OR m.n = 0)`,
    [locationId]
  );
  const emptyIds = new Set(emptyQ.rows.map((r) => r.ghl_conversation_id));

  const toFetch = [];
  for (const id of fetchedIds) {
    if (fullRepull) {
      // Re-fetch messages for every conversation — pipeline bugs (truncation
      // at 100 msgs, MMS dropped) mean every stored thread is potentially
      // incomplete and must be rebuilt.
      toFetch.push(id);
      continue;
    }
    const dbUpdated = knownUpdated.get(id) || 0;
    const ghlUpdated = updatedByGhl.get(id) || 0;
    if (!dbUpdated || ghlUpdated > dbUpdated || emptyIds.has(id)) {
      toFetch.push(id);
    }
  }
  // Also pick up any conversations that were known but have zero messages stored.
  for (const id of emptyIds) {
    if (!toFetch.includes(id)) toFetch.push(id);
  }

  const localClaudeIds = await loadLocalClaudeContactIds(locationId);

  // --- Fetch messages in parallel (5 at a time), classify, store ---
  let messagesFetched = 0;
  const total = toFetch.length;
  progress({ phase: 'messages', fetched: 0, total });

  const BATCH = 250;
  for (let start = 0; start < toFetch.length; start += BATCH) {
    const batch = toFetch.slice(start, start + BATCH);
    await processInParallel(batch, MSG_PARALLEL, async (ghlConvId) => {
      let msgs = [];
      try {
        msgs = await pullMessages(ghlToken, ghlConvId);
      } catch {
        msgs = [];
      }
      const filtered = msgs.filter(isSmsMessage);
      await replaceMessagesForConversation(ghlConvId, locationId, filtered);

      // Classify
      const contactIdOfConv = await db.query(
        `SELECT contact_id FROM ghl_conversations WHERE ghl_conversation_id = $1 AND location_id = $2`,
        [ghlConvId, locationId]
      );
      const convRow = { id: ghlConvId, contactId: contactIdOfConv.rows[0]?.contact_id, location_id: locationId };
      const classification = classifyConversation(convRow, filtered, localClaudeIds);
      const terminal = detectTerminalOutcome(filtered);
      const lastMs = filtered.reduce((acc, m) => {
        const t = new Date(m.dateAdded || m.created || 0).getTime();
        return t > acc ? t : acc;
      }, 0);

      await updateConversationAggregates(ghlConvId, locationId, {
        source: classification.source,
        messageCount: filtered.length,
        lastMessageAt: lastMs ? new Date(lastMs).toISOString() : null
      });
      if (terminal) {
        await db.query(
          `UPDATE ghl_conversations SET terminal_outcome = $3 WHERE ghl_conversation_id = $1 AND location_id = $2`,
          [ghlConvId, locationId, terminal]
        );
      }

      messagesFetched++;
      if (messagesFetched % 10 === 0 || messagesFetched === total) {
        progress({ phase: 'messages', fetched: messagesFetched, total });
      }
      if (MSG_RATE_SLEEP_MS) await sleep(MSG_RATE_SLEEP_MS);
    });
  }

  logger.log('analyzer', 'info', null, 'pullAndStore complete', {
    locationId, total_conversations: totalFetched, messages_fetched_for: toFetch.length
  });

  return { total_conversations: totalFetched, messages_fetched_for: toFetch.length, incremental: isIncremental };
}

module.exports = {
  pullAllConversations,
  pullMessages,
  classifyConversation,
  isClaudeJsonPayload,
  isBotpressStyleOutbound,
  detectTerminalOutcome,
  isBotpressCompleted,
  pullAndStore,
  sleep,
  MSG_RATE_SLEEP_MS
};
