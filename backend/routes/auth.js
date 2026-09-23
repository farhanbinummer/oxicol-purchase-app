// routes/auth.js - login/logout and admin-only user management.
//   POST /api/auth/login             { username, password } -> token + user
//   POST /api/auth/logout            (requires login)
//   GET  /api/auth/me                who am I logged in as
//   POST /api/auth/change-password   { current_password, new_password }
//   GET    /api/auth/users             admin only: list accounts
//   POST   /api/auth/users             admin only: create an account
//   PUT    /api/auth/users/:id         admin only: rename username and/or display name
//   PUT    /api/auth/users/:id/active  admin only: enable/disable an account
//   PUT    /api/auth/users/:id/password admin only: reset a user's password (forgotten password)
//   DELETE /api/auth/users/:id         admin only: delete an account with no history yet
//   GET    /api/auth/role-permissions  admin only: the full editable permission matrix
//   PUT    /api/auth/role-permissions  admin only: grant/revoke one role's access to one action
//
// role-permissions is ALWAYS requireRole('admin'), never requirePermission() - if editing the
// matrix were itself something the matrix could grant away, a bad edit (or a compromised
// non-admin account) could grant itself admin-equivalent power. Same reasoning for /users above.

const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../database');
const { fail } = require('../utils');
const { createSession, requireAuth, requireRole } = require('../auth');
const { CATALOG } = require('../permissions');
const router = express.Router();

const PERMISSION_ROLES = ['branch', 'production', 'store', 'purchase', 'accounts']; // admin is never stored - it always passes

const ROLES = ['branch', 'production', 'store', 'purchase', 'accounts', 'admin'];
const BRANCHES = ['Kannur', 'Thrissur', 'Trivandrum', 'Ernakulam'];

router.post('/login', async (req, res) => {
  const username = String((req.body && req.body.username) || '').trim().toLowerCase();
  const password = (req.body && req.body.password) || '';
  if (!username || !password) return fail(res, 400, 'Username and password are required');
  try {
    const r = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (r.rowCount === 0) return fail(res, 401, 'Incorrect username or password');
    const user = r.rows[0];
    if (!user.active) return fail(res, 403, 'This account has been disabled');
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return fail(res, 401, 'Incorrect username or password');

    const token = await createSession(user.id);
    res.json({
      success: true, token,
      user: { id: user.id, username: user.username, name: user.name, role: user.role, branch: user.branch }
    });
  } catch (err) {
    console.error('Login failed:', err);
    fail(res, 500, 'Could not log in');
  }
});

router.post('/logout', requireAuth, async (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
  res.json({ success: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ success: true, user: req.user });
});

router.post('/change-password', requireAuth, async (req, res) => {
  const current = (req.body && req.body.current_password) || '';
  const next = (req.body && req.body.new_password) || '';
  if (next.length < 4) return fail(res, 400, 'New password must be at least 4 characters');
  try {
    const r = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const ok = await bcrypt.compare(current, r.rows[0].password_hash);
    if (!ok) return fail(res, 400, 'Current password is incorrect');
    const hash = await bcrypt.hash(next, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    fail(res, 500, 'Could not change password');
  }
});

// ---------- Admin-only account management ----------

router.get('/users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, username, name, role, branch, active, created_at FROM users ORDER BY id');
    res.json({ success: true, users: r.rows });
  } catch (err) {
    console.error(err);
    fail(res, 500, 'Could not load users');
  }
});

router.post('/users', requireAuth, requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  const username = String(b.username || '').trim().toLowerCase();
  const name = String(b.name || '').trim();
  const role = b.role;
  const branch = b.branch || null;
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) return fail(res, 400, 'Username must be 3-30 characters: letters, numbers, dot, dash, underscore');
  if (!name) return fail(res, 400, 'Name is required');
  if (!ROLES.includes(role)) return fail(res, 400, 'Role must be one of: ' + ROLES.join(', '));
  if (role === 'branch' && !BRANCHES.includes(branch)) return fail(res, 400, 'Branch role needs a valid branch');
  if (role !== 'branch' && branch) return fail(res, 400, 'Only the branch role has a branch');
  if (!b.password || String(b.password).length < 4) return fail(res, 400, 'Password must be at least 4 characters');

  try {
    const hash = await bcrypt.hash(String(b.password), 10);
    const r = await pool.query(
      'INSERT INTO users (username, password_hash, name, role, branch) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [username, hash, name, role, branch]);
    res.status(201).json({ success: true, user_id: r.rows[0].id, username, role });
  } catch (err) {
    if (err.code === '23505') return fail(res, 400, 'That username is already taken');
    console.error('Create user failed:', err);
    fail(res, 500, 'Could not create user');
  }
});

router.put('/users/:id/active', requireAuth, requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid user id');
  const active = req.body && req.body.active !== false;
  try {
    const r = await pool.query('UPDATE users SET active = $1 WHERE id = $2 RETURNING id', [active, id]);
    if (r.rowCount === 0) return fail(res, 404, 'User not found');
    res.json({ success: true, user_id: id, active });
  } catch (err) {
    console.error(err);
    fail(res, 500, 'Could not update user');
  }
});

