// auth.js - session-token authentication and department-role checks.
//
// How it works: on login we make a random token, save it in the "sessions" table
// against the user, and hand the token to the browser. Every later request sends
// that token back in an "Authorization: Bearer <token>" header; requireAuth looks
// it up, and attaches the logged-in user to req.user for the route to use.

const crypto = require('crypto');
const { pool } = require('./database');
const { fail } = require('./utils');
const { CATALOG } = require('./permissions');

const VALID_KEYS = new Set(CATALOG.map(c => c.key));

const SESSION_HOURS = 12; // a login stays valid for 12 hours of inactivity-free use

/** Makes a new random session token and stores it for this user. Returns the token. */
async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600 * 1000);
  await pool.query('INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)',
    [token, userId, expiresAt]);
  return token;
}

/** Express middleware: rejects the request unless it carries a valid, unexpired session token. */
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return fail(res, 401, 'Not logged in');
  try {
    const r = await pool.query(
      `SELECT u.id, u.username, u.name, u.role, u.branch, u.active, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = $1`, [token]);
    if (r.rowCount === 0) return fail(res, 401, 'Session not found - please log in again');
    const row = r.rows[0];
    if (new Date(row.expires_at) < new Date()) {
      await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
      return fail(res, 401, 'Session expired - please log in again');
    }
    if (!row.active) return fail(res, 403, 'This account has been disabled');
    req.user = { id: row.id, username: row.username, name: row.name, role: row.role, branch: row.branch };
    next();
  } catch (err) {
    console.error('Auth check failed:', err);
    fail(res, 500, 'Could not verify login');
  }
}

/**
 * Express middleware factory: requireRole('purchase','admin') only lets those
 * roles through. 'admin' can always do everything, so callers don't need to list it.
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return fail(res, 401, 'Not logged in');
    if (req.user.role === 'admin' || roles.includes(req.user.role)) return next();
    fail(res, 403, `Your role ("${req.user.role}") is not allowed to do this`);
  };
}

/**
 * Express middleware factory: requirePermission(KEYS.PO_CREATE) checks the DATABASE
 * (role_permissions table) instead of a hardcoded list, so admin can change who's
 * allowed to do this from the Permissions page without touching code. 'admin' always
 * passes, same as requireRole. Unlike requireRole, the key must exist in permissions.js's
 * CATALOG - passing a typo'd or made-up key throws IMMEDIATELY at server startup (when the
 * route is registered), not silently at request time, so a mistyped key can never turn
 * into a silent security hole.
 */
function requirePermission(key) {
  if (!VALID_KEYS.has(key)) {
    throw new Error(`requirePermission("${key}") is not in permissions.js's CATALOG - fix the route file.`);
  }
  return async (req, res, next) => {
    if (!req.user) return fail(res, 401, 'Not logged in');
    if (req.user.role === 'admin') return next();
    try {
      const r = await pool.query(
        'SELECT 1 FROM role_permissions WHERE role = $1 AND permission_key = $2', [req.user.role, key]);
      if (r.rowCount > 0) return next();
      fail(res, 403, `Your role ("${req.user.role}") is not allowed to do this`);
    } catch (err) {
      console.error('Permission check failed:', err);
      fail(res, 500, 'Could not verify permission');
    }
  };
}

module.exports = { createSession, requireAuth, requireRole, requirePermission, SESSION_HOURS };
