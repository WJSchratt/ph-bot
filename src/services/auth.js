const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const logger = require('./logger');
const db = require('../db');

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const BCRYPT_ROUNDS = 10;

const sessions = new Map();

const SEED_USERS = [
  { username: 'ProfitAdmin', password: 'Money2026!', email: null, role: 'admin' },
  { username: 'Llew', password: 'PH_Llew2026!', email: null, role: 'admin' },
  { username: 'Kev', password: 'PH_Kev2026!', email: null, role: 'viewer' },
  { username: 'Joe', password: 'PH_Joe2026!', email: null, role: 'viewer' },
  { username: 'Walt', password: 'PH_Walt2026!', email: null, role: 'admin' }
];

function getEnvSuperAdmin() {
  return {
    username: process.env.ADMIN_USERNAME || '',
    password: process.env.ADMIN_PASSWORD || ''
  };
}

async function seedUsersIfMissing() {
  for (const u of SEED_USERS) {
    try {
      const existing = await db.query(`SELECT id FROM users WHERE username = $1`, [u.username]);
      if (existing.rows[0]) continue;
      const hash = await bcrypt.hash(u.password, BCRYPT_ROUNDS);
      await db.query(
        `INSERT INTO users (username, password_hash, email, role) VALUES ($1, $2, $3, $4)`,
        [u.username, hash, u.email, u.role]
      );
      logger.log('auth', 'info', null, 'Seeded user', { username: u.username, role: u.role });
    } catch (err) {
      logger.log('auth', 'error', null, 'Seed user failed', { username: u.username, error: err.message });
    }
  }
}

async function validateCredentials(username, password) {
  if (!username || !password) return null;

  // DB-backed user first
  try {
    const q = await db.query(
      `SELECT id, username, password_hash, email, role FROM users WHERE username = $1`,
      [username]
    );
    const row = q.rows[0];
    if (row) {
      const ok = await bcrypt.compare(password, row.password_hash);
      if (ok) {
        await db.query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [row.id]);
        return { username: row.username, role: row.role || 'admin', email: row.email, id: row.id };
      }
    }
  } catch (err) {
    logger.log('auth', 'error', null, 'DB user lookup failed', { username, error: err.message });
  }

  // Env fallback superadmin (always admin role)
  const env = getEnvSuperAdmin();
  if (env.username && env.password && username === env.username && password === env.password) {
    return { username: env.username, role: 'admin', email: null, id: null };
  }

  return null;
}

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  const record = {
    username: user.username,
    role: user.role || 'admin',
    email: user.email || null,
    userId: user.id || null,
    createdAt: Date.now(),
    lastSeenAt: Date.now()
  };
  sessions.set(token, record);
  logger.log('auth', 'info', null, 'Session created', {
    username: user.username, role: record.role, token_preview: token.slice(0, 8) + '...'
  });
  return { token, expiresAt: record.createdAt + SESSION_TTL_MS, role: record.role };
}

function invalidateSession(token) {
  if (!token) return false;
  return sessions.delete(token);
}

function getSession(token) {
  if (!token) return null;
  const record = sessions.get(token);
  if (!record) return null;
  if (Date.now() - record.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return null;
  }
  record.lastSeenAt = Date.now();
  return record;
}

function listSessions() {
  return Array.from(sessions.entries()).map(([token, rec]) => ({
    token_preview: token.slice(0, 8) + '...',
    username: rec.username,
    role: rec.role,
    created_at: new Date(rec.createdAt).toISOString(),
    last_seen_at: new Date(rec.lastSeenAt).toISOString(),
    expires_at: new Date(rec.createdAt + SESSION_TTL_MS).toISOString()
  }));
}

function extractToken(req) {
  const header = req.headers?.authorization || req.headers?.Authorization;
  if (header && typeof header === 'string') {
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1].trim();
  }
  const q = req.query?.token;
  if (q && typeof q === 'string') return q.trim();
  return null;
}

async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

module.exports = {
  SESSION_TTL_MS,
  SEED_USERS,
  seedUsersIfMissing,
  validateCredentials,
  createSession,
  invalidateSession,
  getSession,
  listSessions,
  extractToken,
  hashPassword
};