// PUT /api/auth/users/:id - body: { username?, name?, role?, branch? }
// Renames the login/display name and/or changes department. Logs that user out everywhere
// (their old sessions are cleared), since a role or username change should take effect at once.
router.put('/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid user id');
  const b = req.body || {};
  const sets = [];
  const params = [];

  try {
    const cur = await pool.query('SELECT role, branch FROM users WHERE id = $1', [id]);
    if (cur.rowCount === 0) return fail(res, 404, 'User not found');
    const effectiveRole = b.role !== undefined ? b.role : cur.rows[0].role;

    if (b.username !== undefined) {
      const username = String(b.username).trim().toLowerCase();
      if (!/^[a-z0-9._-]{3,30}$/.test(username)) {
        return fail(res, 400, 'Username must be 3-30 characters: letters, numbers, dot, dash, underscore');
      }
      params.push(username); sets.push(`username = $${params.length}`);
    }
    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (!name) return fail(res, 400, 'Name cannot be empty');
      params.push(name); sets.push(`name = $${params.length}`);
    }
    if (b.role !== undefined) {
      if (!ROLES.includes(b.role)) return fail(res, 400, 'Role must be one of: ' + ROLES.join(', '));
      if (cur.rows[0].role === 'admin' && b.role !== 'admin') {
        const admins = await pool.query("SELECT COUNT(*)::int n FROM users WHERE role = 'admin' AND active AND id <> $1", [id]);
        if (admins.rows[0].n === 0) return fail(res, 400, 'Cannot demote the last active admin account');
      }
      params.push(b.role); sets.push(`role = $${params.length}`);
    }
    // branch is required for role 'branch' and must be empty for every other role.
    if (b.branch !== undefined || b.role !== undefined) {
      const branch = b.branch !== undefined ? (b.branch || null) : cur.rows[0].branch;
      if (effectiveRole === 'branch' && !BRANCHES.includes(branch)) {
        return fail(res, 400, 'Branch role needs a valid branch');
      }
      if (effectiveRole !== 'branch' && branch) {
        return fail(res, 400, 'Only the branch role has a branch');
      }
      params.push(effectiveRole === 'branch' ? branch : null); sets.push(`branch = $${params.length}`);
    }
    if (sets.length === 0) return fail(res, 400, 'Nothing to update');

    params.push(id);
    const r = await pool.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id, username, name, role, branch`, params);
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    res.json({ success: true, user: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return fail(res, 400, 'That username is already taken');
    console.error('Rename user failed:', err);
    fail(res, 500, 'Could not update user');
  }
});

// PUT /api/auth/users/:id/password - body: { new_password } - admin resets a forgotten password
// without needing the old one. Also signs that user out everywhere.
router.put('/users/:id/password', requireAuth, requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid user id');
  const next = (req.body && req.body.new_password) || '';
  if (next.length < 4) return fail(res, 400, 'New password must be at least 4 characters');
  try {
    const hash = await bcrypt.hash(next, 10);
    const r = await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id', [hash, id]);
    if (r.rowCount === 0) return fail(res, 404, 'User not found');
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    res.json({ success: true, user_id: id });
  } catch (err) {
    console.error('Reset password failed:', err);
    fail(res, 500, 'Could not reset password');
  }
});

// DELETE /api/auth/users/:id - only allowed once this account has no history left behind
// (no PO/payment/GRN/etc. created by it) - otherwise disable the account instead.
router.delete('/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid user id');
  if (id === req.user.id) return fail(res, 400, 'You cannot delete your own account while logged in as it');

  const HISTORY_TABLES = ['branch_stock_requests', 'production_indents', 'purchase_orders',
                           'payments', 'grn_notes', 'purchase_invoices'];
  try {
    const cur = await pool.query('SELECT id, role FROM users WHERE id = $1', [id]);
    if (cur.rowCount === 0) return fail(res, 404, 'User not found');

    if (cur.rows[0].role === 'admin') {
      const admins = await pool.query("SELECT COUNT(*)::int n FROM users WHERE role = 'admin' AND active");
      if (admins.rows[0].n <= 1) return fail(res, 400, 'Cannot delete the last active admin account');
    }

    for (const table of HISTORY_TABLES) {
      const r = await pool.query(`SELECT 1 FROM ${table} WHERE created_by = $1 LIMIT 1`, [id]);
      if (r.rowCount > 0) {
        return fail(res, 400,
          `Cannot delete: this account has created records in "${table}". Disable it instead to keep the history.`);
      }
    }

    await pool.query('DELETE FROM users WHERE id = $1', [id]); // sessions cascade
    res.json({ success: true, deleted_user_id: id });
  } catch (err) {
    console.error('Delete user failed:', err);
    fail(res, 500, 'Could not delete user');
  }
});

// ---------- Admin-only permission matrix ----------

// GET /api/auth/role-permissions - the catalog (what every action is) plus which
// roles currently have each one, so the frontend can render checkboxes.
router.get('/role-permissions', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const r = await pool.query('SELECT role, permission_key FROM role_permissions');
    const granted = {}; // "role|key" -> true
    r.rows.forEach(row => { granted[row.role + '|' + row.permission_key] = true; });
    res.json({ success: true, catalog: CATALOG, roles: PERMISSION_ROLES, granted });
  } catch (err) {
    console.error('Load role-permissions failed:', err);
    fail(res, 500, 'Could not load permissions');
  }
});

// PUT /api/auth/role-permissions - body: { role, permission_key, allowed }
router.put('/role-permissions', requireAuth, requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  if (!PERMISSION_ROLES.includes(b.role)) return fail(res, 400, 'Role must be one of: ' + PERMISSION_ROLES.join(', '));
  const known = CATALOG.some(c => c.key === b.permission_key);
  if (!known) return fail(res, 400, 'Unknown permission key');
  const allowed = b.allowed !== false;
  try {
    if (allowed) {
      await pool.query(
        'INSERT INTO role_permissions (role, permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [b.role, b.permission_key]);
    } else {
      await pool.query('DELETE FROM role_permissions WHERE role = $1 AND permission_key = $2', [b.role, b.permission_key]);
    }
    res.json({ success: true, role: b.role, permission_key: b.permission_key, allowed });
  } catch (err) {
    console.error('Update role-permissions failed:', err);
    fail(res, 500, 'Could not update permission');
  }
});

module.exports = router;
