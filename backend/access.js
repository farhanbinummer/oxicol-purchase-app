// access.js - what a signed-in person may do, expressed as four independent rules:
//
//   1. ROLE    the responsibilities assigned to them (a person may hold several: user_roles)
//   2. SCOPE   which branches those responsibilities apply to (user_scopes, kept per role)
//   3. ACTION  which permission keys their roles grant (role_permissions, editable by an administrator)
//   4. FIELD   whether money fields are included in what they receive (field.* keys)
//
// A workspace is only a view over these rules. Choosing a workspace never grants anything.
// Everything here is read fresh on every request, so a change an administrator makes takes effect at once.

const { pool } = require('./database');
const { KEYS } = require('./permissions');

const BRANCHES = ['Kannur', 'Thrissur', 'Trivandrum', 'Ernakulam'];

// rank decides which role is shown as a person's primary one (users.role) when they hold several.
const ROLES = {
  admin:      { label: 'Administrator', rank: 0 },
  manager:    { label: 'Manager',       rank: 1 },
  purchase:   { label: 'Purchase',      rank: 2 },
  accounts:   { label: 'Accounts',      rank: 3 },
  store:      { label: 'Stores',        rank: 4 },
  qc:         { label: 'Quality check', rank: 5 },
  rd:         { label: 'R&D',           rank: 5.5 },
  production: { label: 'Production',    rank: 6 },
  branch:     { label: 'Branch staff',  rank: 7, needsBranch: true }
};
const ROLE_NAMES = Object.keys(ROLES);

function primaryRole(roles) {
  return [...roles].filter(r => ROLES[r]).sort((a, b) => ROLES[a].rank - ROLES[b].rank)[0] || null;
}

/** Reads a person's roles, the actions those roles grant, and their branch scope. */
async function loadAccess(db, userId) {
  const d = db || pool;
  const rr = await d.query('SELECT role FROM user_roles WHERE user_id = $1', [userId]);
  let roles = rr.rows.map(r => r.role);
  if (roles.length === 0) { // safety net for a row created before roles were tracked separately
    roles = (await d.query('SELECT role FROM users WHERE id = $1', [userId])).rows.map(r => r.role);
  }
  const grants = new Map(); // permission key -> roles that grant it
  if (roles.length) {
    const rp = await d.query('SELECT role, permission_key FROM role_permissions WHERE role = ANY($1)', [roles]);
    rp.rows.forEach(r => { if (!grants.has(r.permission_key)) grants.set(r.permission_key, []); grants.get(r.permission_key).push(r.role); });
  }
  const sc = await d.query("SELECT role, scope_value FROM user_scopes WHERE user_id = $1 AND scope_type = 'branch'", [userId]);
  const branchesByRole = {};
  sc.rows.forEach(r => { (branchesByRole[r.role] = branchesByRole[r.role] || []).push(r.scope_value); });
  // An account made before scopes were tracked (or by hand in the database) still has its branch on the user row.
  if (roles.includes('branch') && !branchesByRole.branch) {
    const legacy = (await d.query('SELECT branch FROM users WHERE id = $1', [userId])).rows[0];
    if (legacy && legacy.branch) branchesByRole.branch = [legacy.branch];
  }
  return { userId, roles, isAdmin: roles.includes('admin'), grants, branchesByRole };
}

/** True when the person holds an action permission. Administrators hold every permission (existing behaviour). */
function can(access, key) {
  return !!access && (access.isAdmin || access.grants.has(key));
}

/**
 * Which branches the person may reach through this permission.
 *   null    -> every branch (no restriction)
 *   [ ... ] -> only these branches; an empty list means none
 * The scope that applies is the union of the scopes of the roles that grant the permission. A role is
 * restricted when it is the branch role (it fails closed with no branch) or when an administrator has
 * assigned it branches; any other role without branches is unrestricted.
 */
function branchScope(access, key) {
  if (!access) return [];
  if (access.isAdmin) return null;
  const granting = access.grants.get(key) || [];
  if (granting.length === 0) return [];
  let list = [];
  for (const role of granting) {
    const own = access.branchesByRole[role] || [];
    const restricted = ROLES[role] && ROLES[role].needsBranch ? true : own.length > 0;
    if (!restricted) return null;
    list = list.concat(own);
  }
  return [...new Set(list)];
}

/** Adds ` AND <column> = ANY($n)` (or nothing, or `AND FALSE`) for a branch scope. Mutates params. */
function branchClause(scope, column, params) {
  if (scope === null) return '';
  if (scope.length === 0) return ' AND FALSE';
  params.push(scope);
  return ` AND ${column} = ANY($${params.length})`;
}

/** True when a record belonging to `branch` is inside the scope. */
function inBranchScope(scope, branch) {
  return scope === null || scope.includes(branch);
}

/** Which restricted fields this person receives. */
function fieldAccess(access) {
  return { prices: can(access, KEYS.FIELD_PRICES), supplier_bank: can(access, KEYS.FIELD_SUPPLIER_BANK) };
}

/** Removes money fields from a purchase-order row the person may open but may not price. */
function redactPo(po, fa) {
  if (!po) return po;
  if (!fa.prices) ['subtotal', 'cgst_amount', 'sgst_amount', 'igst_amount', 'total_amount'].forEach(k => { delete po[k]; });
  if (!fa.supplier_bank) ['bank_name', 'account_number', 'ifsc_code'].forEach(k => { delete po[k]; });
  return po;
}
function redactItems(items, fa) {
  if (!fa.prices) items.forEach(i => { delete i.rate; delete i.line_amount; });
  return items;
}

module.exports = { redactPo, redactItems, ROLES, ROLE_NAMES, BRANCHES, primaryRole, loadAccess, can, branchScope, branchClause, inBranchScope, fieldAccess };
