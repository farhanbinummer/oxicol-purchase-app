// routes/workspace.js - the workspace a signed-in person works in.
//   GET  /api/workspace/me                    who I am, my workspaces, the active one and its navigation
//   PUT  /api/workspace/preference            { active?, default? } remember where I work / my default
//   GET  /api/workspace/notifications         what needs my attention (only things I may act on, each once)
//   GET  /api/workspace/approvals             decisions waiting for me, with context
//   GET  /api/workspace/expected-deliveries   purchase orders waiting for goods (never shows money)
//   GET  /api/workspace/:id/dashboard         the dashboard of one of MY workspaces
//
// Choosing a workspace changes only what is shown. Every record request is still checked against the person's
// roles, branches, permissions and field access on its own - see access.js.

const express = require('express');
const { pool } = require('../database');
const { fail } = require('../utils');
const { KEYS } = require('../permissions');
const { can, branchScope } = require('../access');
const W = require('../workspaces');
const { visibleClause } = require('../rd-visibility');
const router = express.Router();

const CREATE_LINKS = [
  { label: 'Branch Stock Request', href: 'branch-request-form.html', perm: KEYS.BRANCH_REQUEST_CREATE },
  { label: 'Production Indent', href: 'production-indent-form.html', perm: KEYS.PRODUCTION_INDENT_CREATE },
  { label: 'Purchase Order', href: 'po-form.html', perm: KEYS.PO_CREATE },
  { label: 'Payment', href: 'payment-form.html', perm: KEYS.PAYMENT_CREATE },
  { label: 'GRN', href: 'grn-form.html', perm: KEYS.GRN_CREATE }
];

async function prefsOf(userId) {
  const r = await pool.query('SELECT default_workspace, last_workspace FROM user_workspace_prefs WHERE user_id = $1', [userId]);
  return r.rows[0] || { default_workspace: null, last_workspace: null };
}

/** The workspace in use: an explicit choice, else the last one used, else the default, else the first assigned. */
function resolveActive(list, prefs, requested) {
  const ids = list.map(w => w.id);
  if (requested && ids.includes(requested)) return requested;
  if (prefs.last_workspace && ids.includes(prefs.last_workspace)) return prefs.last_workspace;
  if (prefs.default_workspace && ids.includes(prefs.default_workspace)) return prefs.default_workspace;
  return ids[0] || null;
}

router.get('/me', async (req, res) => {
  try {
    const list = W.workspacesFor(req.access);
    const prefs = await prefsOf(req.user.id);
    const active = resolveActive(list, prefs, req.query.workspace);
    const branches = branchScope(req.access, KEYS.BRANCH_REQUEST_VIEW);
    // favourite and recently opened R&D projects, only ones this person may open
    let projects = { favourites: [], recent: [] };
    if (can(req.access, KEYS.RD_VIEW)) {
      try {
        const vis = visibleClause(req.access, req.user.id, 'p', 0);
        const rows = (await pool.query(
          `SELECT p.id, p.project_number AS number, p.title, up.favourite, up.last_opened FROM rd_user_projects up JOIN rd_projects p ON p.id = up.project_id
            WHERE up.user_id = $1 AND p.is_draft = FALSE AND ${vis.clause} AND (up.favourite OR up.last_opened IS NOT NULL)
            ORDER BY up.last_opened DESC NULLS LAST LIMIT 40`, vis.params)).rows;
        projects = { favourites: rows.filter(r => r.favourite).slice(0, 6), recent: rows.filter(r => !r.favourite).slice(0, 5) };
      } catch (e) { console.error('sidebar projects failed:', e.message); }
    }
    res.json({
      success: true,
      user: { id: req.user.id, name: req.user.name, username: req.user.username, role: req.user.role, roles: req.access.roles, branch: req.user.branch },
      is_admin: req.access.isAdmin,
      workspaces: list, active, default: prefs.default_workspace,
      nav: active ? W.navFor(active, req.access) : [],
      tabs: active ? W.WORKSPACES[active].tabs : [],
      create_links: CREATE_LINKS.filter(c => can(req.access, c.perm)).map(({ label, href }) => ({ label, href })),
      projects,
      scope: { branches }, // null means every branch
      fields: { prices: can(req.access, KEYS.FIELD_PRICES), supplier_bank: can(req.access, KEYS.FIELD_SUPPLIER_BANK) },
      permissions: req.access.isAdmin ? null : [...req.access.grants.keys()]
    });
  } catch (err) { console.error(err); fail(res, 500, 'Could not load your workspace'); }
});

