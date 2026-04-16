const crypto = require('crypto');
const logger = require('./logger');

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const sessions = new Map();

function getAdminCreds() {
  return {
    username: process.env.ADMIN_USERNAME || 'ProfitAdmin',
    password: process.env.ADMIN_PASSWORD || 'Money2026!'
  };
}

function timingSafeStringEquals(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function validateCredentials(username, password) {
  const creds = getAdminCreds();
  return timingSafeStringEquals(username, creds.username) && timingSafeStringEquals(password, creds.password);
}

function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  const record = { username, createdAt: Date.now(), lastSeenAt: Date.now() };
  sessions.set(token, record);
  logger.log('auth', 'info', null, 'Session created', { username, token_preview: token.slice(0, 8) + '...' });
  return { token, expiresAt: record.createdAt + SESSION_TTL_MS };
}

function invalidateSession(token) {
  if (!token) return false;
  const existed = sessions.delete(token);
  if (existed) logger.log('auth', 'info', null, 'Session invalidated', { token_preview: token.slice(0, 8) + '...' });
  return existed;
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

module.exports = {
  SESSION_TTL_MS,
  validateCredentials,
  createSession,
  invalidateSession,
  getSession,
  listSessions,
  extractToken,
  getAdminCreds
};
