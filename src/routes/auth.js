const express = require('express');
const auth = require('../services/auth');
const logger = require('../services/logger');

const router = express.Router();

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }
  if (!auth.validateCredentials(username, password)) {
    logger.log('auth', 'warn', null, 'Login failed', { username });
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const { token, expiresAt } = auth.createSession(username);
  res.json({ ok: true, token, expires_at: expiresAt, username });
});

router.post('/logout', (req, res) => {
  const token = auth.extractToken(req);
  auth.invalidateSession(token);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const token = auth.extractToken(req);
  const session = auth.getSession(token);
  if (!session) return res.status(401).json({ error: 'unauthorized' });
  res.json({
    username: session.username,
    created_at: new Date(session.createdAt).toISOString(),
    last_seen_at: new Date(session.lastSeenAt).toISOString()
  });
});

module.exports = router;
