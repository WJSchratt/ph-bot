require('dotenv').config();
const express = require('express');
const path = require('path');

const webhookRouter = require('./routes/webhook');
const analyticsRouter = require('./routes/analytics');
const sandboxRouter = require('./routes/sandbox');
const logsRouter = require('./routes/logs');
const cronRoutes = require('./routes/cron');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.use('/webhook', webhookRouter);
app.use('/api', analyticsRouter);
app.use('/api', logsRouter);
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