router.put('/preference', async (req, res) => {
  const b = req.body || {};
  const ids = W.workspacesFor(req.access).map(w => w.id);
  if (b.active !== undefined && !ids.includes(b.active)) return fail(res, 403, 'That workspace is not assigned to you');
  if (b.default !== undefined && b.default !== null && !ids.includes(b.default)) return fail(res, 403, 'That workspace is not assigned to you');
  if (b.active === undefined && b.default === undefined) return fail(res, 400, 'Nothing to save');
  try {
    const cur = await prefsOf(req.user.id);
    const next = {
      last: b.active !== undefined ? b.active : cur.last_workspace,
      def: b.default !== undefined ? b.default : cur.default_workspace
    };
    await pool.query(
      `INSERT INTO user_workspace_prefs (user_id, default_workspace, last_workspace) VALUES ($1,$2,$3)
       ON CONFLICT (user_id) DO UPDATE SET default_workspace = $2, last_workspace = $3, updated_at = NOW()`,
      [req.user.id, next.def, next.last]);
    res.json({ success: true, active: next.last, default: next.def });
  } catch (err) { console.error(err); fail(res, 500, 'Could not save your preference'); }
});

router.get('/notifications', async (req, res) => {
  try {
    const items = await W.buildNotifications(req);
    res.json({ success: true, count: items.length, notifications: items });
  } catch (err) { console.error(err); fail(res, 500, 'Could not load notifications'); }
});

router.get('/approvals', async (req, res) => {
  try {
    const items = await W.approvalItems(W.contextFor(req));
    res.json({ success: true, count: items.length, approvals: items });
  } catch (err) { console.error(err); fail(res, 500, 'Could not load approvals'); }
});

router.get('/expected-deliveries', async (req, res) => {
  if (!can(req.access, KEYS.PO_VIEW)) return fail(res, 403, 'Your role is not allowed to do this');
  const when = ['all', 'today', 'soon', 'overdue'].includes(req.query.when) ? req.query.when : 'all';
  try {
    const pos = await W.expectedDeliveries(when);
    const ids = pos.map(p => p.id);
    // ordered quantity per line, and what an earlier delivery of the same item already sent back as rejected
    const lines = ids.length ? await pool.query(
      `SELECT i.po_id, i.item_name, i.quantity::float AS ordered, i.unit,
              COALESCE((SELECT SUM(gi.received_quantity)::float FROM grn_items gi JOIN grn_notes g ON g.id = gi.grn_id
                         WHERE g.po_id = i.po_id AND g.status = 'rejected' AND lower(gi.item_name) = lower(i.item_name)), 0) AS rejected_earlier
         FROM po_items i WHERE i.po_id = ANY($1) ORDER BY i.id`, [ids]) : { rows: [] };
    const by = new Map();
    lines.rows.forEach(l => { if (!by.has(l.po_id)) by.set(l.po_id, []); by.get(l.po_id).push({ item_name: l.item_name, unit: l.unit, ordered: l.ordered, received_accepted: 0, rejected_earlier: l.rejected_earlier, remaining: l.ordered }); });
    res.json({ success: true, when, count: pos.length, deliveries: pos.map(p => ({ ...p, items: by.get(p.id) || [] })) });
  } catch (err) { console.error(err); fail(res, 500, 'Could not load expected deliveries'); }
});

router.get('/:id/dashboard', async (req, res) => {
  const id = req.params.id;
  if (!W.WORKSPACES[id]) return fail(res, 404, 'Unknown workspace');
  if (!W.workspacesFor(req.access).some(w => w.id === id)) return fail(res, 403, 'That workspace is not assigned to you');
  try {
    res.json({ success: true, ...(await W.buildDashboard(req, id, { period: req.query.period })) });
  } catch (err) { console.error('Dashboard failed:', err); fail(res, 500, 'Could not load this dashboard'); }
});

module.exports = router;
