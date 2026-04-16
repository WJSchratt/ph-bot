const express = require('express');
const auth = require('../services/auth');
const db = require('../db');
const logger = require('../services/logger');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }
  const user = await auth.validateCredentials(username, password);
  if (!user) {
    logger.log('auth', 'warn', null, 'Login failed', { username });
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const { token, expiresAt, role } = auth.createSession(user);
  res.json({
    ok: true,
    token,
    expires_at: expiresAt,
    username: user.username,
    role
  });
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
    role: session.role,
    email: session.email,
    created_at: new Date(session.createdAt).toISOString(),
    last_seen_at: new Date(session.lastSeenAt).toISOString()
  });
});

// --- User Management (admin only) ---

router.get('/users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const q = await db.query(
      `SELECT id, username, email, role, created_at, last_login_at FROM users ORDER BY username`
    );
    res.json({ users: q.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { username, password, email, role } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    if (role && !['admin', 'viewer'].includes(role)) return res.status(400).json({ error: 'role must be admin or viewer' });
    const hash = await auth.hashPassword(password);
    const q = await db.query(
      `INSERT INTO users (username, password_hash, email, role) VALUES ($1, $2, $3, $4)
       RETURNING id, username, email, role, created_at`,
      [username, hash, email || null, role || 'viewer']
    );
    logger.log('auth', 'info', null, 'User created', { by: req.session.username, username, role: role || 'viewer' });
    res.json({ ok: true, user: q.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'username already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { password, email, role } = req.body || {};
    const sets = [];
    const params = [];
    if (password) {
      params.push(await auth.hashPassword(password));
      sets.push(`password_hash = $${params.length}`);
    }
    if (email !== undefined) { params.push(email || null); sets.push(`email = $${params.length}`); }
    if (role !== undefined) {
      if (!['admin', 'viewer'].includes(role)) return res.status(400).json({ error: 'role must be admin or viewer' });
      params.push(role); sets.push(`role = $${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'no fields to update' });
    params.push(id);
    const q = await db.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id, username, email, role`,
      params
    );
    if (!q.rows[0]) return res.status(404).json({ error: 'user not found' });
    logger.log('auth', 'info', null, 'User updated', { by: req.session.username, user_id: id });
    res.json({ ok: true, user: q.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const q = await db.query(`DELETE FROM users WHERE id = $1 RETURNING username`, [id]);
    if (!q.rows[0]) return res.status(404).json({ error: 'user not found' });
    if (q.rows[0].username === req.session.username) {
      return res.status(400).json({ error: 'cannot delete your own account' });
    }
    logger.log('auth', 'info', null, 'User deleted', { by: req.session.username, username: q.rows[0].username });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
