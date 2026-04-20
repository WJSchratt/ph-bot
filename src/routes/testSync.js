const express = require('express');
const store = require('../services/conversationStore');
const ghl = require('../services/ghl');
const ghlPipeline = require('../services/ghlPipeline');
const logger = require('../services/logger');
const db = require('../db');

const router = express.Router();

async function findGhlTokenForLocation(locationId) {
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

// Test hook: trigger routeOpportunity for a contact without running a full
// conversation. Defaults to dryRun=true so accidental hits don't mutate GHL.
// Body: { contactId, locationId, outcome, ghlToken?, dryRun? }
router.post('/test/route-opportunity', async (req, res) => {
  try {
    const { contactId, locationId, outcome } = req.body || {};
    const dryRun = req.body?.dryRun !== false;
    if (!contactId || !locationId || !outcome) {
      return res.status(400).json({ error: 'contactId, locationId, outcome required' });
    }
    let token = req.body?.ghlToken || null;
    if (!token) token = await findGhlTokenForLocation(locationId);
    if (!token) return res.status(400).json({ error: 'No GHL token found for this location' });

    const result = await ghlPipeline.routeOpportunity(token, locationId, contactId, outcome, { dryRun });
    res.json(result);
  } catch (err) {
    logger.log('pipeline_route', 'error', req.body?.contactId || null, 'test/route-opportunity threw', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Manual field-sync trigger for verification. Open endpoint — guard later if left in prod.
router.post('/test-sync/:contactId/:locationId', async (req, res) => {
  try {
    const { contactId, locationId } = req.params;
    const conv = await store.getByContactAndLocation(contactId, locationId);
    if (!conv) return res.status(404).json({ error: 'conversation not found' });
    if (!conv.ghl_token) return res.status(400).json({ error: 'no ghl_token on conversation' });

    const result = await ghl.updateContactFields(conv.ghl_token, conv.contact_id, conv, contactId);
    if (result.ok && !result.skipped) {
      await store.markSynced(conv.id);
    }
    res.json({
      ok: result.ok,
      skipped: !!result.skipped,
      status: result.status,
      fields_count: result.fields_count || 0,
      fields: result.fields || [],
      error: result.error || null
    });
  } catch (err) {
    logger.log('field_sync', 'error', req.params.contactId, 'test-sync threw', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Admin: wipe a conversation (delete row + cascaded messages), clear GHL DND + DNC tags.
// Next inbound message from this contact will start a fresh conversation.
router.post('/admin/wipe-conversation/:contactId/:locationId', async (req, res) => {
  const { contactId, locationId } = req.params;
  const result = { contactId, locationId, deleted: false, ghl: { dnd_cleared: false, tags_removed: false } };
  try {
    const conv = await store.getByContactAndLocation(contactId, locationId);

    if (conv?.ghl_token) {
      const dndRes = await ghl.clearContactDnd(conv.ghl_token, contactId, contactId);
      result.ghl.dnd_cleared = !!dndRes.ok;
      result.ghl.dnd_status = dndRes.status || null;
      result.ghl.dnd_error = dndRes.error || null;

      const tagRes = await ghl.removeContactTags(conv.ghl_token, contactId, ['DNC', 'sms-opt-out'], contactId);
      result.ghl.tags_removed = !!tagRes.ok;
      result.ghl.tags_status = tagRes.status || null;
      result.ghl.tags_error = tagRes.error || null;
    } else {
      result.ghl.skipped = 'no ghl_token on conversation';
    }

    if (conv) {
      const msgCountQ = await db.query(`SELECT COUNT(*)::int AS c FROM messages WHERE conversation_id = $1`, [conv.id]);
      const msgCount = msgCountQ.rows[0]?.c || 0;
      const del = await db.query(
        `DELETE FROM conversations WHERE contact_id = $1 AND location_id = $2 RETURNING id`,
        [contactId, locationId]
      );
      result.deleted = del.rowCount > 0;
      result.conversation_id = del.rows[0]?.id || null;
      result.messages_deleted = msgCount;
      logger.log('admin', 'info', contactId, 'Conversation wiped', {
        conversation_id: result.conversation_id,
        messages_deleted: msgCount,
        ghl: result.ghl
      });
    } else {
      result.deleted = false;
      result.note = 'no conversation row found';
    }

    res.json({ ok: true, ...result });
  } catch (err) {
    logger.log('admin', 'error', contactId, 'wipe-conversation threw', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message, stack: err.stack, partial: result });
  }
});

module.exports = router;
