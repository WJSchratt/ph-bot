const { extractToken, getSession } = require('../services/auth');

function requireAuth(req, res, next) {
  const token = extractToken(req);
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
