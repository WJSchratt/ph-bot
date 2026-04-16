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
const cronRoutes = require('./routes/cron');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.use('/webhook', webhookRouter);
app.use('/api', analyticsRouter);
app.use('/api', logsRouter);
app.use('/api', dashboardRouter);
app.use('/api', wordtracksRouter);
app.use('/api', pipelineRouter);
app.use('/api', qcRouter);
app.use('/api', reviewQueueRouter);
app.use('/api', subaccountsRouter);
app.use('/api', settingsRouter);
app.use('/sandbox', sandboxRouter);
app.use('/cron', cronRoutes.router);

app.use('/', express.static(path.join(__dirname, '..', 'public')));

app.use((err, req, res, next) => {
  console.error('[server] unhandled', err);
  res.status(500).json({ error: 'internal error' });
});

const port = parseInt(process.env.PORT, 10) || 3000;
app.listen(port, () => {
  console.log(`[server] listening on :${port}`);
});
