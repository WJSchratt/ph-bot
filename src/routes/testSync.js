const express = require('express');
const store = require('../services/conversationStore');
const ghl = require('../services/ghl');
const logger = require('../services/logger');

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

module.exports = router;
