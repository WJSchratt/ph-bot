const express = require('express');
const store = require('../services/conversationStore');
const ghl = require('../services/ghl');
const logger = require('../services/logger');
const db = require('../db');

const router = express.Router();

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
