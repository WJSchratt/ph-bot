const express = require('express');
const db = require('../db');
const router = express.Router();

// GET /api/notifications
// Returns actionable items only — new onboarding submissions + system errors.
// Intentionally not noisy: only surfaces things that need a human decision.
router.get('/notifications', async (req, res) => {
  try {
    const notifications = [];

    // ── Onboarding submissions (last 30 days) ──────────────────────────────
    const obResult = await db.query(`
      SELECT id, submission_id, status, form_data, ghl_location_id,
             elevenlabs_agent_en, elevenlabs_agent_es,
             error_log, completed_steps, created_at, updated_at
      FROM onboarding_submissions
      WHERE created_at > NOW() - INTERVAL '30 days'
      ORDER BY created_at DESC
      LIMIT 50
    `);

    for (const row of obResult.rows) {
      const fd = row.form_data || {};
      const businessName = fd.business_name || 'Unknown Client';
      const agentName = fd.agent_first_name || '';
      const vertical = fd.vertical || 'unknown';
      const errors = row.error_log || [];
      const steps = row.completed_steps || [];

      let title, description, severity;

      if (row.status === 'processing') {
        const ageMin = Math.round((Date.now() - new Date(row.created_at)) / 60000);
        if (ageMin > 5) {
          title = `Onboarding stuck: ${businessName}`;
          description = `Processing for ${ageMin} min — may need manual check`;
          severity = 'warn';
        } else {
          continue; // still in flight, skip
        }
      } else if (row.status === 'partial') {
        const failedSteps = errors.map((e) => e.step).join(', ');
        title = `Onboarding partial: ${businessName}`;
        description = `Some steps failed (${failedSteps || 'see details'}). Manual follow-up needed.`;
        severity = 'warn';
      } else if (row.status === 'complete') {
        title = `New client onboarded: ${businessName}`;
        description = `${agentName} · ${vertical} · GHL: ${row.ghl_location_id || 'pending'} · EL: ${row.elevenlabs_agent_en || 'pending'}. Schedule onboarding call.`;
        severity = 'info';
      } else if (row.status === 'pending') {
        title = `Onboarding submitted: ${businessName}`;
        description = `Form received, processing not yet started`;
        severity = 'info';
      } else {
        continue;
      }

      notifications.push({
        id: `onboarding-${row.id}`,
        type: 'onboarding',
        severity,
        title,
        description,
        meta: {
          submission_id: row.submission_id,
          ghl_location_id: row.ghl_location_id,
          elevenlabs_agent_en: row.elevenlabs_agent_en,
          status: row.status,
          completed_steps: steps.flat(),
        },
        ts: row.created_at,
      });
    }

    // ── System health errors (last 24h, deduplicated by component) ─────────
    const healthResult = await db.query(`
      SELECT DISTINCT ON (component)
        component, status, error_message, checked_at
      FROM system_health_log
      WHERE status = 'error'
        AND checked_at > NOW() - INTERVAL '24 hours'
      ORDER BY component, checked_at DESC
    `);

    for (const row of healthResult.rows) {
      notifications.push({
        id: `health-${row.component}-${new Date(row.checked_at).getTime()}`,
        type: 'system',
        severity: 'error',
        title: `System error: ${row.component}`,
        description: row.error_message || 'Check logs for details',
        meta: { component: row.component },
        ts: row.checked_at,
      });
    }

    // Sort: errors first, then by newest
    notifications.sort((a, b) => {
      const sevOrder = { error: 0, warn: 1, info: 2 };
      if (sevOrder[a.severity] !== sevOrder[b.severity]) return sevOrder[a.severity] - sevOrder[b.severity];
      return new Date(b.ts) - new Date(a.ts);
    });

    const unread = notifications.filter((n) => n.severity !== 'info').length
      + notifications.filter((n) => n.type === 'onboarding' && n.severity === 'info' && new Date(n.ts) > new Date(Date.now() - 24 * 60 * 60 * 1000)).length;

    res.json({ ok: true, notifications, unread });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
