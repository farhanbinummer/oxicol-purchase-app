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
const { audit } = require('../audit');
const { ROLES: ROLE_INFO, ROLE_NAMES, BRANCHES, primaryRole, loadAccess } = require('../access');
const router = express.Router();

const ROLES = ROLE_NAMES;
const PERMISSION_ROLES = ROLE_NAMES.filter(r => r !== 'admin'); // admin is never stored - it always passes

/** The person as the browser keeps it: identity plus every role held. */
async function publicUser(user) {
  const access = await loadAccess(pool, user.id);
  return { id: user.id, username: user.username, name: user.name, role: user.role, branch: user.branch, roles: access.roles };
}

/** True when another ACTIVE account would still hold the administrator role. */
async function otherActiveAdmin(db, exceptUserId) {
  const r = await db.query(
    `SELECT 1 FROM user_roles ur JOIN users u ON u.id = ur.user_id
      WHERE ur.role = 'admin' AND u.active AND u.id <> $1 LIMIT 1`, [exceptUserId]);
  return r.rowCount > 0;
}

/**
 * Sets a person's roles and the branches each role covers, in one place so every route stays consistent.
 * users.role / users.branch keep describing the primary role, so older screens and queries still work.
 */
async function applyAccess(client, userId, roles, scopes) {
  await client.query('DELETE FROM user_roles WHERE user_id = $1 AND NOT (role = ANY($2))', [userId, roles]);
  for (const role of roles) await client.query('INSERT INTO user_roles (user_id, role) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, role]);
  await client.query("DELETE FROM user_scopes WHERE user_id = $1 AND scope_type = 'branch'", [userId]);
  for (const role of roles) {
    for (const b of (scopes[role] || [])) {
      await client.query("INSERT INTO user_scopes (user_id, role, scope_type, scope_value) VALUES ($1,$2,'branch',$3) ON CONFLICT DO NOTHING", [userId, role, b]);
    }
  }
  const primary = primaryRole(roles);
  const branch = primary === 'branch' ? (scopes.branch || [])[0] : null;
  await client.query('UPDATE users SET role = $1, branch = $2 WHERE id = $3', [primary, branch, userId]);
  return primary;
}

/** Checks a requested { roles, scopes } and returns an error message, or null when it is acceptable. */
function checkAccessRequest(roles, scopes) {
  if (!Array.isArray(roles) || roles.length === 0) return 'Choose at least one role';
  if (roles.some(r => !ROLES.includes(r))) return 'Role must be one of: ' + ROLES.join(', ');
  if (new Set(roles).size !== roles.length) return 'A role is listed twice';
  for (const [role, list] of Object.entries(scopes || {})) {
    if (!roles.includes(role)) return 'Branches were given for a role this person does not hold';
    if (!Array.isArray(list) || list.some(b => !BRANCHES.includes(b))) return 'Branches must be from: ' + BRANCHES.join(', ');
  }
  for (const role of roles) {
    if (ROLE_INFO[role].needsBranch && !((scopes || {})[role] || []).length) return `The ${ROLE_INFO[role].label} role needs at least one branch`;
  }
  return null;
}

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
    // Signing in lands on the person's default workspace when they have chosen one.
    await pool.query('UPDATE user_workspace_prefs SET last_workspace = default_workspace WHERE user_id = $1 AND default_workspace IS NOT NULL', [user.id]);
    res.json({
      success: true, token,
      user: await publicUser(user)
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

// Which actions this login may use - the navigation menu is built from this, so it can never show a link the
// server would refuse. (The server still checks every request on its own; this is only for display.)
router.get('/my-permissions', requireAuth, async (req, res) => {
  try {
    if (req.access.isAdmin) return res.json({ success: true, admin: true, permissions: CATALOG.map(c => c.key) });
    res.json({ success: true, admin: false, permissions: [...req.access.grants.keys()] });
  } catch (err) { console.error(err); fail(res, 500, 'Could not load permissions'); }
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
      `SELECT u.id, u.username, u.name, u.role, u.branch, u.active, u.email, u.phone, u.created_at,
              COALESCE((SELECT array_agg(x.role ORDER BY x.role) FROM user_roles x WHERE x.user_id = u.id), ARRAY[u.role]::varchar[]) AS roles,
              COALESCE((SELECT json_object_agg(s.role, s.branches)
                          FROM (SELECT role, array_agg(scope_value ORDER BY scope_value) AS branches
                                  FROM user_scopes WHERE user_id = u.id AND scope_type = 'branch' GROUP BY role) s), '{}'::json) AS scopes,
              p.default_workspace
         FROM users u LEFT JOIN user_workspace_prefs p ON p.user_id = u.id
        ORDER BY u.id`);
    res.json({ success: true, users: r.rows });
  } catch (err) {
    console.error(err);
    fail(res, 500, 'Could not load users');
  }
});

// body: { username, name, password, role }  or  { ..., roles: ['purchase','store'], scopes: { branch: ['Kannur'] } }
router.post('/users', requireAuth, requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  const username = String(b.username || '').trim().toLowerCase();
  const name = String(b.name || '').trim();
  const roles = Array.isArray(b.roles) ? b.roles : (b.role ? [b.role] : []);
  // The older form sent a single role plus a branch; that still works.
  const scopes = b.scopes || (roles.includes('branch') && b.branch ? { branch: [b.branch] } : {});
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) return fail(res, 400, 'Username must be 3-30 characters: letters, numbers, dot, dash, underscore');
  if (!name) return fail(res, 400, 'Name is required');
  const problem = checkAccessRequest(roles, scopes);
  if (problem) return fail(res, 400, problem);
  if (!b.password || String(b.password).length < 4) return fail(res, 400, 'Password must be at least 4 characters');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const hash = await bcrypt.hash(String(b.password), 10);
    const first = primaryRole(roles);
    const r = await client.query(
      'INSERT INTO users (username, password_hash, name, role, branch) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [username, hash, name, first, first === 'branch' ? scopes.branch[0] : null]);
    const primary = await applyAccess(client, r.rows[0].id, roles, scopes);
    await audit(client, req, { action: 'user.create', entity: 'user', id: r.rows[0].id, summary: `Account ${username} created with role${roles.length > 1 ? 's' : ''} ${roles.join(', ')}`, after: { username, roles, scopes } });
    await client.query('COMMIT');
    res.status(201).json({ success: true, user_id: r.rows[0].id, username, role: primary, roles });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return fail(res, 400, 'That username is already taken');
    console.error('Create user failed:', err);
    fail(res, 500, 'Could not create user');
  } finally {
    client.release();
  }
});

