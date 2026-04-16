require('dotenv').config();
const express = require('express');
const path = require('path');

const webhookRouter = require('./routes/webhook');
const analyticsRouter = require('./routes/analytics');
const sandboxRouter = require('./routes/sandbox');
const logsRouter = require('./routes/logs');
const dashboardRouter = require('./routes/dashboard');
const wordtracksRouter = require('./routes/wordtracks');
const pipelineRouter = require('./routes/pipeline');
const qcRouter = require('./routes/qc');
const reviewQueueRouter = require('./routes/reviewQueue');
const subaccountsRouter = require('./routes/subaccounts');
const settingsRouter = require('./routes/settings');
const analyzerRouter = require('./routes/analyzer');
const testSyncRouter = require('./routes/testSync');
const authRouter = require('./routes/auth');
const devConsoleRouter = require('./routes/devConsole');
const healthRouter = require('./routes/health');
const pendingChangesRouter = require('./routes/pendingChanges');
const kbRouter = require('./routes/kb');
const weeklySummaryModule = require('./routes/weeklySummary');
const weeklySummaryRouter = weeklySummaryModule.router;
const cronRoutes = require('./routes/cron');
const conversationStore = require('./services/conversationStore');
const ghl = require('./services/ghl');
const logger = require('./services/logger');
const db = require('./db');
const { requireAuth } = require('./middleware/auth');
const authService = require('./services/auth');
const health = require('./services/health');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Webhook (GHL-facing) stays unauthenticated. /api/auth has public endpoints
// (login) and admin-only endpoints (users CRUD); those gate themselves inline.
app.use('/webhook', webhookRouter);
app.use('/api/auth', authRouter);

// Everything else under /api/*, /sandbox/*, /cron/* requires a valid session token.
app.use('/api', requireAuth);
app.use('/sandbox', requireAuth);
app.use('/cron', requireAuth);

// Role guard: viewers are read-only on mutating admin endpoints.
app.use((req, res, next) => {
  if (!req.session) return next();
  if (req.session.role === 'admin') return next();
  const p = req.path || '';
  const m = req.method || 'GET';
  const isMut = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(m);
  const blockedPrefixes = [
    { prefix: '/api/dev', any: true },
    { prefix: '/api/admin', any: true },
    { prefix: '/api/test-sync', any: true },
    { prefix: '/api/analyzer/prompt', mut: true },
    { prefix: '/api/analyzer/generate-prompt', mut: true },
    { prefix: '/api/analyzer/apply-changes', any: true },
    { prefix: '/api/settings', mut: true },
    { prefix: '/api/subaccounts', mut: true },
    { prefix: '/api/kb', mut: true },
    { prefix: '/api/pending-changes', mut: true },
    { prefix: '/api/auth/users', mut: true }
  ];
  for (const b of blockedPrefixes) {
    if (p.startsWith(b.prefix)) {
      if (b.any || (b.mut && isMut)) {
        return res.status(403).json({ error: 'admin role required' });
      }
    }
  }
  next();
});

app.use('/api', analyticsRouter);
app.use('/api', logsRouter);
app.use('/api', dashboardRouter);
app.use('/api', wordtracksRouter);
app.use('/api', pipelineRouter);
app.use('/api', qcRouter);
app.use('/api', reviewQueueRouter);
app.use('/api', subaccountsRouter);
app.use('/api', settingsRouter);
app.use('/api/analyzer', analyzerRouter);
app.use('/api/dev', devConsoleRouter);
app.use('/api', healthRouter);
app.use('/api', pendingChangesRouter);
app.use('/api', kbRouter);
app.use('/api', weeklySummaryRouter);
app.use('/api', testSyncRouter);
app.use('/sandbox', sandboxRouter);
app.use('/cron', cronRoutes.router);

// Static dashboard served last; login page is also static.
app.use('/', express.static(path.join(__dirname, '..', 'public')));

app.use((err, req, res, next) => {
  console.error('[server] unhandled', err);
  res.status(500).json({ error: 'internal error' });
});

