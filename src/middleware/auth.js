const crypto = require('crypto');
const { extractToken, getSession } = require('../services/auth');

// Constant-time comparison so we don't leak the admin key via timing.
function timingSafeEqual(a, b) {
  if (!a || !b) return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// ADMIN_API_KEY: a long-lived service-account bearer token. Set via Railway
// env var. Accepted on any endpoint gated by requireAuth. Bypasses session
// expiry so headless clients (tests, CI, assistants) can hit the API without
// logging in every 24h. Dashboard UI still uses regular JWT sessions.
function matchesAdminApiKey(req) {
  const key = process.env.ADMIN_API_KEY;
  if (!key) return false;
  const token = extractToken(req);
  if (!token) return false;
  return timingSafeEqual(token, key);
}

function requireAuth(req, res, next) {
  const token = extractToken(req);

  // Service-account path: ADMIN_API_KEY bearer → synthetic admin session.
  if (matchesAdminApiKey(req)) {
    req.session = {
      username: 'admin_api_key',
      role: 'admin',
      email: null,
      userId: null,
      serviceAccount: true
    };
    req.sessionToken = token;
    return next();
  }

  const session = getSession(token);
  if (!session) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  req.session = session;
  req.sessionToken = token;
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session) return res.status(401).json({ error: 'unauthorized' });
    if (role === 'admin' && req.session.role !== 'admin') {
      return res.status(403).json({ error: 'admin role required' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