// PUT /api/auth/users/:id/access - body: { roles: [...], scopes: { branch: ['Kannur'], manager: [] }, default_workspace? }
// Replaces what this person may be and which branches each role covers. Takes effect on their next request.
router.put('/users/:id/access', requireAuth, requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid user id');
  const b = req.body || {};
  const problem = checkAccessRequest(b.roles, b.scopes || {});
  if (problem) return fail(res, 400, problem);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query('SELECT id, username FROM users WHERE id = $1 FOR UPDATE', [id]);
    if (cur.rowCount === 0) { await client.query('ROLLBACK'); return fail(res, 404, 'User not found'); }
    const before = await loadAccess(client, id);
    if (before.roles.includes('admin') && !b.roles.includes('admin') && !(await otherActiveAdmin(client, id))) {
      await client.query('ROLLBACK');
      return fail(res, 400, 'Cannot remove the administrator role from the last active administrator');
    }
    const primary = await applyAccess(client, id, b.roles, b.scopes || {});
    if (b.default_workspace !== undefined) {
      await client.query(
        `INSERT INTO user_workspace_prefs (user_id, default_workspace) VALUES ($1,$2)
         ON CONFLICT (user_id) DO UPDATE SET default_workspace = EXCLUDED.default_workspace, updated_at = NOW()`,
        [id, b.default_workspace || null]);
    }
    await audit(client, req, { action: 'user.access', entity: 'user', id, summary: `Access changed for ${cur.rows[0].username}`,
      before: { roles: before.roles, scopes: before.branchesByRole }, after: { roles: b.roles, scopes: b.scopes || {} } });
    await client.query('COMMIT');
    res.json({ success: true, user_id: id, role: primary, roles: b.roles });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Update access failed:', err);
    fail(res, 500, 'Could not update access');
  } finally {
    client.release();
  }
});

