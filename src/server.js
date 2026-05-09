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
const jobsRouter = require('./routes/jobs');
const elevenlabsWebhookRouter = require('./routes/elevenlabsWebhook');
const elevenlabsApiRouter = require('./routes/elevenlabsApi');
const chiroBotRouter = require('./routes/chiroBot');
const chiroDemoChatRouter = require('./routes/chiroDemoChat');
const onboardingRouter = require('./routes/onboarding');
const epReviewRouter = require('./routes/epReview');
const notificationsRouter = require('./routes/notifications');
const auditRouter = require('./routes/audit');
const jarvisRouter = require('./routes/jarvis');
const conversationStore = require('./services/conversationStore');
const ghlConv = require('./services/ghlConversations');
const ghl = require('./services/ghl');
const logger = require('./services/logger');
const db = require('./db');
const { requireAuth } = require('./middleware/auth');
const authService = require('./services/auth');
const health = require('./services/health');

const app = express();

// Must mount BEFORE global express.json(): this router's POST handlers use
// express.raw() to preserve the exact bytes for HMAC verification. If the
// global JSON parser runs first it consumes the stream and HMAC fails.
app.use('/api/elevenlabs', elevenlabsWebhookRouter);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Webhook (GHL-facing) stays unauthenticated. /api/auth has public endpoints
// (login) and admin-only endpoints (users CRUD); those gate themselves inline.
app.use('/webhook', webhookRouter);
app.use('/api/auth', authRouter);
// Public client onboarding form — no auth required
app.use('/onboarding', onboardingRouter);
// Public chiro demo chat — used by ph-chiropractor Vercel site, no auth
app.use('/', chiroDemoChatRouter);

// Public audio playback for EP recording links in outreach emails.
// No auth required — ElevenLabs conversation IDs are long opaque strings.
app.get('/recording/:conversation_id', async (req, res) => {
  try {
    const store = require('./services/elevenlabsStore');
    const row = await store.getAudioBytes(req.params.conversation_id);
    if (!row || !row.audio_bytes) return res.status(404).send('Recording not found');
    res.setHeader('Content-Type', row.audio_mime || 'audio/mpeg');
    res.setHeader('Content-Length', row.audio_bytes.length);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.end(row.audio_bytes);
  } catch (err) {
    res.status(500).send('Error loading recording');
  }
});

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
app.use('/api', jobsRouter);
// Dashboard-facing ElevenLabs endpoints (list/detail/audio stream). Requires auth.
app.use('/api', elevenlabsApiRouter);
app.use('/api', chiroBotRouter);
app.use('/api', notificationsRouter);
app.use('/api', auditRouter);
app.use('/sandbox', sandboxRouter);
app.use('/cron', cronRoutes.router);

// EP voicemail review queue — redirect to login if no session
app.use('/', (req, res, next) => {
  if (!req.path.startsWith('/ep-review')) return next();
  const { extractToken, getSession } = require('./services/auth');
  const token = extractToken(req);
  const session = token && getSession(token);
  if (!session) return res.redirect('/?redirect=' + encodeURIComponent(req.originalUrl));
  req.session = session;
  next();
}, epReviewRouter);

// JARVIS � Walt's private AI assistant interface
app.use('/', jarvisRouter);

// JARVIS � Walt's private AI assistant interface
app.use('/', jarvisRouter);

// Static dashboard served last; login page is also static.
app.use('/', express.static(path.join(__dirname, '..', 'public')));

app.use((err, req, res, next) => {
  console.error('[server] unhandled', err);
  res.status(500).json({ error: 'internal error' });
});