const port = parseInt(process.env.PORT, 10) || 3000;
app.listen(port, () => {
  console.log(`[server] listening on :${port}`);
  // Seed default users if not already present (idempotent).
  authService.seedUsersIfMissing().catch((err) => {
    logger.log('auth', 'error', null, 'User seeding failed at startup', { error: err.message });
  });
  // Start system health check loop (runs every 60s).
  health.startHealthLoop();
});

// Background GHL field sync — catches stale dirty rows that never hit a terminal outcome.
// Runs hourly, pulls up to 100 conversations dirty for >72h, paces 200ms between PUTs.
const FIELD_SYNC_INTERVAL_MS = 60 * 60 * 1000;
const FIELD_SYNC_BATCH_LIMIT = 100;
const FIELD_SYNC_STALE_HOURS = 72;
const FIELD_SYNC_PER_CALL_DELAY_MS = 200;

// Monday 8am auto-generate weekly summaries for all active subaccounts.
// Runs every hour and fires when Monday UTC 8:00-8:59 is hit.
let lastWeeklyRunKey = null;
setInterval(async () => {
  try {
    const now = new Date();
    if (now.getUTCDay() !== 1 || now.getUTCHours() !== 8) return;
    const key = now.toISOString().slice(0, 10);
    if (lastWeeklyRunKey === key) return;
    lastWeeklyRunKey = key;
    const subs = await db.query(`SELECT ghl_location_id FROM subaccounts WHERE status = 'active' OR status IS NULL`);
    const weekStart = weeklySummaryModule.startOfWeek(new Date(now.getTime() - 7 * 86400000));
    const weekEnd = new Date(weekStart.getTime() + 7 * 86400000);
    for (const s of subs.rows) {
      try {
        await weeklySummaryModule.generateAndStore(s.ghl_location_id, weekStart, weekEnd);
      } catch (err) {
        logger.log('weekly', 'error', null, 'Auto weekly failed', { location_id: s.ghl_location_id, error: err.message });
      }
    }
    logger.log('weekly', 'info', null, 'Monday auto-generation completed', { count: subs.rows.length });
  } catch (err) {
    logger.log('weekly', 'error', null, 'Weekly cron failed', { error: err.message });
  }
}, 60 * 60 * 1000);

// Daily cleanup of expired GHL data (pulled conversations older than 90 days)
const GHL_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
setInterval(async () => {
  try {
    const msgDel = await db.query(`DELETE FROM ghl_messages WHERE (ghl_conversation_id, location_id) IN (SELECT ghl_conversation_id, location_id FROM ghl_conversations WHERE expires_at < NOW())`);
    const convDel = await db.query(`DELETE FROM ghl_conversations WHERE expires_at < NOW()`);
    const healthDel = await db.query(`DELETE FROM system_health_log WHERE checked_at < NOW() - INTERVAL '30 days'`);
    logger.log('cleanup', 'info', null, 'Daily cleanup completed', {
      ghl_messages: msgDel.rowCount || 0,
      ghl_conversations: convDel.rowCount || 0,
      health_log_rows: healthDel.rowCount || 0
    });
  } catch (err) {
    logger.log('cleanup', 'error', null, 'GHL cleanup failed', { error: err.message });
  }
}, GHL_CLEANUP_INTERVAL_MS);

setInterval(async () => {
  try {
    const dirty = await conversationStore.getDirtyConversations(FIELD_SYNC_STALE_HOURS);
    const batch = dirty.slice(0, FIELD_SYNC_BATCH_LIMIT);
    if (!batch.length) return;
    for (const conv of batch) {
      try {
        const res = await ghl.updateContactFields(conv.ghl_token, conv.contact_id, conv, conv.contact_id);
        if (res.ok) await conversationStore.markSynced(conv.id);
      } catch (err) {
        logger.log('field_sync', 'error', conv.contact_id, 'Background sync threw', { error: err.message });
      }
      await new Promise((r) => setTimeout(r, FIELD_SYNC_PER_CALL_DELAY_MS));
    }
    logger.log('field_sync', 'info', null, `Background sync batch complete: ${batch.length} contacts`, { batch_size: batch.length });
  } catch (err) {
    logger.log('field_sync', 'error', null, 'Background sync job failed', { error: err.message, stack: err.stack });
  }
}, FIELD_SYNC_INTERVAL_MS);
