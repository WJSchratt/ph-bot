/**
 * GET /api/audit/ghl-history
 *
 * Read-only audit: compares stored ghl_messages against live GHL API for
 * the last 50 contacts the Claude bot responded to.
 *
 * Returns markdown report as text/plain. Protected by requireAuth (/api/*).
 *
 * Usage:
 *   curl -H "Authorization: Bearer $ADMIN_API_KEY" \
 *        https://web-production-f3109.up.railway.app/api/audit/ghl-history \
 *        > reports/ghl_history_audit_2026-05-05.md
 */

'use strict';

const express = require('express');
const axios = require('axios');
const db = require('../db');
const logger = require('../services/logger');
const { isBotpressStyleOutbound, isClaudeJsonPayload } = require('../services/ghlConversations');
const router = express.Router();

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-04-15';
const SLEEP_MS = 300;
const AUDIT_LIMIT = 50;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const NON_SMS_MARKERS = [
  'EMAIL', 'CALL', 'VOICEMAIL', 'FACEBOOK', 'INSTAGRAM',
  'WEBCHAT', 'LIVE_CHAT', 'REVIEW', 'GMB', 'ACTIVITY', 'CUSTOM_EMAIL'
];

function isSmsMessage(m) {
  const mt = String(m.messageType || m.type || '').toUpperCase();
  if (!mt) return true;
  if (mt.includes('SMS') || mt.includes('MMS') || mt === '1' || mt === '2') return true;
  for (const marker of NON_SMS_MARKERS) if (mt.includes(marker)) return false;
  return true;
}

function msgText(m) {
  return String(m.body || m.message || m.content || '').trim();
}