const port = parseInt(process.env.PORT, 10) || 3000;
app.listen(port, () => {
  console.log(`[server] listening on :${port}`);
  // Auto-apply migrations on every boot (idempotent). Railway runs `npm start`
  // only, so without this the new tables (anthropic_usage_log, word_track_clusters)
  // never get created in prod — which is why Bug 2 happened.
  const { applyMigrations } = require('./db/migrate');
  applyMigrations()
    .then(() => console.log('[server] migrations applied on boot'))
    .catch((err) => {
      console.error('[server] MIGRATION FAILED ON BOOT:', err.message);
      logger.log('server', 'error', null, 'boot migration failed', { error: err.message, stack: err.stack });
    });
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

// Daily full GHL repull at 7am America/New_York (handles EST/EDT automatically).
// Same effect as clicking "Full Repull" in the QC portal. Writes
// last_full_repull_at to app_settings so the freshness indicator stays green.
// Runs every hour and fires when the ET clock reads 7:xx — deduped by ET date.
let lastDailyRepullKey = null;
let dailyRepullRunning = false;
setInterval(async () => {
  try {
    const now = new Date();
    const etHour = parseInt(
      new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(now),
      10
    );
    if (etHour !== 7) return;
    const etDate = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(now);
    if (lastDailyRepullKey === etDate) return;
    if (dailyRepullRunning) return;
    lastDailyRepullKey = etDate;
    dailyRepullRunning = true;
    logger.log('daily_repull', 'info', null, 'Daily full GHL repull starting', { etDate });
    try {
      const [convLocs, subLocs] = await Promise.all([
        db.query(`SELECT DISTINCT location_id FROM conversations WHERE ghl_token IS NOT NULL AND ghl_token <> '' AND is_sandbox = FALSE`),
        db.query(`SELECT DISTINCT ghl_location_id AS location_id FROM subaccounts WHERE ghl_api_key IS NOT NULL AND ghl_api_key <> ''`)
      ]);
      const seen = new Set();
      const locationIds = [];
      for (const r of [...convLocs.rows, ...subLocs.rows]) {
        if (!seen.has(r.location_id)) { seen.add(r.location_id); locationIds.push(r.location_id); }
      }
      let totalConvs = 0;
      let errors = 0;
      for (const locationId of locationIds) {
        try {
          const fromSub = await db.query(
            `SELECT ghl_api_key FROM subaccounts WHERE ghl_location_id = $1 AND ghl_api_key IS NOT NULL AND ghl_api_key <> '' LIMIT 1`,
            [locationId]
          );
          const token = fromSub.rows[0]?.ghl_api_key ||
            (await db.query(`SELECT ghl_token FROM conversations WHERE location_id = $1 AND ghl_token IS NOT NULL AND ghl_token <> '' ORDER BY updated_at DESC LIMIT 1`, [locationId])).rows[0]?.ghl_token;
          if (!token) continue;
          const result = await ghlConv.pullAndStore(token, locationId, null, { fullRepull: true });
          totalConvs += result.total_conversations || 0;
        } catch (err) {
          errors++;
          logger.log('daily_repull', 'error', null, 'Location repull failed', { locationId, error: err.message });
        }
      }
      await db.query(
        `INSERT INTO app_settings (section, key, value) VALUES ('ghl_sync', 'last_full_repull_at', $1)
         ON CONFLICT (section, key) DO UPDATE SET value = EXCLUDED.value`,
        [new Date().toISOString()]
      );
      logger.log('daily_repull', 'info', null, 'Daily full GHL repull complete', { locations: locationIds.length, totalConvs, errors, etDate });

      // Repull wipes cluster_id on every ghl_messages row (DELETE + INSERT).
      // Run the full clustering pipeline immediately after so WordTracks reply
      // rates stay accurate. Fire-and-forget — repull already responded/logged.
      const wtClusters = require('./services/wordTrackClusters');
      wtClusters.runFullPipeline().then((result) => {
        logger.log('daily_repull', 'info', null, 'Post-repull recluster complete', result);
      }).catch((err) => {
        logger.log('daily_repull', 'error', null, 'Post-repull recluster failed', { error: err.message });
      });
    } finally {
      dailyRepullRunning = false;
    }
  } catch (err) {
    dailyRepullRunning = false;
    logger.log('daily_repull', 'error', null, 'Daily repull cron error', { error: err.message });
  }
}, 60 * 60 * 1000);

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
