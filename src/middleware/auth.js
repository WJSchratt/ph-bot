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

module.exports = { requireAuth };