function msgTs(m) {
  const raw = m.dateAdded || m.created || m.created_at || 0;
  if (!raw) return 0;
  if (typeof raw === 'number') return raw;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

function normalizeContent(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// ─── GHL API ─────────────────────────────────────────────────────────────────

async function fetchGhlMessages(token, ghlConvId) {
  const out = [];
  let lastMessageId = null;
  let iters = 0;

  while (iters < 50) {
    iters++;
    const params = { limit: 100 };
    if (lastMessageId) params.lastMessageId = lastMessageId;

    let res;
    try {
      res = await axios.get(`${GHL_BASE}/conversations/${ghlConvId}/messages`, {
        headers: { Authorization: `Bearer ${token}`, Version: GHL_VERSION },
        params,
        timeout: 20000
      });
    } catch (err) {
      const status = err.response?.status;
      return { ok: false, error: `HTTP ${status || 'network'}: ${err.message}`, messages: [] };
    }

    const body = res.data?.messages || res.data || {};
    const msgs = Array.isArray(body.messages) ? body.messages
      : (Array.isArray(body) ? body : []);
    if (!msgs.length) break;
    for (const m of msgs) out.push(m);
    if (msgs.length < 100) break;
    const newLastId = body.lastMessageId || msgs[msgs.length - 1]?.id;
    if (!newLastId || newLastId === lastMessageId) break;
    lastMessageId = newLastId;
    await sleep(80);
  }

  out.sort((a, b) => msgTs(a) - msgTs(b));
  return { ok: true, messages: out.filter(isSmsMessage), error: null };
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function getGhlTokenForLocation(locationId) {
  const r1 = await db.query(
    `SELECT ghl_api_key FROM subaccounts
     WHERE ghl_location_id = $1 AND ghl_api_key IS NOT NULL AND ghl_api_key <> ''
     LIMIT 1`,
    [locationId]
  );
  if (r1.rows[0]?.ghl_api_key) return r1.rows[0].ghl_api_key;

  const r2 = await db.query(
    `SELECT ghl_token FROM conversations
     WHERE location_id = $1 AND ghl_token IS NOT NULL AND ghl_token <> ''
     ORDER BY updated_at DESC LIMIT 1`,
    [locationId]
  );
  return r2.rows[0]?.ghl_token || null;
}

// ─── Diff ────────────────────────────────────────────────────────────────────

function diffMessages(stored, live) {
  const issues = [];

  if (stored.length !== live.length) {
    issues.push({
      type: 'count_mismatch',
      detail: `stored=${stored.length} vs live=${live.length} (delta=${live.length - stored.length})`
    });
  }

  const liveById = new Map();
  for (const m of live) if (m.id) liveById.set(m.id, m);

  const paired = [];
  const livePaired = new Set();

  for (const s of stored) {
    let liveMatch = null;
    if (s.ghl_message_id && liveById.has(s.ghl_message_id)) {
      liveMatch = liveById.get(s.ghl_message_id);
      livePaired.add(s.ghl_message_id);
    } else {
      const sTs = s.created_at ? new Date(s.created_at).getTime() : 0;
      const sNorm = normalizeContent(s.content);
      for (const lm of live) {
        if (livePaired.has(lm.id)) continue;
        const lTs = msgTs(lm);
        const lNorm = normalizeContent(msgText(lm));
        if (sNorm === lNorm && Math.abs(sTs - lTs) < 60000) {
          liveMatch = lm;
          livePaired.add(lm.id);
          break;
        }
      }
    }
    paired.push({ stored: s, live: liveMatch });
  }

  const onlyInLive = live.filter(lm => lm.id && !livePaired.has(lm.id));
  if (onlyInLive.length) {
    issues.push({
      type: 'missing_in_stored',
      detail: `${onlyInLive.length} live GHL message(s) not in ghl_messages table`,
      samples: onlyInLive.slice(0, 3).map(m => ({
        id: m.id,
        direction: m.direction,
        content: msgText(m).slice(0, 80),
        ts: m.dateAdded || m.created
      }))
    });
  }

  const onlyInStored = paired.filter(p => !p.live).map(p => p.stored);
  if (onlyInStored.length) {
    issues.push({
      type: 'extra_in_stored',
      detail: `${onlyInStored.length} stored message(s) have no match in live GHL`,
      samples: onlyInStored.slice(0, 3).map(m => ({
        ghl_message_id: m.ghl_message_id,
        direction: m.direction,
        content: String(m.content || '').slice(0, 80),
        ts: m.created_at
      }))
    });
  }

  let contentMismatches = 0;
  let directionMismatches = 0;
  const contentSamples = [];
  const directionSamples = [];

  for (const { stored: s, live: l } of paired) {
    if (!l) continue;
    const storedNorm = normalizeContent(s.content);
    const liveNorm = normalizeContent(msgText(l));
    if (storedNorm !== liveNorm) {
      contentMismatches++;
      if (contentSamples.length < 3) {
        contentSamples.push({
          ghl_message_id: s.ghl_message_id || l.id,
          stored: String(s.content || '').slice(0, 100),
          live: msgText(l).slice(0, 100)
        });
      }
    }
    const storedDir = (s.direction || '').toLowerCase();
    const liveDir = (l.direction || '').toLowerCase();
    if (storedDir && liveDir && storedDir !== liveDir) {
      directionMismatches++;
      if (directionSamples.length < 3) {
        directionSamples.push({
          ghl_message_id: s.ghl_message_id || l.id,
          stored_direction: storedDir,
          live_direction: liveDir,
          content: msgText(l).slice(0, 60)
        });
      }
    }
  }

  if (contentMismatches > 0) {
    issues.push({
      type: 'content_mismatch',
      detail: `${contentMismatches} paired message(s) have differing content`,
      samples: contentSamples
    });
  }
  if (directionMismatches > 0) {
    issues.push({
      type: 'direction_mismatch',
      detail: `${directionMismatches} paired message(s) have differing direction/sender`,
      samples: directionSamples
    });
  }

  // Order check: compare direction sequence
  const storedSeq = stored.map(m => (m.direction || '').charAt(0)).join('');
  const liveSeq = live.map(m => (m.direction || '').charAt(0)).join('');
  if (storedSeq !== liveSeq && stored.length > 0 && live.length > 0) {
    issues.push({
      type: 'order_mismatch',
      detail: `Direction sequence differs (first 30): stored="${storedSeq.slice(0, 30)}" live="${liveSeq.slice(0, 30)}"`
    });
  }

  return issues;
}

function diffJsonb(jsonbMsgs, liveGhlMsgs) {
  if (!Array.isArray(jsonbMsgs) || !jsonbMsgs.length) return null;
  const userMsgs = jsonbMsgs.filter(m => m.role === 'user');
  const assistantMsgs = jsonbMsgs.filter(m => m.role === 'assistant');
  const liveInbound = liveGhlMsgs.filter(m => (m.direction || '').toLowerCase() === 'inbound');
  const liveOutbound = liveGhlMsgs.filter(m => (m.direction || '').toLowerCase() === 'outbound');
  const issues = [];
  if (userMsgs.length !== liveInbound.length) {
    issues.push(`JSONB has ${userMsgs.length} user turns, live GHL has ${liveInbound.length} inbound messages`);
  }
  if (assistantMsgs.length !== liveOutbound.length) {
    issues.push(`JSONB has ${assistantMsgs.length} assistant turns, live GHL has ${liveOutbound.length} outbound messages`);
  }
  return issues.length ? issues : null;
}

// ─── Report builder ───────────────────────────────────────────────────────────

function buildReport(results, auditDate) {
  const total = results.length;
  const skipped = results.filter(r => r.skipped);
  const audited = results.filter(r => !r.skipped);
  const clean = audited.filter(r => r.issues.length === 0 && !r.jsonb_issues);
  const mismatched = audited.filter(r => r.issues.length > 0 || r.jsonb_issues);

  const countMismatches = audited.filter(r => r.issues.some(i => i.type === 'count_mismatch'));
  const orderMismatches = audited.filter(r => r.issues.some(i => i.type === 'order_mismatch'));
  const contentMismatches = audited.filter(r => r.issues.some(i => i.type === 'content_mismatch'));
  const directionMismatches = audited.filter(r => r.issues.some(i => i.type === 'direction_mismatch'));
  const missingInStored = audited.filter(r => r.issues.some(i => i.type === 'missing_in_stored'));
  const extraInStored = audited.filter(r => r.issues.some(i => i.type === 'extra_in_stored'));
  const jsonbIssues = audited.filter(r => r.jsonb_issues && r.jsonb_issues.length > 0);

  const L = [];
  const matchRate = audited.length > 0 ? ((clean.length / audited.length) * 100).toFixed(1) : 'N/A';

  L.push('# GHL Conversation History Accuracy Audit');
  L.push(`**Date:** ${auditDate}`);
  L.push(`**Scope:** Last ${AUDIT_LIMIT} contacts Claude bot responded to`);
  L.push('');
  L.push('---');
  L.push('');
  L.push('## Summary Statistics');
  L.push('');
  L.push('| Metric | Count |');
  L.push('|--------|-------|');
  L.push(`| Contacts audited | ${total} |`);
  L.push(`| Skipped (no GHL conv / no token / API error) | ${skipped.length} |`);
  L.push(`| Successfully compared | ${audited.length} |`);
  L.push(`| **Clean (no issues)** | **${clean.length}** |`);
  L.push(`| **Mismatched (>=1 issue)** | **${mismatched.length}** |`);
  L.push(`| Count mismatches | ${countMismatches.length} |`);
  L.push(`| Missing-in-stored (live > DB) | ${missingInStored.length} |`);
  L.push(`| Extra-in-stored (DB > live) | ${extraInStored.length} |`);
  L.push(`| Message order differs | ${orderMismatches.length} |`);
  L.push(`| Content mismatches | ${contentMismatches.length} |`);
  L.push(`| Direction/attribution mismatches | ${directionMismatches.length} |`);
  L.push(`| JSONB vs live GHL misalignment | ${jsonbIssues.length} |`);
  L.push('');
  L.push(`**Accuracy rate:** ${matchRate}% of audited contacts have perfectly matching stored history.`);
  L.push('');

  if (skipped.length > 0) {
    L.push('---');
    L.push('');
    L.push(`## Skipped Contacts (${skipped.length})`);
    L.push('');
    for (const r of skipped) {
      L.push(`- **${r.contact_id}** (${r.subaccount_name}) — ${r.skip_reason}`);
    }
    L.push('');
  }

  if (mismatched.length > 0) {
    L.push('---');
    L.push('');
    L.push(`## Mismatched Contacts (${mismatched.length})`);
    L.push('');

    for (const r of mismatched) {
      const name = [r.first_name, r.last_name].filter(Boolean).join(' ') || '(no name)';
      const ts = r.last_message_at
        ? new Date(r.last_message_at).toISOString().slice(0, 16).replace('T', ' ')
        : 'unknown';
      L.push(`### ${name} — \`${r.contact_id}\``);
      L.push('');
      L.push(`- **Location:** ${r.subaccount_name} (\`${r.location_id}\`)`);
      L.push(`- **GHL Conversation ID:** \`${r.ghl_conv_id || 'unknown'}\``);
      L.push(`- **Last message at:** ${ts}`);
      L.push(`- **Stored (ghl_messages):** ${r.stored_count} | **Live GHL:** ${r.live_count} | **JSONB turns:** ${r.jsonb_msg_count}`);
      L.push('');

      for (const issue of r.issues) {
        L.push(`#### Issue: \`${issue.type}\``);
        L.push('');
        L.push(`> ${issue.detail}`);
        L.push('');
        if (issue.samples && issue.samples.length > 0) {
          L.push('**Samples:**');
          L.push('');
          L.push('```json');
          L.push(JSON.stringify(issue.samples, null, 2));
          L.push('```');
          L.push('');
        }
      }

      if (r.jsonb_issues && r.jsonb_issues.length > 0) {
        L.push('#### Issue: `jsonb_vs_live_misalignment`');
        L.push('');
        for (const ji of r.jsonb_issues) L.push(`> ${ji}`);
        L.push('');
      }
    }
  }

  if (clean.length > 0) {
    L.push('---');
    L.push('');
    L.push(`## Clean Contacts (${clean.length}) — No Issues`);
    L.push('');
    L.push('| Contact ID | Location | Stored | Live |');
    L.push('|-----------|----------|--------|------|');
    for (const r of clean) {
      L.push(`| \`${r.contact_id}\` | ${r.subaccount_name} | ${r.stored_count} | ${r.live_count} |`);
    }
    L.push('');
  }

  L.push('---');
  L.push('');
  L.push('## Root Cause Hypotheses');
  L.push('');

  if (missingInStored.length > 0) {
    const totalMissing = missingInStored.reduce((acc, r) => {
      const issue = r.issues.find(i => i.type === 'missing_in_stored');
      const match = issue?.detail?.match(/^(\d+)/);
      return acc + (match ? parseInt(match[1]) : 0);
    }, 0);
    L.push('### Missing-in-stored (live GHL has messages our DB does not)');
    L.push('');
    L.push(`Messages exist in GHL that are absent from \`ghl_messages\`. Most likely: new messages arrived after the last incremental pull, the incremental cursor skipped this conversation because \`ghl_date_updated\` did not advance, or a pull was interrupted by 429s that exhausted retries. Fix: run a full repull via \`POST /api/qc/pull-all-locations\` with \`{ "fullRepull": true }\`.`);
    L.push('');
    L.push(`**Affected contacts:** ${missingInStored.length} | **Total missing messages:** ${totalMissing}`);
    L.push('');
  }

  if (extraInStored.length > 0) {
    L.push('### Extra-in-stored (our DB has messages GHL does not)');
    L.push('');
    L.push('Messages in `ghl_messages` with no matching GHL record. Possible causes: (1) GHL soft-deleted a message or merged conversations since last pull, (2) ghost/test messages from workflow testing that GHL later removed, (3) a previous code bug that inserted rows from a failed/partial API response before the "do not write on failure" guard was added (see commit comment in ghlConversations.js).');
    L.push('');
    L.push(`**Affected contacts:** ${extraInStored.length}`);
    L.push('');
  }

  if (countMismatches.length > 0) {
    const positiveDelta = countMismatches.filter(r => {
      const issue = r.issues.find(i => i.type === 'count_mismatch');
      const match = issue?.detail?.match(/delta=(-?\d+)/);
      return match && parseInt(match[1]) > 0;
    });
    const negativeDelta = countMismatches.filter(r => {
      const issue = r.issues.find(i => i.type === 'count_mismatch');
      const match = issue?.detail?.match(/delta=(-?\d+)/);
      return match && parseInt(match[1]) < 0;
    });
    if (positiveDelta.length > 0) {
      L.push('### Count: Live > Stored');
      L.push('');
      L.push(`New messages arrived after the last pull. Run a full repull to sync. ${positiveDelta.length} contact(s) affected.`);
      L.push('');
    }
    if (negativeDelta.length > 0) {
      L.push('### Count: Stored > Live');
      L.push('');
      L.push(`ghl_messages has more rows than live GHL — GHL may have soft-deleted or merged messages, or non-SMS types slipped through the isSmsMessage filter in an older code version. ${negativeDelta.length} contact(s) affected.`);
      L.push('');
    }
  }

  if (orderMismatches.length > 0) {
    L.push('### Order Mismatches');
    L.push('');
    L.push(`Timestamp drift between GHL's \`dateAdded\` and the \`created_at\` value stored in \`ghl_messages\` causes the \`ORDER BY created_at\` sort to differ from GHL's own sequence. Likely from messages sent near a DST boundary or during a 429-retry delay where we stored a later timestamp than GHL recorded. ${orderMismatches.length} contact(s) affected.`);
    L.push('');
  }

  if (contentMismatches.length > 0) {
    L.push('### Content Mismatches');
    L.push('');
    L.push(`Message body stored in \`ghl_messages\` differs from live GHL. Most likely cause: an older version of \`messageText()\` picked the wrong field (body vs message vs content) for certain message types. Alternatively, GHL edited or merged a message after it was pulled. ${contentMismatches.length} contact(s) affected.`);
    L.push('');
  }

  if (directionMismatches.length > 0) {
    L.push('### Direction/Sender Attribution Mismatches');
    L.push('');
    L.push(`Stored \`direction\` does not match live GHL. Possible causes: (1) GHL API returned a different direction value on a later call (rare but seen on GHL platform updates), (2) manual agent sends reclassified by GHL after the fact, (3) an older version of the storage code misread the direction field. ${directionMismatches.length} contact(s) affected.`);
    L.push('');
  }

  if (jsonbIssues.length > 0) {
    L.push('### JSONB vs Live GHL Misalignment');
    L.push('');
    L.push(`The \`conversations.messages\` JSONB is Claude's internal context window — it reflects exactly what the bot saw during live conversation. Misalignment with live GHL indicates Claude was generating responses with incomplete context. The delta is typically messages sent outside the bot webhook flow (manual agent sends, drip texts, other system messages). This is expected behaviour, not a bug — but a large delta may cause the bot to re-ask already-answered questions. ${jsonbIssues.length} contact(s) affected.`);
    L.push('');
  }

  if (mismatched.length === 0 && skipped.length === 0) {
    L.push('No issues found. All audited contacts have perfectly matching stored history.');
    L.push('');
  }

  L.push('---');
  L.push('');
  L.push('## Recommendations');
  L.push('');

  const recs = [];
  const liveMoreThanStored = missingInStored.length > 0 || countMismatches.filter(r => {
    const i = r.issues.find(x => x.type === 'count_mismatch');
    const m = i?.detail?.match(/delta=(-?\d+)/);
    return m && parseInt(m[1]) > 0;
  }).length > 0;

  if (liveMoreThanStored) {
    recs.push('1. **Run a full GHL repull** — `POST /api/qc/pull-all-locations` with `{ "fullRepull": true }`. This rebuilds `ghl_messages` from scratch, fixing missing messages and count gaps.');
  }
  if (extraInStored.length > 0) {
    recs.push('2. **Investigate extra-in-stored rows** — query `ghl_messages` for rows whose `ghl_message_id` values do not exist in GHL. These may be ghost rows from the pre-fix code path and can be purged after a successful full repull.');
  }
  if (orderMismatches.length > 0) {
    recs.push('3. **Audit timestamp storage** — consider adding a raw `ghl_date_added` column to `ghl_messages` that stores the GHL-provided `dateAdded` separately from the Postgres `created_at` insert timestamp. Use `ghl_date_added` for sort order.');
  }
  if (contentMismatches.length > 0) {
    recs.push('4. **Review `messageText()` extraction** — run the content-mismatched conversations through a debug log to see which field GHL returned the message body in. The `body || message || content` chain may need adjustment for specific message types.');
  }
  if (directionMismatches.length > 0) {
    recs.push('5. **Verify direction field mapping** — check whether GHL is returning numeric direction codes on any endpoint version. The storage code normalises strings but not ints.');
  }
  if (skipped.filter(r => r.skip_reason?.includes('No ghl_conversations row')).length > 0) {
    recs.push('6. **Sync missing ghl_conversations rows** — some contacts have local Claude conversations but no matching `ghl_conversations` row. Trigger a GHL pull for those locations.');
  }
  if (recs.length === 0) {
    recs.push('1. No immediate action required. Re-run this audit after the next full repull to confirm accuracy holds.');
  }
  for (const r of recs) L.push(r);
  L.push('');
  L.push('---');
  L.push(`*Generated by \`GET /api/audit/ghl-history\` on ${auditDate}*`);

  return L.join('\n');
}

// ─── Route ────────────────────────────────────────────────────────────────────

router.get('/audit/ghl-history', async (req, res) => {
  const auditDate = '2026-05-05';
  logger.log('audit', 'info', null, 'GHL history audit started', { by: req.session?.username || 'api' });

  try {
    // 1. Last 50 contacts Claude responded to (has at least one outbound in messages table)
    const contactsRes = await db.query(
      `SELECT DISTINCT ON (c.contact_id, c.location_id)
              c.id AS conv_id,
              c.contact_id,
              c.location_id,
              c.first_name,
              c.last_name,
              c.phone,
              c.last_message_at,
              c.messages AS jsonb_messages,
              COALESCE(s.name, c.location_id) AS subaccount_name
       FROM conversations c
       LEFT JOIN subaccounts s ON s.ghl_location_id = c.location_id
       WHERE c.is_sandbox = FALSE
         AND EXISTS (
           SELECT 1 FROM messages m
            WHERE m.conversation_id = c.id AND m.direction = 'outbound'
         )
       ORDER BY c.contact_id, c.location_id, c.last_message_at DESC NULLS LAST`,
      []
    );

    const allContacts = contactsRes.rows;
    allContacts.sort((a, b) => {
      const at = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
      const bt = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
      return bt - at;
    });
    const contacts = allContacts.slice(0, AUDIT_LIMIT);

    logger.log('audit', 'info', null, `Auditing ${contacts.length} of ${allContacts.length} Claude-responded contacts`);

    const results = [];

    for (const contact of contacts) {
      const {
        contact_id, location_id, first_name, last_name,
        conv_id, jsonb_messages, subaccount_name
      } = contact;

      const result = {
        contact_id,
        location_id,
        subaccount_name,
        first_name,
        last_name,
        phone: contact.phone,
        last_message_at: contact.last_message_at,
        ghl_conv_id: null,
        stored_count: 0,
        live_count: null,
        jsonb_msg_count: Array.isArray(jsonb_messages) ? jsonb_messages.length : 0,
        token_found: false,
        ghl_api_ok: null,
        ghl_api_error: null,
        issues: [],
        jsonb_issues: null,
        skipped: false,
        skip_reason: null
      };

      // Find GHL conversation ID
      const ghlConvRes = await db.query(
        `SELECT ghl_conversation_id FROM ghl_conversations
         WHERE contact_id = $1 AND location_id = $2
         ORDER BY last_message_at DESC NULLS LAST LIMIT 1`,
        [contact_id, location_id]
      );
      const ghlConvId = ghlConvRes.rows[0]?.ghl_conversation_id || null;
      result.ghl_conv_id = ghlConvId;

      if (!ghlConvId) {
        result.skipped = true;
        result.skip_reason = 'No ghl_conversations row found — GHL pull has never run or conversation not yet synced';
        results.push(result);
        await sleep(20);
        continue;
      }

      // Get stored ghl_messages
      const storedRes = await db.query(
        `SELECT id, direction, content, message_type, created_at, ghl_message_id
         FROM ghl_messages
         WHERE ghl_conversation_id = $1 AND location_id = $2
         ORDER BY created_at ASC`,
        [ghlConvId, location_id]
      );
      const storedMsgs = storedRes.rows;
      result.stored_count = storedMsgs.length;

      // Get GHL token
      const token = await getGhlTokenForLocation(location_id);
      result.token_found = !!token;

      if (!token) {
        result.skipped = true;
        result.skip_reason = 'No GHL API token found for this location';
        results.push(result);
        await sleep(20);
        continue;
      }

      // Fetch live messages from GHL
      const liveResult = await fetchGhlMessages(token, ghlConvId);
      result.ghl_api_ok = liveResult.ok;
      result.ghl_api_error = liveResult.error;

      if (!liveResult.ok) {
        result.skipped = true;
        result.skip_reason = `GHL API call failed: ${liveResult.error}`;
        results.push(result);
        await sleep(SLEEP_MS);
        continue;
      }

      const liveMsgs = liveResult.messages;
      result.live_count = liveMsgs.length;

      // Diff
      result.issues = diffMessages(storedMsgs, liveMsgs);

      // JSONB check
      if (Array.isArray(jsonb_messages) && jsonb_messages.length > 0) {
        result.jsonb_issues = diffJsonb(jsonb_messages, liveMsgs);
      }

      results.push(result);
      await sleep(SLEEP_MS);
    }

    const report = buildReport(results, auditDate);

    const audited = results.filter(r => !r.skipped);
    const clean = audited.filter(r => r.issues.length === 0 && !r.jsonb_issues);
    logger.log('audit', 'info', null, 'GHL history audit complete', {
      total: results.length,
      audited: audited.length,
      clean: clean.length,
      mismatched: audited.length - clean.length,
      skipped: results.length - audited.length
    });

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ghl_history_audit_${auditDate}.md"`);
    res.send(report);
  } catch (err) {
    logger.log('audit', 'error', null, 'GHL history audit failed', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