// Where alerts for this login are sent. Blank clears it. Admin only.
router.put('/users/:id/contact', requireAuth, requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid user id');
  const email = req.body && req.body.email ? String(req.body.email).trim() : '';
  const phone = req.body && req.body.phone ? String(req.body.phone).trim() : '';
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, 'That does not look like an email address');
  if (phone && !/^\+?[0-9 ()-]{8,20}$/.test(phone)) return fail(res, 400, 'WhatsApp number should be digits with the country code, e.g. 919876543210');
  try {
    const r = await pool.query('UPDATE users SET email = $1, phone = $2 WHERE id = $3 RETURNING id', [email || null, phone || null, id]);
    if (r.rowCount === 0) return fail(res, 404, 'User not found');
    res.json({ success: true, user_id: id });
  } catch (err) {
    console.error(err);
    fail(res, 500, 'Could not save contact details');
  }
});

router.put('/users/:id/active', requireAuth, requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid user id');
  const active = req.body && req.body.active !== false;
  try {
    if (!active && !(await otherActiveAdmin(pool, id))) {
      const isAdmin = await pool.query("SELECT 1 FROM user_roles WHERE user_id = $1 AND role = 'admin'", [id]);
      if (isAdmin.rowCount > 0) return fail(res, 400, 'Cannot disable the last active administrator');
    }
    const r = await pool.query('UPDATE users SET active = $1 WHERE id = $2 RETURNING id', [active, id]);
    await audit(pool, req, { action: active ? 'user.enable' : 'user.disable', entity: 'user', id, summary: `Account ${id} ${active ? 'enabled' : 'disabled'}` });
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
      if (cur.rows[0].role === 'admin' && b.role !== 'admin' && !(await otherActiveAdmin(pool, id))) {
        return fail(res, 400, 'Cannot demote the last active admin account');
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
    if (b.role !== undefined || b.branch !== undefined) {
      // this older screen edits ONE role; keep the role/scope tables in step with it
      const u = r.rows[0];
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await applyAccess(c, id, [u.role], u.role === 'branch' ? { branch: [u.branch] } : {});
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    }
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

    const holdsAdmin = await pool.query("SELECT 1 FROM user_roles WHERE user_id = $1 AND role = 'admin'", [id]);
    if (holdsAdmin.rowCount > 0 && !(await otherActiveAdmin(pool, id))) {
      return fail(res, 400, 'Cannot delete the last active admin account');
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
    res.json({ success: true, catalog: CATALOG, roles: PERMISSION_ROLES, role_labels: Object.fromEntries(PERMISSION_ROLES.map(r => [r, ROLE_INFO[r].label])), granted });
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
    await audit(pool, req, { action: allowed ? 'permission.grant' : 'permission.revoke', entity: 'permission', summary: `${allowed ? 'Granted' : 'Revoked'} ${b.permission_key} ${allowed ? 'to' : 'from'} the ${b.role} role`, after: { role: b.role, permission_key: b.permission_key, allowed } });
    res.json({ success: true, role: b.role, permission_key: b.permission_key, allowed });
  } catch (err) {
    console.error('Update role-permissions failed:', err);
    fail(res, 500, 'Could not update permission');
  }
});

module.exports = router;
module.exports.otherActiveAdmin = otherActiveAdmin;
