// workspaces.js - what each role's workspace shows, built from the real records.
//
// A workspace is a PRESENTATION of work: a navigation menu, up to four summary cards, a "my work" queue, exceptions,
// recent activity and a few quick actions. It never grants anything. Every number and row below is produced under
// the same rules as the rest of the server:
//   - a section is only built when the person holds the permission to see that kind of record,
//   - requests are limited to the branches the person is assigned to,
//   - money is only included when the person holds field.prices.
// So a dashboard count and the list it opens are computed from the same conditions.
//
// Functionality the application does not have yet (quotations, stock locations, dispatches, returns, branch
// delivery confirmation, line-level inspection, attachments) is deliberately absent: no card, queue or menu entry
// exists for it. See docs/WORKSPACES.md for that list.

const { pool } = require('./database');
const { KEYS } = require('./permissions');
const { ROLES, ROLE_NAMES, can, branchScope, branchClause, fieldAccess } = require('./access');
const { emailOn, whatsappOn } = require('./notify');
const { visibleClause } = require('./rd-visibility');
const RD = require('./rd-logic');

const PRE_DELIVERY = "('created','payment_pending','payment_done','in_transit')"; // a PO whose goods have not been received yet
const MAX_QUEUE = 15;

const PROGRESS = { pending: 'Submitted', approved: 'Approved', po_raised: 'Being prepared', rejected: 'Rejected' };
const STATUS_WORDS = {
  created: 'Created', payment_pending: 'Payment pending', payment_done: 'Payment done', in_transit: 'In transit',
  delivered: 'Delivered', invoice_matched: 'Invoice matched', variance_flagged: 'Variance flagged', closed: 'Closed',
  pending_qc: 'Awaiting quality check', approved: 'Approved', rejected: 'Rejected', initiated: 'Awaiting confirmation',
  confirmed: 'Confirmed', uploaded: 'Invoice received'
};
const word = (s) => STATUS_WORDS[s] || (s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ') : '-');
const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nice = (d) => { if (!d) return ''; const p = String(d).slice(0, 10).split('-'); return p[2] + ' ' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(p[1]) - 1] + ' ' + p[0]; };
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));

// ---------- who is responsible: the roles whose permissions let them act ----------
const teamCache = new Map();
async function team(key) {
  const hit = teamCache.get(key);
  if (hit && Date.now() - hit.at < 30000) return hit.value;
  const r = await pool.query('SELECT DISTINCT role FROM role_permissions WHERE permission_key = $1', [key]);
  const names = r.rows.map(x => x.role).filter(x => ROLES[x]).sort((a, b) => ROLES[a].rank - ROLES[b].rank).map(x => ROLES[x].label);
  const value = names.length ? names.join(' / ') : 'Administrator';
  teamCache.set(key, { at: Date.now(), value });
  return value;
}

/** One entry of a work queue, in the shape every workspace shares. */
function task(o) {
  return {
    type: o.type, number: o.number, href: o.href, party: o.party || null, reason: o.reason,
    responsible: o.responsible || null, due: o.due || null, overdue: !!o.overdue,
    waiting_days: o.waiting_days == null ? null : Math.max(0, Number(o.waiting_days)),
    progress: o.progress || null,
    next: o.next || null,          // { label, href } - only when this person may take the step
    waiting_on: o.waiting_on || null, // plain words when they may not (e.g. "Awaiting approval by Stores")
    tone: o.tone || 'info'
  };
}
const byUrgency = (a, b) =>
  (a.overdue === b.overdue ? 0 : a.overdue ? -1 : 1) ||
  String(a.due || '9999-12-31').localeCompare(String(b.due || '9999-12-31')) ||
  (b.waiting_days || 0) - (a.waiting_days || 0);

const card = (key, label, value, href, tone, hint) => ({ key, label, value, href, tone: tone || 'neutral', hint: hint || null });

async function count(sql, params) { return (await pool.query(sql, params || [])).rows[0].n; }

// ---------- shared queries (the same conditions feed cards, queues and list pages) ----------

/** Purchase orders still waiting for goods. `when`: all | today | soon | overdue. Never includes money. */
function expectedWhere(when) {
  const base = `po.status IN ${PRE_DELIVERY} AND NOT EXISTS (SELECT 1 FROM grn_notes g WHERE g.po_id = po.id AND g.status <> 'rejected')`;
  if (when === 'today') return `${base} AND po.delivery_date = CURRENT_DATE`;
  if (when === 'soon') return `${base} AND po.delivery_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7`;
  if (when === 'overdue') return `${base} AND po.delivery_date < CURRENT_DATE`;
  return base;
}
async function expectedDeliveries(when, limit) {
  const r = await pool.query(
    `SELECT po.id, po.po_number, to_char(po.delivery_date,'YYYY-MM-DD') AS delivery_date, po.status, s.name AS supplier_name,
            (CURRENT_DATE - po.delivery_date) AS days_late,
            (SELECT COUNT(*)::int FROM po_items i WHERE i.po_id = po.id) AS lines,
            EXISTS (SELECT 1 FROM grn_notes g WHERE g.po_id = po.id AND g.status = 'rejected') AS earlier_rejected
       FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
      WHERE ${expectedWhere(when)}
      ORDER BY po.delivery_date NULLS LAST, po.id ${limit ? 'LIMIT ' + Number(limit) : ''}`);
  return r.rows;
}
const countExpected = (when) => count(`SELECT COUNT(*)::int n FROM purchase_orders po WHERE ${expectedWhere(when)}`);

const REJECTED_WAITING = `g.status = 'rejected' AND NOT EXISTS (SELECT 1 FROM grn_notes g2 WHERE g2.po_id = g.po_id AND g2.status <> 'rejected')`;

/** Requests the person may see, limited to their branches. */
function requestScope(ctx, key, column) {
  const params = [];
  const clause = branchClause(ctx.scope(key), column || 'b.branch', params);
  return { clause, params };
}

// ---------- recent activity (only record kinds the person may open; amounts only with field.prices) ----------
async function recentActivity(ctx, kinds) {
  const want = (k) => kinds.includes(k);
  const parts = [], params = [];
  if (want('po') && ctx.can(KEYS.PO_VIEW)) parts.push(`SELECT 'Purchase order' AS type, po.po_number AS reference, 'po-detail.html?id=' || po.id AS href, s.name AS party, po.total_amount AS amount, po.status AS status, po.created_at AS at FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id`);
  if (want('grn') && ctx.can(KEYS.GRN_VIEW)) parts.push(`SELECT 'Goods receipt', g.grn_number, 'grn-detail.html?id=' || g.id, s.name, NULL::numeric, g.status, g.created_at FROM grn_notes g JOIN purchase_orders po ON po.id = g.po_id JOIN suppliers s ON s.id = po.supplier_id`);
  if (want('payment') && ctx.can(KEYS.PAYMENT_VIEW_ALL)) parts.push(`SELECT 'Payment', p.payment_id, 'po-detail.html?id=' || p.po_id, s.name, p.amount, p.status, p.created_at FROM payments p JOIN suppliers s ON s.id = p.supplier_id`);
  if (want('request') && ctx.can(KEYS.BRANCH_REQUEST_VIEW)) {
    const rq = requestScope(ctx, KEYS.BRANCH_REQUEST_VIEW, 'b.branch');
    params.push(...rq.params);
    parts.push(`SELECT 'Branch request', b.request_number, 'branch-request-detail.html?id=' || b.id, b.branch, NULL::numeric, b.status, b.created_at FROM branch_stock_requests b WHERE TRUE${rq.clause}`);
  }
  if (want('indent') && ctx.can(KEYS.PRODUCTION_INDENT_VIEW)) parts.push(`SELECT 'Production indent', d.indent_number, 'production-indent-detail.html?id=' || d.id, d.production_head, NULL::numeric, d.status, d.created_at FROM production_indents d`);
  if (want('rd') && ctx.can(KEYS.RD_VIEW)) {
    const vis = visibleClause(ctx.access, ctx.user.id, 'p', params.length);
    params.push(...vis.params);
    const technical = ctx.can(KEYS.FIELD_RD_TECHNICAL);
    parts.push(`SELECT 'R&D update', p.project_number, 'project.html?id=' || p.id, COALESCE(u.author_name, 'System'), NULL::numeric, LEFT(u.body, 140), u.at
      FROM rd_updates u JOIN rd_projects p ON p.id = u.project_id WHERE ${vis.clause}${technical ? '' : " AND u.kind <> 'lab_note'"}`);
  }
  if (want('audit') && ctx.access.isAdmin) parts.push(`SELECT 'Change', a.action, 'audit.html', COALESCE(a.actor_name, 'system'), NULL::numeric, COALESCE(a.summary, a.action), a.at FROM audit_log a`);
  if (parts.length === 0) return [];
  const r = await pool.query(`SELECT * FROM (${parts.join(' UNION ALL ')}) a(type, reference, href, party, amount, status, at) ORDER BY at DESC LIMIT 8`, params);
  return r.rows.map(x => ({
    type: x.type, reference: x.reference, href: x.href, party: x.party,
    status: x.type === 'Change' || x.type === 'R&D update' ? x.status : word(x.status), amount: ctx.fa.prices && x.amount != null ? Number(x.amount) : null, at: x.at
  }));
}

// which kinds of record make a useful "recent activity" feed for each workspace
const ACTIVITY_KINDS = {
  purchase: ['po', 'grn', 'payment'], stores: ['grn', 'po'], branch: ['request'], production: ['indent', 'request'],
  qc: ['grn'], accounts: ['payment', 'po', 'grn'], manager: ['po', 'grn', 'payment', 'request', 'indent', 'rd'], admin: ['audit'], rd: ['rd']
};

// =====================================================================================================
// Workspace definitions
// =====================================================================================================
// nav items name the permission(s) that must be held; `also` lists pages that belong under the same entry.
const WORKSPACES = {
  purchase: {
    title: 'Purchase Workspace', roles: ['purchase'],
    description: 'What needs to be bought, which orders are late, and where suppliers need a follow-up.',
    tabs: [{ label: 'Requirements', icon: 'consolidate', href: 'consolidate.html' }, { label: 'Orders', icon: 'cart', href: 'po-list.html' }],
    nav: [
      { title: 'Workspace', items: [{ label: 'Dashboard', href: 'index.html', icon: 'dashboard' }] },
      { title: 'Buying', items: [
        { label: 'Purchase Requirements', href: 'consolidate.html', icon: 'consolidate', perm: KEYS.CONSOLIDATE_VIEW },
        { label: 'Purchase Orders', href: 'po-list.html', icon: 'po', perm: KEYS.PO_VIEW, also: ['po-detail.html', 'po-form.html'] },
        { label: 'Expected Deliveries', href: 'expected-deliveries.html', icon: 'grn', perm: KEYS.PO_VIEW } ] },
      { title: 'Progress', items: [
        { label: 'Goods Receipts', href: 'grn-list.html', icon: 'grn', perm: KEYS.GRN_VIEW, also: ['grn-detail.html'] },
        { label: 'Payments', href: 'payment-list.html', icon: 'payment', perm: KEYS.PAYMENT_VIEW_ALL } ] },
      { title: 'Reports', items: [{ label: 'Variances', href: 'variance-report.html', icon: 'variance', perm: KEYS.DASHBOARD_VIEW }] },
      { title: 'Master Data', items: [{ label: 'Finished Products', href: 'catalog.html', icon: 'tag', perm: KEYS.CATALOG_VIEW }] }
    ]
  },
  stores: {
    title: 'Stores Workspace', roles: ['store'],
    description: 'Arrivals to receive, goods waiting for a quality decision, and requests to approve.',
    tabs: [{ label: 'Deliveries', icon: 'grn', href: 'expected-deliveries.html' }, { label: 'Receipts', icon: 'clipboardlist', href: 'grn-list.html' }],
    nav: [
      { title: 'Workspace', items: [{ label: 'Dashboard', href: 'index.html', icon: 'dashboard' }] },
      { title: 'Receiving', items: [
        { label: 'Expected Deliveries', href: 'expected-deliveries.html', icon: 'grn', perm: KEYS.PO_VIEW },
        { label: 'Goods Receipts', href: 'grn-list.html', icon: 'clipboardlist', perm: KEYS.GRN_VIEW, also: ['grn-detail.html', 'grn-form.html'] } ] },
      { title: 'Requests', items: [
        { label: 'Branch Requests', href: 'branch-request-list.html', icon: 'branch', perm: KEYS.BRANCH_REQUEST_VIEW, also: ['branch-request-detail.html'] },
        { label: 'Production Requirements', href: 'production-indent-list.html', icon: 'production', perm: KEYS.PRODUCTION_INDENT_VIEW, also: ['production-indent-detail.html'] } ] },
      { title: 'Reports', items: [{ label: 'Variances', href: 'variance-report.html', icon: 'variance', perm: KEYS.DASHBOARD_VIEW }] }
    ]
  },
  branch: {
    title: 'Branch Workspace', roles: ['branch'],
    description: 'Ask for stock and follow each request until it is on its way.',
    tabs: [{ label: 'Requests', icon: 'clipboardlist', href: 'branch-request-list.html' }, { label: 'New request', icon: 'plus', href: 'branch-request-form.html' }],
    nav: [
      { title: 'Workspace', items: [{ label: 'Dashboard', href: 'index.html', icon: 'dashboard' }] },
      { title: 'My branch', items: [{ label: 'My Branch Requests', href: 'branch-request-list.html', icon: 'branch', perm: KEYS.BRANCH_REQUEST_VIEW, also: ['branch-request-detail.html', 'branch-request-form.html'] }] }
    ]
  },
  production: {
    title: 'Production Workspace', roles: ['production'],
    description: 'Approved demand to plan, recipes that block planning, and the materials production has asked for.',
    tabs: [{ label: 'Planning', icon: 'calculator', href: 'material-plan.html' }, { label: 'Requirements', icon: 'production', href: 'production-indent-list.html' }],
    nav: [
      { title: 'Workspace', items: [{ label: 'Dashboard', href: 'index.html', icon: 'dashboard' }] },
      { title: 'Planning', items: [
        { label: 'Material Planning', href: 'material-plan.html', icon: 'calculator', perm: KEYS.PRODUCTION_INDENT_VIEW },
        { label: 'Production Requirements', href: 'production-indent-list.html', icon: 'production', perm: KEYS.PRODUCTION_INDENT_VIEW, also: ['production-indent-detail.html', 'production-indent-form.html'] } ] },
      { title: 'Master Data', items: [
        { label: 'Recipes / Bill of Materials', href: 'recipes.html', icon: 'book', perm: KEYS.PRODUCTION_INDENT_VIEW },
        { label: 'Finished Products', href: 'catalog.html', icon: 'tag', perm: KEYS.CATALOG_VIEW } ] }
    ]
  },
  qc: {
    title: 'Quality Workspace', roles: ['qc'],
    description: 'Receipts waiting for an inspection decision, and rejected goods still to be replaced.',
    tabs: [{ label: 'Inspections', icon: 'shield', href: 'grn-list.html?status=pending_qc' }, { label: 'History', icon: 'history', href: 'grn-list.html?status=approved,rejected' }],
    nav: [
      { title: 'Workspace', items: [{ label: 'Dashboard', href: 'index.html', icon: 'dashboard' }] },
      { title: 'Inspection', items: [
        { label: 'Inspection Queue', href: 'grn-list.html?status=pending_qc', icon: 'shield', perm: KEYS.GRN_VIEW, also: ['grn-detail.html'] },
        { label: 'Inspection History', href: 'grn-list.html?status=approved,rejected', icon: 'history', perm: KEYS.GRN_VIEW },
        { label: 'Rejections & Replacements', href: 'variance-report.html', icon: 'variance', perm: KEYS.DASHBOARD_VIEW } ] }
    ]
  },
  accounts: {
    title: 'Accounts Workspace', roles: ['accounts'],
    description: 'Payments to confirm, orders waiting for payment, and invoices that do not match.',
    tabs: [{ label: 'Payments', icon: 'payment', href: 'payment-list.html' }, { label: 'Orders', icon: 'cart', href: 'po-list.html' }],
    nav: [
      { title: 'Workspace', items: [{ label: 'Dashboard', href: 'index.html', icon: 'dashboard' }] },
      { title: 'Finance', items: [
        { label: 'Payments', href: 'payment-list.html', icon: 'payment', perm: KEYS.PAYMENT_VIEW_ALL, also: ['payment-form.html'] },
        { label: 'Purchase Orders', href: 'po-list.html', icon: 'po', perm: KEYS.PO_VIEW, also: ['po-detail.html'] },
        { label: 'Goods Receipts', href: 'grn-list.html', icon: 'grn', perm: KEYS.GRN_VIEW, also: ['grn-detail.html'] } ] },
      { title: 'Reports', items: [{ label: 'Finance Variances', href: 'variance-report.html', icon: 'variance', perm: KEYS.DASHBOARD_VIEW }] }
    ]
  },
  manager: {
    title: 'Manager Workspace', roles: ['manager', 'admin'],
    description: 'Decisions waiting for you, what is late, and purchasing for a period you choose.',
    tabs: [{ label: 'Approvals', icon: 'shield', href: 'approvals.html' }, { label: 'Orders', icon: 'cart', href: 'po-list.html' }],
    nav: [
      { title: 'Workspace', items: [{ label: 'Dashboard', href: 'index.html', icon: 'dashboard' }] },
      { title: 'Decisions', items: [
        { label: 'Approvals', href: 'approvals.html', icon: 'shield', anyPerm: [KEYS.BRANCH_REQUEST_APPROVE, KEYS.PRODUCTION_INDENT_APPROVE, KEYS.PAYMENT_APPROVE, KEYS.GRN_APPROVE] },
        { label: 'Branch Requests', href: 'branch-request-list.html', icon: 'branch', perm: KEYS.BRANCH_REQUEST_VIEW, also: ['branch-request-detail.html'] },
        { label: 'Production Requirements', href: 'production-indent-list.html', icon: 'production', perm: KEYS.PRODUCTION_INDENT_VIEW, also: ['production-indent-detail.html'] } ] },
      { title: 'Progress', items: [
        { label: 'Purchase Orders', href: 'po-list.html', icon: 'po', perm: KEYS.PO_VIEW, also: ['po-detail.html'] },
        { label: 'Expected Deliveries', href: 'expected-deliveries.html', icon: 'grn', perm: KEYS.PO_VIEW },
        { label: 'Payments', href: 'payment-list.html', icon: 'payment', perm: KEYS.PAYMENT_VIEW_ALL } ] },
      { title: 'Reports', items: [{ label: 'Variances', href: 'variance-report.html', icon: 'variance', perm: KEYS.DASHBOARD_VIEW }] }
    ]
  },
  rd: {
    title: 'R&D Workspace', roles: ['rd'],
    description: 'Your current stages, tasks that are due, the projects you lead and requests waiting to be assessed.',
    tabs: [{ label: 'Projects', icon: 'clipboardlist', href: 'projects.html' }, { label: 'New request', icon: 'plus', href: 'project-new.html' }],
    nav: [
      { title: 'Workspace', items: [{ label: 'Dashboard', href: 'index.html', icon: 'dashboard' }] },
      { title: 'Projects', items: [
        { label: 'R&D Projects', href: 'projects.html', icon: 'clipboardlist', perm: KEYS.RD_VIEW, also: ['project.html'] },
        { label: 'New R&D Request', href: 'project-new.html', icon: 'plus', perm: KEYS.RD_CREATE } ] },
      { title: 'Master Data', items: [{ label: 'Finished Products', href: 'catalog.html', icon: 'tag', perm: KEYS.CATALOG_VIEW }] }
    ]
  },
  admin: {
    title: 'Administrator Workspace', roles: ['admin'],
    description: 'Accounts, access, master data and integrations.',
    tabs: [{ label: 'Users', icon: 'users', href: 'users.html' }, { label: 'Audit', icon: 'history', href: 'audit.html' }],
    nav: [
      { title: 'Workspace', items: [{ label: 'Dashboard', href: 'index.html', icon: 'dashboard' }] },
      { title: 'Access', items: [
        { label: 'Users', href: 'users.html', icon: 'users', admin: true, also: ['user-access.html'] },
        { label: 'Roles & Permissions', href: 'permissions.html', icon: 'shield', admin: true },
        { label: 'Audit History', href: 'audit.html', icon: 'history', admin: true } ] },
      { title: 'Master Data', items: [
        { label: 'Finished Products', href: 'catalog.html', icon: 'tag', perm: KEYS.CATALOG_VIEW },
        { label: 'Recipes / Bill of Materials', href: 'recipes.html', icon: 'book', perm: KEYS.PRODUCTION_INDENT_VIEW },
        { label: 'Catalogue Review', href: 'catalog-review.html', icon: 'link', perm: KEYS.CATALOG_MAP_ITEMS } ] },
      { title: 'System', items: [{ label: 'Integration Settings', href: 'system.html', icon: 'server', admin: true }] }
    ]
  }
};

// Every other workspace gets an "R&D Projects" entry, shown only to people who may open R&D projects (their own or, with the
// wider permission, all of them).
for (const [id, w] of Object.entries(WORKSPACES)) {
  if (id === 'rd') continue;
  w.nav.splice(1, 0, { title: 'R&D', items: [{ label: 'R&D Projects', href: 'projects.html', icon: 'clipboardlist', perm: KEYS.RD_VIEW, also: ['project.html', 'project-new.html'] }] });
}

/** Workspaces a person is assigned: those that list any of the roles they hold. Switching never adds permissions. */
function workspacesFor(access) {
  return Object.entries(WORKSPACES)
    .filter(([, w]) => w.roles.some(r => access.roles.includes(r)))
    .map(([id, w]) => ({ id, title: w.title, description: w.description }))
    .sort((a, b) => rankOf(a.id) - rankOf(b.id));
}
const ORDER = { admin: 0, manager: 1, rd: 1.5, purchase: 2, accounts: 3, stores: 4, qc: 5, production: 6, branch: 7 };
const rankOf = (id) => (ORDER[id] == null ? 99 : ORDER[id]);

/** The navigation for one workspace, with every entry the person may not use removed. */
function navFor(workspaceId, access) {
  const w = WORKSPACES[workspaceId];
  const allowed = (it) => {
    if (it.admin) return access.isAdmin;
    if (it.perm) return can(access, it.perm);
    if (it.anyPerm) return it.anyPerm.some(k => can(access, k));
    return true;
  };
  return w.nav
    .map(g => ({ title: g.title, items: g.items.filter(allowed).map(i => ({ label: i.label, href: i.href, icon: i.icon, also: i.also || [] })) }))
    .filter(g => g.items.length > 0);
}

// =====================================================================================================
// Builders. Each returns { cards, actions, queue, exceptions, notes }; the caller adds activity and trims.
// =====================================================================================================

const BUILDERS = {};

BUILDERS.purchase = async (ctx) => {
  const cards = [], queue = [], exceptions = [], actions = [];
  const approvedTeam = await team(KEYS.CONSOLIDATE_CREATE_PO);

  if (ctx.can(KEYS.CONSOLIDATE_VIEW)) {
    const rq = requestScope(ctx, KEYS.CONSOLIDATE_VIEW, 'b.branch');
    const reqs = await pool.query(
      `SELECT b.id, b.request_number, b.branch, b.requested_by, to_char(b.delivery_needed_by,'YYYY-MM-DD') AS due,
              (CURRENT_DATE - b.created_at::date) AS waiting, (b.delivery_needed_by < CURRENT_DATE) AS late,
              (SELECT COUNT(*)::int FROM branch_request_items i WHERE i.request_id = b.id) AS lines
         FROM branch_stock_requests b WHERE b.status = 'approved' AND b.planned_indent_id IS NULL${rq.clause}
         ORDER BY b.delivery_needed_by NULLS LAST, b.id`, rq.params);
    const inds = await pool.query(
      `SELECT d.id, d.indent_number, d.production_head, (CURRENT_DATE - d.created_at::date) AS waiting,
              (SELECT to_char(MIN(i.required_by),'YYYY-MM-DD') FROM production_indent_items i WHERE i.indent_id = d.id) AS due,
              (SELECT COUNT(*)::int FROM production_indent_items i WHERE i.indent_id = d.id) AS lines
         FROM production_indents d WHERE d.status = 'approved' ORDER BY d.id`);
    const total = reqs.rowCount + inds.rowCount;
    cards.push(card('requirements', 'Approved requirements to buy', total, 'consolidate.html', total ? 'warn' : 'good',
      'Approved branch requests and indents not yet on a purchase order'));
    const next = ctx.can(KEYS.CONSOLIDATE_CREATE_PO) ? { label: 'Review requirements', href: 'consolidate.html' } : null;
    reqs.rows.forEach(r => queue.push(task({
      type: 'Branch request', number: r.request_number, href: 'consolidate.html', party: r.branch,
      reason: `Approved - ${plural(r.lines, 'item')} waiting to be bought`, responsible: approvedTeam,
      due: r.due, overdue: r.late, waiting_days: r.waiting, progress: 'Approved', next, waiting_on: next ? null : 'Awaiting purchase', tone: r.late ? 'bad' : 'warn' })));
    inds.rows.forEach(d => queue.push(task({
      type: 'Production indent', number: d.indent_number, href: 'consolidate.html', party: d.production_head,
      reason: `Approved - ${plural(d.lines, 'material')} waiting to be bought`, responsible: approvedTeam,
      due: d.due, waiting_days: d.waiting, progress: 'Approved', next, waiting_on: next ? null : 'Awaiting purchase', tone: 'warn' })));
  }

  if (ctx.can(KEYS.PO_VIEW)) {
    const unpaid = await count("SELECT COUNT(*)::int n FROM purchase_orders WHERE status IN ('created','payment_pending')");
    const soon = await countExpected('soon'), late = await countExpected('overdue');
    cards.push(card('unpaid', 'Orders not yet paid', unpaid, 'po-list.html?status=created,payment_pending', unpaid ? 'warn' : 'good', 'Created or payment pending'));
    cards.push(card('due_soon', 'Deliveries due in 7 days', soon, 'expected-deliveries.html?when=soon', 'neutral', 'Orders still waiting for goods'));
    cards.push(card('overdue', 'Overdue supplier deliveries', late, 'expected-deliveries.html?when=overdue', late ? 'bad' : 'good', 'Delivery date has passed'));
    (await expectedDeliveries('overdue', 10)).forEach(p => exceptions.push(task({
      type: 'Purchase order', number: p.po_number, href: 'po-detail.html?id=' + p.id, party: p.supplier_name,
      reason: `Delivery was due ${nice(p.delivery_date)} - ${plural(p.days_late, 'day')} late`, responsible: 'Purchase',
      due: p.delivery_date, overdue: true, waiting_days: p.days_late, progress: word(p.status),
      next: { label: 'Open order', href: 'po-detail.html?id=' + p.id }, tone: 'bad' })));
    (await expectedDeliveries('soon', 10)).forEach(p => queue.push(task({
      type: 'Purchase order', number: p.po_number, href: 'po-detail.html?id=' + p.id, party: p.supplier_name,
      reason: `Delivery due ${nice(p.delivery_date)}`, responsible: 'Purchase', due: p.delivery_date, progress: word(p.status),
      next: { label: 'Open order', href: 'po-detail.html?id=' + p.id }, tone: 'info' })));
  }

  if (ctx.can(KEYS.GRN_VIEW)) {
    const rej = await pool.query(
      `SELECT g.id, g.grn_number, po.po_number, s.name AS supplier_name, (CURRENT_DATE - g.created_at::date) AS waiting
         FROM grn_notes g JOIN purchase_orders po ON po.id = g.po_id JOIN suppliers s ON s.id = po.supplier_id
        WHERE ${REJECTED_WAITING} ORDER BY g.id DESC LIMIT 10`);
    rej.rows.forEach(g => exceptions.push(task({
      type: 'Goods receipt', number: g.grn_number, href: 'grn-detail.html?id=' + g.id, party: g.supplier_name,
      reason: `Rejected at quality check - ${g.po_number} still needs replacement goods`, responsible: 'Purchase',
      waiting_days: g.waiting, progress: 'Rejected', next: { label: 'Open receipt', href: 'grn-detail.html?id=' + g.id }, tone: 'bad' })));
  }
  if (ctx.can(KEYS.THREE_WAY_MATCH_VIEW)) {
    const mm = await pool.query(
      `SELECT m.id, iv.invoice_number, po.id AS po_id, po.po_number, s.name AS supplier_name, m.status, (CURRENT_DATE - m.created_at::date) AS waiting
         FROM three_way_match m JOIN purchase_invoices iv ON iv.id = m.invoice_id JOIN purchase_orders po ON po.id = m.po_id
         JOIN suppliers s ON s.id = po.supplier_id WHERE m.status <> 'matched' ORDER BY m.id DESC LIMIT 10`);
    mm.rows.forEach(m => exceptions.push(task({
      type: 'Invoice', number: m.invoice_number, href: 'po-detail.html?id=' + m.po_id, party: m.supplier_name,
      reason: `Invoice does not match ${m.po_number} (${word(m.status).toLowerCase()})`, responsible: 'Purchase / Accounts',
      waiting_days: m.waiting, progress: word(m.status), next: { label: 'Open order', href: 'po-detail.html?id=' + m.po_id }, tone: 'bad' })));
  }

  if (ctx.can(KEYS.CONSOLIDATE_VIEW)) actions.push({ label: 'Review Requirements', href: 'consolidate.html' });
  if (ctx.can(KEYS.PO_CREATE)) actions.push({ label: 'Create Purchase Order', href: 'po-form.html' });
  return { cards: cards.slice(0, 4), actions, queue, exceptions };
};

BUILDERS.stores = async (ctx) => {
  const cards = [], queue = [], exceptions = [], actions = [];
  if (ctx.can(KEYS.PO_VIEW)) {
    const today = await countExpected('today'), late = await countExpected('overdue');
    cards.push(card('today', 'Expected today', today, 'expected-deliveries.html?when=today', 'neutral', 'Orders due to arrive today'));
    cards.push(card('late', 'Overdue arrivals', late, 'expected-deliveries.html?when=overdue', late ? 'bad' : 'good', 'Delivery date has passed'));
    const arrivals = [...await expectedDeliveries('overdue', 8), ...await expectedDeliveries('soon', 8)];
    const next = ctx.can(KEYS.GRN_CREATE) ? { label: 'Receive goods', href: 'grn-form.html' } : null;
    arrivals.forEach(p => queue.push(task({
      type: 'Purchase order', number: p.po_number, href: 'expected-deliveries.html', party: p.supplier_name,
      reason: p.days_late > 0 ? `Expected ${nice(p.delivery_date)} - ${plural(p.days_late, 'day')} late` : `Expected ${nice(p.delivery_date)}`,
      responsible: 'Stores', due: p.delivery_date, overdue: p.days_late > 0, progress: `0 of ${plural(p.lines, 'item')} received` + (p.earlier_rejected ? ' (an earlier delivery was rejected)' : ''),
      next, waiting_on: next ? null : 'Awaiting delivery', tone: p.days_late > 0 ? 'bad' : 'info' })));
  }
  if (ctx.can(KEYS.GRN_VIEW)) {
    const qc = await pool.query(
      `SELECT g.id, g.grn_number, po.po_number, s.name AS supplier_name, (CURRENT_DATE - g.created_at::date) AS waiting,
              EXISTS (SELECT 1 FROM grn_notes g2 WHERE g2.po_id = g.po_id AND g2.status = 'rejected') AS replacement
         FROM grn_notes g JOIN purchase_orders po ON po.id = g.po_id JOIN suppliers s ON s.id = po.supplier_id
        WHERE g.status = 'pending_qc' ORDER BY g.id`);
    cards.push(card('qc', 'Received, awaiting quality check', qc.rowCount, 'grn-list.html?status=pending_qc', qc.rowCount ? 'warn' : 'good', 'Goods are in; a quality decision is still needed'));
    const qcTeam = await team(KEYS.GRN_APPROVE);
    const decide = ctx.can(KEYS.GRN_APPROVE) ? { label: 'Record quality decision', href: null } : null;
    qc.rows.forEach(g => queue.push(task({
      type: 'Goods receipt', number: g.grn_number, href: 'grn-detail.html?id=' + g.id, party: g.supplier_name,
      reason: g.replacement ? `Replacement for rejected goods on ${g.po_number}` : `Received against ${g.po_number}`,
      responsible: qcTeam, waiting_days: g.waiting, progress: 'Received - awaiting quality check',
      next: decide ? { label: decide.label, href: 'grn-detail.html?id=' + g.id } : null, waiting_on: decide ? null : 'Awaiting quality check', tone: 'warn' })));
    const rej = await pool.query(
      `SELECT g.id, g.grn_number, po.po_number, s.name AS supplier_name, (CURRENT_DATE - g.created_at::date) AS waiting
         FROM grn_notes g JOIN purchase_orders po ON po.id = g.po_id JOIN suppliers s ON s.id = po.supplier_id
        WHERE ${REJECTED_WAITING} ORDER BY g.id DESC`);
    cards.push(card('rejected', 'Rejected, awaiting replacement', rej.rowCount, 'variance-report.html', rej.rowCount ? 'bad' : 'good', 'Rejected goods nothing has replaced yet'));
    rej.rows.forEach(g => exceptions.push(task({
      type: 'Goods receipt', number: g.grn_number, href: 'grn-detail.html?id=' + g.id, party: g.supplier_name,
      reason: `Rejected - ${g.po_number} needs replacement goods`, responsible: 'Purchase (supplier)', waiting_days: g.waiting, progress: 'Rejected',
      next: { label: 'Open receipt', href: 'grn-detail.html?id=' + g.id }, tone: 'bad' })));
  }
  if (ctx.can(KEYS.BRANCH_REQUEST_VIEW)) {
    const rq = requestScope(ctx, KEYS.BRANCH_REQUEST_VIEW, 'b.branch');
    const pend = await pool.query(
      `SELECT b.id, b.request_number, b.branch, b.requested_by, to_char(b.delivery_needed_by,'YYYY-MM-DD') AS due, (b.delivery_needed_by < CURRENT_DATE) AS late,
              (CURRENT_DATE - b.created_at::date) AS waiting
         FROM branch_stock_requests b WHERE b.status = 'pending'${rq.clause} ORDER BY b.delivery_needed_by NULLS LAST, b.id`, rq.params);
    const apprTeam = await team(KEYS.BRANCH_REQUEST_APPROVE);
    const canApprove = ctx.can(KEYS.BRANCH_REQUEST_APPROVE);
    pend.rows.forEach(r => queue.push(task({
      type: 'Branch request', number: r.request_number, href: 'branch-request-detail.html?id=' + r.id, party: r.branch,
      reason: `Requested by ${r.requested_by} - needs approval`, responsible: apprTeam, due: r.due, overdue: r.late, waiting_days: r.waiting, progress: 'Submitted',
      next: canApprove ? { label: 'Review and approve', href: 'branch-request-detail.html?id=' + r.id } : null, waiting_on: canApprove ? null : 'Awaiting approval', tone: r.late ? 'bad' : 'warn' })));
  }
  if (ctx.can(KEYS.GRN_CREATE)) actions.push({ label: 'Receive Goods', href: 'grn-form.html' });
  if (ctx.can(KEYS.PO_VIEW)) actions.push({ label: 'Expected Deliveries', href: 'expected-deliveries.html' });
  return { cards: cards.slice(0, 4), actions, queue, exceptions };
};

BUILDERS.branch = async (ctx) => {
  const cards = [], queue = [], exceptions = [], actions = [];
  if (ctx.can(KEYS.BRANCH_REQUEST_VIEW)) {
    const rq = requestScope(ctx, KEYS.BRANCH_REQUEST_VIEW, 'b.branch');
    const rows = await pool.query(
      `SELECT b.id, b.request_number, b.branch, b.status, to_char(b.delivery_needed_by,'YYYY-MM-DD') AS due, (b.delivery_needed_by < CURRENT_DATE) AS late,
              (CURRENT_DATE - b.created_at::date) AS waiting, b.priority,
              (SELECT COUNT(*)::int FROM branch_request_items i WHERE i.request_id = b.id) AS lines
         FROM branch_stock_requests b WHERE TRUE${rq.clause} ORDER BY b.delivery_needed_by NULLS LAST, b.id DESC`, rq.params);
    const n = (...s) => rows.rows.filter(r => s.includes(r.status)).length;
    cards.push(card('awaiting', 'Awaiting approval', n('pending'), 'branch-request-list.html?status=pending', n('pending') ? 'warn' : 'good', 'Submitted, not yet approved'));
    cards.push(card('progress', 'Approved, being fulfilled', n('approved', 'po_raised'), 'branch-request-list.html?status=approved,po_raised', 'neutral', 'Approved or being prepared'));
    cards.push(card('rejected', 'Rejected', n('rejected'), 'branch-request-list.html?status=rejected', n('rejected') ? 'bad' : 'good', 'Not approved'));
    const decider = await team(KEYS.BRANCH_REQUEST_APPROVE);
    rows.rows.filter(r => r.status !== 'rejected').forEach(r => queue.push(task({
      type: 'Request', number: r.request_number, href: 'branch-request-detail.html?id=' + r.id, party: r.branch,
      reason: r.status === 'pending' ? `${plural(r.lines, 'item')} - waiting for approval` : r.status === 'approved' ? `${plural(r.lines, 'item')} - approved, goods are being arranged` : `${plural(r.lines, 'item')} - being prepared`,
      responsible: r.status === 'pending' ? decider : 'Purchase and production', due: r.due, overdue: r.late && r.status !== 'rejected', waiting_days: r.waiting,
      progress: PROGRESS[r.status], next: { label: 'Open request', href: 'branch-request-detail.html?id=' + r.id }, tone: r.late ? 'bad' : r.status === 'pending' ? 'warn' : 'info' })));
    rows.rows.filter(r => r.status === 'rejected').slice(0, 10).forEach(r => exceptions.push(task({
      type: 'Request', number: r.request_number, href: 'branch-request-detail.html?id=' + r.id, party: r.branch,
      reason: 'This request was not approved', responsible: decider, waiting_days: r.waiting, progress: 'Rejected',
      next: { label: 'Open request', href: 'branch-request-detail.html?id=' + r.id }, tone: 'bad' })));
  }
  if (ctx.can(KEYS.BRANCH_REQUEST_CREATE)) actions.push({ label: 'New Stock Request', href: 'branch-request-form.html' });
  if (ctx.can(KEYS.BRANCH_REQUEST_VIEW)) actions.push({ label: 'Track My Requests', href: 'branch-request-list.html' });
  return { cards: cards.slice(0, 4), actions, queue, exceptions };
};

BUILDERS.production = async (ctx) => {
  const cards = [], queue = [], exceptions = [], actions = [];
  if (ctx.can(KEYS.PRODUCTION_INDENT_VIEW)) {
    const rq = requestScope(ctx, KEYS.PRODUCTION_INDENT_VIEW, 'b.branch');
    const demand = await pool.query(
      `SELECT b.id, b.request_number, b.branch, b.priority, to_char(b.delivery_needed_by,'YYYY-MM-DD') AS due, (b.delivery_needed_by < CURRENT_DATE) AS late,
              (CURRENT_DATE - b.created_at::date) AS waiting,
              (SELECT COUNT(*)::int FROM branch_request_items x WHERE x.request_id = b.id AND x.product_id IS NULL) AS unlinked,
              (SELECT COUNT(*)::int FROM branch_request_items x WHERE x.request_id = b.id AND x.product_id IS NOT NULL AND NOT EXISTS (
                 SELECT 1 FROM recipe_versions rv JOIN bom_lines bl ON bl.recipe_id = rv.id WHERE rv.product_id = x.product_id AND rv.status = 'active')) AS no_recipe
         FROM branch_stock_requests b WHERE b.status = 'approved' AND b.planned_indent_id IS NULL${rq.clause}
         ORDER BY (b.priority = 'urgent') DESC, b.delivery_needed_by NULLS LAST, b.id`, rq.params);
    const blocked = demand.rows.filter(r => r.unlinked + r.no_recipe > 0);
    cards.push(card('demand', 'Approved demand to plan', demand.rowCount, 'material-plan.html', demand.rowCount ? 'warn' : 'good', 'Approved branch requests not yet planned into materials'));
    cards.push(card('blocked', 'Plans blocked', blocked.length, 'material-plan.html', blocked.length ? 'bad' : 'good', 'A product has no recipe, or an item is not linked to a product'));
    const canPlan = ctx.can(KEYS.PRODUCTION_INDENT_CREATE);
    const prodTeam = await team(KEYS.PRODUCTION_INDENT_CREATE);
    demand.rows.forEach(r => {
      const problem = r.unlinked + r.no_recipe > 0;
      const t = task({
        type: 'Branch request', number: r.request_number, href: 'material-plan.html?id=' + r.id, party: r.branch,
        reason: problem ? `Planning blocked: ${[r.unlinked ? plural(r.unlinked, 'item') + ' not linked to a product' : null, r.no_recipe ? plural(r.no_recipe, 'product') + ' with no recipe' : null].filter(Boolean).join(', ')}` : 'Approved - ready to plan materials',
        responsible: prodTeam, due: r.due, overdue: r.late, waiting_days: r.waiting, progress: problem ? 'Blocked' : 'Ready to plan',
        next: canPlan ? { label: problem ? 'Fix and plan' : 'Plan materials', href: 'material-plan.html?id=' + r.id } : null, waiting_on: canPlan ? null : 'Awaiting planning', tone: problem ? 'bad' : (r.late ? 'bad' : 'warn') });
      (problem ? exceptions : queue).push(t);
    });
    const inds = await pool.query(
      `SELECT d.id, d.indent_number, d.status, d.production_head, (CURRENT_DATE - d.created_at::date) AS waiting,
              to_char((SELECT MIN(i.required_by) FROM production_indent_items i WHERE i.indent_id = d.id),'YYYY-MM-DD') AS due,
              ((SELECT MIN(i.required_by) FROM production_indent_items i WHERE i.indent_id = d.id) < CURRENT_DATE) AS late,
              (SELECT po.po_number || '|' || po.status || '|' || COALESCE(to_char(po.delivery_date,'YYYY-MM-DD'),'') FROM po_source_links l
                 JOIN purchase_orders po ON po.id = l.po_id WHERE l.source_type = 'production' AND l.source_id = d.id ORDER BY po.id DESC LIMIT 1) AS linked_po
         FROM production_indents d WHERE d.status IN ('pending','approved','po_raised') ORDER BY d.id DESC`);
    const soon = inds.rows.filter(d => d.status !== 'pending' && d.due && d.due <= new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10));
    cards.push(card('pending_ind', 'Awaiting approval', inds.rows.filter(d => d.status === 'pending').length, 'production-indent-list.html?status=pending', 'neutral', 'Material requirements submitted, not approved'));
    cards.push(card('deadline', 'Requirements due in 7 days', soon.length, 'production-indent-list.html', soon.length ? 'warn' : 'neutral', 'Approved requirements with a required-by date this week'));
    inds.rows.forEach(d => {
      const [poNo, poStatus, poDue] = d.linked_po ? d.linked_po.split('|') : [];
      queue.push(task({
        type: 'Production indent', number: d.indent_number, href: 'production-indent-detail.html?id=' + d.id, party: d.production_head,
        reason: d.status === 'pending' ? 'Waiting for approval' : d.status === 'approved' ? 'Approved - purchasing has not ordered the materials yet' : `Materials ordered on ${poNo}` + (poDue ? ` - expected ${poDue}` : ''),
        responsible: d.status === 'pending' ? 'Approvers' : 'Purchase', due: d.due, overdue: !!d.late && d.status !== 'po_raised', waiting_days: d.waiting,
        progress: d.status === 'po_raised' ? `Ordered (${word(poStatus)})` : word(d.status), next: { label: 'Open requirement', href: 'production-indent-detail.html?id=' + d.id }, tone: d.late ? 'bad' : 'info' }));
    });
  }
  if (ctx.can(KEYS.PRODUCTION_INDENT_VIEW)) actions.push({ label: 'Plan Materials', href: 'material-plan.html' });
  if (ctx.can(KEYS.PRODUCTION_INDENT_CREATE)) actions.push({ label: 'Raise Material Requirement', href: 'production-indent-form.html' });
  return { cards: cards.slice(0, 4), actions, queue, exceptions };
};

BUILDERS.qc = async (ctx) => {
  const cards = [], queue = [], exceptions = [], actions = [];
  if (ctx.can(KEYS.GRN_VIEW)) {
    const pend = await pool.query(
      `SELECT g.id, g.grn_number, g.received_by, po.po_number, s.name AS supplier_name, (CURRENT_DATE - g.created_at::date) AS waiting,
              EXISTS (SELECT 1 FROM grn_notes g2 WHERE g2.po_id = g.po_id AND g2.status = 'rejected') AS replacement
         FROM grn_notes g JOIN purchase_orders po ON po.id = g.po_id JOIN suppliers s ON s.id = po.supplier_id
        WHERE g.status = 'pending_qc' ORDER BY g.id`);
    const rej = await pool.query(
      `SELECT g.id, g.grn_number, po.po_number, s.name AS supplier_name, (CURRENT_DATE - g.created_at::date) AS waiting
         FROM grn_notes g JOIN purchase_orders po ON po.id = g.po_id JOIN suppliers s ON s.id = po.supplier_id WHERE ${REJECTED_WAITING} ORDER BY g.id DESC`);
    const done = await count("SELECT COUNT(*)::int n FROM grn_notes WHERE status IN ('approved','rejected')");
    const repl = pend.rows.filter(g => g.replacement).length;
    cards.push(card('awaiting', 'Awaiting inspection', pend.rowCount, 'grn-list.html?status=pending_qc', pend.rowCount ? 'warn' : 'good', 'Received, no quality decision yet'));
    cards.push(card('replacements', 'Replacements to inspect', repl, 'grn-list.html?status=pending_qc', repl ? 'warn' : 'neutral', 'Goods sent in place of rejected ones'));
    cards.push(card('rejected', 'Rejected, awaiting replacement', rej.rowCount, 'variance-report.html', rej.rowCount ? 'bad' : 'good', 'Nothing has replaced them yet'));
    cards.push(card('decided', 'Decisions recorded', done, 'grn-list.html?status=approved,rejected', 'neutral', 'Approved or rejected receipts'));
    const canDecide = ctx.can(KEYS.GRN_APPROVE);
    pend.rows.forEach(g => queue.push(task({
      type: 'Goods receipt', number: g.grn_number, href: 'grn-detail.html?id=' + g.id, party: g.supplier_name,
      reason: g.replacement ? `Replacement goods for ${g.po_number}` : `Received by ${g.received_by} against ${g.po_number}`, responsible: 'Quality check',
      waiting_days: g.waiting, progress: 'Received - awaiting inspection',
      next: canDecide ? { label: 'Inspect receipt', href: 'grn-detail.html?id=' + g.id } : null, waiting_on: canDecide ? null : 'Awaiting inspection', tone: 'warn' })));
    rej.rows.forEach(g => exceptions.push(task({
      type: 'Goods receipt', number: g.grn_number, href: 'grn-detail.html?id=' + g.id, party: g.supplier_name,
      reason: `Rejected - waiting for replacement goods on ${g.po_number}`, responsible: 'Purchase (supplier)', waiting_days: g.waiting, progress: 'Rejected',
      next: { label: 'Open receipt', href: 'grn-detail.html?id=' + g.id }, tone: 'bad' })));
    actions.push({ label: 'Inspect Receipt', href: 'grn-list.html?status=pending_qc' });
    actions.push({ label: 'Rejections & Replacements', href: 'variance-report.html' });
  }
  return { cards: cards.slice(0, 4), actions, queue, exceptions };
};

BUILDERS.accounts = async (ctx) => {
  const cards = [], queue = [], exceptions = [], actions = [];
  if (ctx.can(KEYS.PAYMENT_VIEW_ALL)) {
    const pay = await pool.query(
      `SELECT p.id, p.payment_id, p.po_id, p.amount, po.po_number, s.name AS supplier_name, u.name AS entered_by, (CURRENT_DATE - p.created_at::date) AS waiting
         FROM payments p JOIN purchase_orders po ON po.id = p.po_id JOIN suppliers s ON s.id = p.supplier_id LEFT JOIN users u ON u.id = p.created_by
        WHERE p.status = 'initiated' ORDER BY p.id`);
    cards.push(card('confirm', 'Payments awaiting confirmation', pay.rowCount, 'payment-list.html?status=initiated', pay.rowCount ? 'warn' : 'good', 'Recorded, not yet confirmed by an approver'));
    const canConfirm = ctx.can(KEYS.PAYMENT_APPROVE);
    const approvers = await team(KEYS.PAYMENT_APPROVE);
    pay.rows.forEach(p => queue.push(task({
      type: 'Payment', number: p.payment_id, href: 'payment-list.html', party: p.supplier_name,
      reason: (ctx.fa.prices ? `${inr(p.amount)} advance` : 'Advance') + ` for ${p.po_number}, entered by ${p.entered_by || 'unknown'}`, responsible: approvers, waiting_days: p.waiting, progress: 'Awaiting confirmation',
      next: canConfirm ? { label: 'Confirm payment', href: 'payment-list.html' } : null, waiting_on: canConfirm ? null : 'Awaiting approval', tone: 'warn' })));
    if (ctx.fa.prices) {
      const adv = await pool.query(
        `SELECT COALESCE(SUM(p.amount),0) AS v, COUNT(*)::int n FROM payments p
          WHERE p.status = 'confirmed' AND NOT EXISTS (SELECT 1 FROM grn_notes g WHERE g.po_id = p.po_id AND g.status <> 'rejected')`);
      cards.push(card('advances', 'Outstanding advances', inr(adv.rows[0].v), 'payment-list.html', adv.rows[0].n ? 'warn' : 'good', `${plural(adv.rows[0].n, 'payment')} paid, goods not received yet`));
    }
  }
  if (ctx.can(KEYS.PO_VIEW)) {
    const unpaid = await pool.query(
      `SELECT po.id, po.po_number, s.name AS supplier_name, (CURRENT_DATE - po.created_at::date) AS waiting, po.status
         FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
        WHERE po.status IN ('created','payment_pending') ORDER BY po.id`);
    cards.push(card('unpaid', 'Orders awaiting payment', unpaid.rowCount, 'po-list.html?status=created,payment_pending', unpaid.rowCount ? 'warn' : 'good', 'Created or payment pending'));
    const canPay = ctx.can(KEYS.PAYMENT_CREATE);
    unpaid.rows.forEach(p => queue.push(task({
      type: 'Purchase order', number: p.po_number, href: 'po-detail.html?id=' + p.id, party: p.supplier_name, reason: 'Order raised - payment not yet recorded as done',
      responsible: 'Accounts', waiting_days: p.waiting, progress: word(p.status),
      next: canPay ? { label: 'Record payment', href: 'payment-form.html' } : { label: 'Open order', href: 'po-detail.html?id=' + p.id }, tone: 'info' })));
  }
  if (ctx.can(KEYS.INVOICE_VIEW)) {
    const up = await pool.query(
      `SELECT iv.invoice_number, po.id AS po_id, po.po_number, s.name AS supplier_name, (CURRENT_DATE - iv.created_at::date) AS waiting
         FROM purchase_invoices iv JOIN purchase_orders po ON po.id = iv.po_id JOIN suppliers s ON s.id = po.supplier_id WHERE iv.status = 'uploaded' ORDER BY iv.id`);
    const canMatch = ctx.can(KEYS.INVOICE_MATCH);
    up.rows.forEach(i => queue.push(task({
      type: 'Invoice', number: i.invoice_number, href: 'po-detail.html?id=' + i.po_id, party: i.supplier_name, reason: `Received for ${i.po_number} - not yet matched`,
      responsible: 'Accounts', waiting_days: i.waiting, progress: 'Invoice received',
      next: canMatch ? { label: 'Review invoice', href: 'po-detail.html?id=' + i.po_id } : null, waiting_on: canMatch ? null : 'Awaiting matching', tone: 'warn' })));
  }
  if (ctx.can(KEYS.THREE_WAY_MATCH_VIEW)) {
    const mm = await pool.query(
      `SELECT iv.invoice_number, po.id AS po_id, po.po_number, s.name AS supplier_name, m.status, (CURRENT_DATE - m.created_at::date) AS waiting
         FROM three_way_match m JOIN purchase_invoices iv ON iv.id = m.invoice_id JOIN purchase_orders po ON po.id = m.po_id JOIN suppliers s ON s.id = po.supplier_id
        WHERE m.status <> 'matched' ORDER BY m.id DESC`);
    cards.push(card('mismatch', 'Invoice issues', mm.rowCount, 'variance-report.html', mm.rowCount ? 'bad' : 'good', 'Invoices that do not match the order and receipt'));
    mm.rows.forEach(m => exceptions.push(task({
      type: 'Invoice', number: m.invoice_number, href: 'po-detail.html?id=' + m.po_id, party: m.supplier_name, reason: `Does not match ${m.po_number} (${word(m.status).toLowerCase()})`,
      responsible: 'Accounts', waiting_days: m.waiting, progress: word(m.status), next: { label: 'Open order', href: 'po-detail.html?id=' + m.po_id }, tone: 'bad' })));
  }
  if (ctx.can(KEYS.PAYMENT_CREATE)) actions.push({ label: 'Record Payment', href: 'payment-form.html' });
  if (ctx.can(KEYS.PAYMENT_VIEW_ALL)) actions.push({ label: 'Review Payments', href: 'payment-list.html' });
  return { cards: cards.slice(0, 4), actions, queue, exceptions,
    notes: ctx.can(KEYS.TALLY_VIEW_LOG) ? [{ label: 'Tally', state: 'Test mode', detail: 'Records are logged on this server. Nothing is sent to Tally yet.' }] : [] };
};

/** Everything this person may decide, with enough context to decide it. Used by the manager dashboard, the approvals page and notifications. */
async function approvalItems(ctx) {
  const out = [];
  const decisions = async (entity, id) => (await pool.query(
    `SELECT actor_name, summary, to_char(at,'YYYY-MM-DD') AS on_day FROM audit_log WHERE entity = $1 AND entity_id = $2 ORDER BY at DESC LIMIT 3`, [entity, id])).rows;
  if (ctx.can(KEYS.BRANCH_REQUEST_APPROVE)) {
    const rq = requestScope(ctx, KEYS.BRANCH_REQUEST_APPROVE, 'b.branch');
    const r = await pool.query(
      `SELECT b.id, b.request_number, b.branch, b.requested_by, b.priority, to_char(b.delivery_needed_by,'YYYY-MM-DD') AS due, (b.delivery_needed_by < CURRENT_DATE) AS late,
              (CURRENT_DATE - b.created_at::date) AS waiting, (SELECT COUNT(*)::int FROM branch_request_items i WHERE i.request_id = b.id) AS lines,
              (SELECT COALESCE(SUM(i.quantity),0)::float FROM branch_request_items i WHERE i.request_id = b.id) AS qty
         FROM branch_stock_requests b WHERE b.status = 'pending'${rq.clause} ORDER BY b.delivery_needed_by NULLS LAST, b.id`, rq.params);
    for (const x of r.rows) out.push({ ...task({ type: 'Branch request', number: x.request_number, href: 'branch-request-detail.html?id=' + x.id, party: x.branch,
      reason: `Needs approval${x.priority === 'urgent' ? ' (urgent)' : ''}`, responsible: 'You', due: x.due, overdue: x.late, waiting_days: x.waiting, progress: 'Submitted',
      next: { label: 'Review', href: 'branch-request-detail.html?id=' + x.id }, tone: x.late || x.priority === 'urgent' ? 'bad' : 'warn' }),
      context: { requester: x.requested_by, source: 'Branch ' + x.branch, quantity: `${plural(x.lines, 'item')}, ${x.qty} units in total`, required: x.due, previous: await decisions('branch_request', x.id) } });
  }
  if (ctx.can(KEYS.PRODUCTION_INDENT_APPROVE)) {
    const r = await pool.query(
      `SELECT d.id, d.indent_number, d.production_head, (CURRENT_DATE - d.created_at::date) AS waiting,
              to_char((SELECT MIN(i.required_by) FROM production_indent_items i WHERE i.indent_id = d.id),'YYYY-MM-DD') AS due,
              ((SELECT MIN(i.required_by) FROM production_indent_items i WHERE i.indent_id = d.id) < CURRENT_DATE) AS late,
              (SELECT COUNT(*)::int FROM production_indent_items i WHERE i.indent_id = d.id) AS lines
         FROM production_indents d WHERE d.status = 'pending' ORDER BY d.id`);
    for (const x of r.rows) out.push({ ...task({ type: 'Production indent', number: x.indent_number, href: 'production-indent-detail.html?id=' + x.id, party: 'Production',
      reason: 'Material requirement needs approval', responsible: 'You', due: x.due, overdue: !!x.late, waiting_days: x.waiting, progress: 'Submitted',
      next: { label: 'Review', href: 'production-indent-detail.html?id=' + x.id }, tone: x.late ? 'bad' : 'warn' }),
      context: { requester: x.production_head, source: 'Production', quantity: plural(x.lines, 'material'), required: x.due, previous: await decisions('production_indent', x.id) } });
  }
  if (ctx.can(KEYS.PAYMENT_APPROVE)) {
    const r = await pool.query(
      `SELECT p.id, p.payment_id, p.amount, po.po_number, s.name AS supplier_name, u.name AS entered_by, (CURRENT_DATE - p.created_at::date) AS waiting
         FROM payments p JOIN purchase_orders po ON po.id = p.po_id JOIN suppliers s ON s.id = p.supplier_id LEFT JOIN users u ON u.id = p.created_by WHERE p.status = 'initiated' ORDER BY p.id`);
    for (const x of r.rows) out.push({ ...task({ type: 'Payment', number: x.payment_id, href: 'payment-list.html', party: x.supplier_name,
      reason: `Advance for ${x.po_number} needs confirmation`, responsible: 'You', waiting_days: x.waiting, progress: 'Awaiting confirmation',
      next: { label: 'Review', href: 'payment-list.html' }, tone: 'warn' }),
      context: { requester: x.entered_by || 'unknown', source: `Order ${x.po_number}`, quantity: ctx.fa.prices ? inr(x.amount) : null, required: null, previous: await decisions('payment', x.id) } });
  }
  if (ctx.can(KEYS.GRN_APPROVE)) {
    const r = await pool.query(
      `SELECT g.id, g.grn_number, g.received_by, po.po_number, s.name AS supplier_name, (CURRENT_DATE - g.created_at::date) AS waiting
         FROM grn_notes g JOIN purchase_orders po ON po.id = g.po_id JOIN suppliers s ON s.id = po.supplier_id WHERE g.status = 'pending_qc' ORDER BY g.id`);
    for (const x of r.rows) out.push({ ...task({ type: 'Goods receipt', number: x.grn_number, href: 'grn-detail.html?id=' + x.id, party: x.supplier_name,
      reason: `Received against ${x.po_number} - needs a quality decision`, responsible: 'You', waiting_days: x.waiting, progress: 'Awaiting quality check',
      next: { label: 'Review', href: 'grn-detail.html?id=' + x.id }, tone: 'warn' }),
      context: { requester: x.received_by, source: `Order ${x.po_number}`, quantity: null, required: null, previous: await decisions('grn', x.id) } });
  }
  return out.sort(byUrgency);
}

BUILDERS.manager = async (ctx) => {
  const cards = [], queue = [], exceptions = [], actions = [];
  const approvals = await approvalItems(ctx);
  if (ctx.access.isAdmin || ['BRANCH_REQUEST_APPROVE', 'PRODUCTION_INDENT_APPROVE', 'PAYMENT_APPROVE', 'GRN_APPROVE'].some(k => ctx.can(KEYS[k]))) {
    cards.push(card('approvals', 'Approvals waiting', approvals.length, 'approvals.html', approvals.length ? 'warn' : 'good', 'Decisions that are yours to make'));
    approvals.forEach(a => queue.push(a));
    actions.push({ label: 'Review Approvals', href: 'approvals.html' });
  }
  if (ctx.can(KEYS.PO_VIEW)) {
    const late = await countExpected('overdue');
    cards.push(card('overdue', 'Overdue supplier deliveries', late, 'expected-deliveries.html?when=overdue', late ? 'bad' : 'good', 'Delivery date has passed'));
    (await expectedDeliveries('overdue', 10)).forEach(p => exceptions.push(task({
      type: 'Purchase order', number: p.po_number, href: 'po-detail.html?id=' + p.id, party: p.supplier_name,
      reason: `Delivery was due ${nice(p.delivery_date)} - ${plural(p.days_late, 'day')} late`, responsible: 'Purchase', due: p.delivery_date, overdue: true, waiting_days: p.days_late,
      progress: word(p.status), next: { label: 'Open order', href: 'po-detail.html?id=' + p.id }, tone: 'bad' })));
  }
  if (ctx.can(KEYS.GRN_VIEW)) {
    const rej = await pool.query(
      `SELECT g.id, g.grn_number, po.po_number, s.name AS supplier_name, (CURRENT_DATE - g.created_at::date) AS waiting
         FROM grn_notes g JOIN purchase_orders po ON po.id = g.po_id JOIN suppliers s ON s.id = po.supplier_id WHERE ${REJECTED_WAITING} ORDER BY g.id DESC`);
    const disc = await count('SELECT COUNT(DISTINCT grn_id)::int n FROM grn_items WHERE variance <> 0');
    const inv = ctx.can(KEYS.THREE_WAY_MATCH_VIEW) ? await count("SELECT COUNT(*)::int n FROM three_way_match WHERE status <> 'matched'") : 0;
    cards.push(card('exceptions', 'Exceptions', rej.rowCount + disc + inv, 'variance-report.html', rej.rowCount + disc + inv ? 'bad' : 'good', 'Rejected goods, quantity differences and invoice mismatches'));
    rej.rows.forEach(g => exceptions.push(task({
      type: 'Goods receipt', number: g.grn_number, href: 'grn-detail.html?id=' + g.id, party: g.supplier_name, reason: `Rejected - ${g.po_number} still needs replacement goods`,
      responsible: 'Purchase', waiting_days: g.waiting, progress: 'Rejected', next: { label: 'Open receipt', href: 'grn-detail.html?id=' + g.id }, tone: 'bad' })));
    actions.push({ label: 'Review Exceptions', href: 'variance-report.html' });
  }
  // Purchase spending for a period the viewer chooses. Only for people who may see money.
  let controls = [];
  if (ctx.fa.prices && ctx.can(KEYS.PO_VIEW)) {
    const period = ['month', 'quarter', 'year'].includes(ctx.period) ? ctx.period : 'month';
    const span = { month: "date_trunc('month', CURRENT_DATE)", quarter: "date_trunc('quarter', CURRENT_DATE)", year: "date_trunc('year', CURRENT_DATE)" }[period];
    const unit = { month: '1 month', quarter: '3 months', year: '1 year' }[period];
    const r = await pool.query(
      `SELECT COALESCE(SUM(total_amount),0) AS v, COUNT(*)::int n, to_char(${span}::date,'DD Mon YYYY') AS from_day, to_char((${span} + INTERVAL '${unit}' - INTERVAL '1 day')::date,'DD Mon YYYY') AS to_day
         FROM purchase_orders WHERE po_date >= ${span}::date AND po_date < (${span} + INTERVAL '${unit}')::date`);
    cards.push(card('spend', 'Purchase orders raised', inr(r.rows[0].v), 'po-list.html', 'neutral', `${plural(r.rows[0].n, 'order')}, ${r.rows[0].from_day} to ${r.rows[0].to_day}`));
    controls = [{ name: 'period', label: 'Period', value: period, options: [{ value: 'month', label: 'This month' }, { value: 'quarter', label: 'This quarter' }, { value: 'year', label: 'This year' }] }];
  }
  // R&D at a glance (only for people who may open every project)
  const extra = [];
  if (ctx.can(KEYS.RD_VIEW_ALL)) {
    const vis = visibleClause(ctx.access, ctx.user.id, 'p', 0);
    const n = (sql, extraParams) => count(`SELECT COUNT(*)::int n FROM rd_projects p WHERE ${vis.clause} AND ${sql}`, [...vis.params, ...(extraParams || [])]);
    extra.push(card('rd_active', 'Active R&D projects', await n('p.status = ANY($5)', [RD.ACTIVE_STATUSES]), 'projects.html?scope=active', 'neutral', 'Received up to plant trial; On Hold is counted separately'));
    const overdue = await n(`EXISTS (SELECT 1 FROM rd_stages s WHERE s.project_id = p.id AND s.completed_at IS NULL AND s.planned_date < ${IST_TODAY}) AND p.status = ANY($5)`, [RD.ACTIVE_STATUSES]);
    extra.push(card('rd_overdue', 'Projects with overdue stages', overdue, 'projects.html?scope=active&overdue=1', overdue ? 'bad' : 'good', 'At least one stage is past its planned date'));
    const received = await n("p.status = 'Received'");
    extra.push(card('rd_received', 'R&D requests awaiting review', received, 'projects.html?scope=active&status=Received', received ? 'warn' : 'good', 'Submitted, not yet reviewed'));
    const year = Number((await pool.query("SELECT EXTRACT(YEAR FROM (now() AT TIME ZONE 'Asia/Kolkata'))::int y")).rows[0].y);
    extra.push(card('rd_done', 'R&D projects completed this year', await n("p.status = 'Completed' AND EXTRACT(YEAR FROM p.completed_on) = $5", [year]), 'projects.html?scope=closed&status=Completed&year=' + year, 'good', 'Calendar year ' + year));
  }
  return { cards: cards.slice(0, 4), extra_cards: extra, actions: actions.slice(0, 3), queue, exceptions, controls };
};

// ---------- R&D ----------
const IST_TODAY = "(now() AT TIME ZONE 'Asia/Kolkata')::date";
const ymdOf = (v) => (v == null ? null : (typeof v === 'string' ? v.slice(0, 10) : v.getFullYear() + '-' + String(v.getMonth() + 1).padStart(2, '0') + '-' + String(v.getDate()).padStart(2, '0')));

BUILDERS.rd = async (ctx) => {
  const cards = [], queue = [], exceptions = [], actions = [];
  if (!ctx.can(KEYS.RD_VIEW)) return { cards, actions, queue, exceptions };
  const uid = ctx.user.id;
  const vis = visibleClause(ctx.access, uid, 'p', 0);
  const active = RD.ACTIVE_STATUSES;

  // current stage (first incomplete) of every active project, with who owns it (explicit owner, else the lead)
  const stages = await pool.query(
    `SELECT p.id, p.project_number, p.title, p.priority, s.stage_no, s.planned_date, COALESCE(s.owner_user_id, p.lead_user_id) AS owner_id,
            (${IST_TODAY} - s.planned_date) AS days_late
       FROM rd_projects p JOIN rd_stages s ON s.project_id = p.id AND s.stage_no = (SELECT MIN(x.stage_no) FROM rd_stages x WHERE x.project_id = p.id AND x.completed_at IS NULL)
      WHERE ${vis.clause} AND p.status = ANY($5) ORDER BY s.planned_date NULLS LAST, p.id`, [...vis.params, active]);
  const mine = stages.rows.filter(r => r.owner_id === uid);
  cards.push(card('stages', 'My current stages', mine.length, 'projects.html?mine=1', mine.some(r => r.days_late > 0) ? 'warn' : 'neutral', 'Stages that are the next step on projects where you are the owner'));
  mine.forEach(r => queue.push(task({
    type: 'Stage ' + r.stage_no, number: r.project_number, href: 'project.html?id=' + r.id, party: r.title,
    reason: `${RD.STAGES[r.stage_no - 1].name} is the current stage`, responsible: 'You', due: ymdOf(r.planned_date), overdue: r.days_late > 0,
    waiting_days: r.days_late > 0 ? r.days_late : null, progress: `Stage ${r.stage_no} of 8`, next: { label: 'Open project', href: 'project.html?id=' + r.id }, tone: r.days_late > 0 ? 'bad' : 'info' })));

  const tasks = await pool.query(
    `SELECT t.id, t.title, t.status, t.priority, t.due_date, t.project_id, p.project_number, (${IST_TODAY} - t.due_date) AS days_late
       FROM rd_tasks t JOIN rd_projects p ON p.id = t.project_id
      WHERE ${vis.clause} AND t.assignee_id = $1 AND t.status <> 'done' AND (t.due_date <= ${IST_TODAY} OR t.status = 'blocked')
      ORDER BY t.due_date NULLS LAST, t.id`, vis.params);
  const dueNow = tasks.rows.filter(t => t.due_date && t.days_late >= 0);
  cards.push(card('tasks', 'My tasks due or overdue', dueNow.length, 'projects.html?mine=1', dueNow.some(t => t.days_late > 0) ? 'bad' : 'neutral', 'Open tasks assigned to you that are due today or late'));
  tasks.rows.forEach(t => (t.status === 'blocked' ? exceptions : queue).push(task({
    type: 'Task', number: t.project_number, href: 'project.html?id=' + t.project_id, party: t.title,
    reason: t.status === 'blocked' ? 'Task is blocked' : t.days_late > 0 ? `Due ${nice(ymdOf(t.due_date))} - ${plural(t.days_late, 'day')} late` : 'Due today',
    responsible: 'You', due: ymdOf(t.due_date), overdue: t.days_late > 0, waiting_days: t.days_late > 0 ? t.days_late : null, progress: t.status === 'blocked' ? 'Blocked' : 'To do',
    next: { label: 'Open project', href: 'project.html?id=' + t.project_id }, tone: t.status === 'blocked' || t.days_late > 0 ? 'bad' : 'warn' })));

  const led = await count(`SELECT COUNT(*)::int n FROM rd_projects p WHERE ${vis.clause} AND p.lead_user_id = $1 AND p.status = ANY($5)`, [...vis.params, active]);
  cards.push(card('led', 'Projects I lead', led, 'projects.html?lead=' + uid, 'neutral', 'Active projects where you are the lead'));

  const received = await pool.query(
    `SELECT p.id, p.project_number, p.title, p.priority, p.department, p.feasibility, p.lead_user_id, (${IST_TODAY} - p.request_date) AS waiting
       FROM rd_projects p WHERE ${vis.clause} AND p.status = 'Received' ORDER BY (p.priority = 'High') DESC, p.request_date, p.id`, vis.params);
  cards.push(card('received', 'Requests to assess', received.rowCount, 'projects.html?scope=active&status=Received', received.rowCount ? 'warn' : 'good', 'Submitted requests that have not been reviewed yet'));
  const canEdit = ctx.can(KEYS.RD_EDIT);
  received.rows.forEach(r => queue.push(task({
    type: 'R&D request', number: r.project_number, href: 'project.html?id=' + r.id, party: r.title,
    reason: `${r.priority || 'Medium'} priority request from ${r.department || 'unknown department'} - not yet assessed`, responsible: 'R&D', waiting_days: r.waiting, progress: 'Received',
    next: canEdit ? { label: 'Assess', href: 'project.html?id=' + r.id } : null, waiting_on: canEdit ? null : 'Awaiting assessment', tone: r.priority === 'High' ? 'bad' : 'warn' })));

  // problems across every project this person can see
  const late = stages.rows.filter(r => r.days_late > 0);
  late.slice(0, 10).forEach(r => exceptions.push(task({
    type: 'Overdue stage', number: r.project_number, href: 'project.html?id=' + r.id, party: r.title, reason: `Stage ${r.stage_no} "${RD.STAGES[r.stage_no - 1].name}" was due ${nice(ymdOf(r.planned_date))}`,
    responsible: 'Project lead', due: ymdOf(r.planned_date), overdue: true, waiting_days: r.days_late, progress: `Stage ${r.stage_no} of 8`, next: { label: 'Open project', href: 'project.html?id=' + r.id }, tone: 'bad' })));
  const info = await pool.query(`SELECT p.id, p.project_number, p.title FROM rd_projects p WHERE ${vis.clause} AND p.status = ANY($5) AND p.feasibility = 'Needs More Information'`, [...vis.params, active]);
  info.rows.forEach(r => exceptions.push(task({ type: 'Missing information', number: r.project_number, href: 'project.html?id=' + r.id, party: r.title,
    reason: 'Assessed as needing more information from the requester', responsible: 'R&D and requester', progress: 'Needs more information', next: { label: 'Open project', href: 'project.html?id=' + r.id }, tone: 'warn' })));

  if (ctx.can(KEYS.RD_CREATE)) actions.push({ label: 'New R&D Request', href: 'project-new.html' });
  actions.push({ label: 'Open Projects', href: 'projects.html' });
  return { cards: cards.slice(0, 4), actions, queue, exceptions };
};

BUILDERS.admin = async (ctx) => {
  const cards = [], queue = [], exceptions = [], actions = [];
  if (!ctx.access.isAdmin) return { cards, actions, queue, exceptions };
  const noAccess = await pool.query(
    `SELECT u.id, u.username, u.name, (CURRENT_DATE - u.created_at::date) AS waiting FROM users u
      WHERE u.active AND NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role = 'admin')
        AND NOT EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role = ur.role WHERE ur.user_id = u.id)`);
  cards.push(card('access', 'Accounts with no access', noAccess.rowCount, 'users.html', noAccess.rowCount ? 'warn' : 'good', 'Active accounts whose roles grant no permission'));
  noAccess.rows.forEach(u => queue.push(task({ type: 'Account', number: u.username, href: 'user-access.html?id=' + u.id, party: u.name,
    reason: 'Active, but none of its roles grants any permission', responsible: 'Administrator', waiting_days: u.waiting, progress: 'Needs review',
    next: { label: 'Review access', href: 'user-access.html?id=' + u.id }, tone: 'warn' })));
  const unmapped = await count("SELECT COUNT(*)::int n FROM branch_request_items WHERE mapping_status = 'needs_review' AND product_id IS NULL");
  cards.push(card('unlinked', 'Request items to link', unmapped, 'catalog-review.html', unmapped ? 'warn' : 'good', 'Older free-text items waiting for a catalogue product'));
  if (unmapped) queue.push(task({ type: 'Catalogue', number: plural(unmapped, 'item'), href: 'catalog-review.html', reason: 'Request items are not linked to a catalogue product, so their recipes cannot be found',
    responsible: 'Administrator', progress: 'Needs review', next: { label: 'Review catalogue', href: 'catalog-review.html' }, tone: 'warn' }));
  const norecipe = await pool.query(
    `SELECT p.id, p.code, p.name FROM products p WHERE p.active AND NOT EXISTS (
       SELECT 1 FROM recipe_versions rv JOIN bom_lines bl ON bl.recipe_id = rv.id WHERE rv.product_id = p.id AND rv.status = 'active') ORDER BY p.code`);
  cards.push(card('norecipe', 'Products without a recipe', norecipe.rowCount, 'recipes.html', norecipe.rowCount ? 'warn' : 'good', 'Requests for these cannot be planned'));
  norecipe.rows.slice(0, 8).forEach(p => queue.push(task({ type: 'Product', number: p.code || '-', href: 'recipes.html', party: p.name,
    reason: 'No active recipe - material planning is blocked for this product', responsible: 'Administrator', progress: 'Missing master data',
    next: { label: 'Open recipes', href: 'recipes.html' }, tone: 'warn' })));
  const offline = [!emailOn() && 'Email alerts', !whatsappOn() && 'WhatsApp alerts', 'Tally export'].filter(Boolean);
  cards.push(card('integrations', 'Integrations not live', offline.length, 'system.html', offline.length ? 'warn' : 'good', offline.join(', ')));
  const notes = [
    { label: 'Email alerts', state: emailOn() ? 'On' : 'Not configured', detail: emailOn() ? 'Alerts are sent by email.' : 'Nothing is sent until SMTP settings are added on the server.' },
    { label: 'WhatsApp alerts', state: whatsappOn() ? 'On' : 'Not configured', detail: whatsappOn() ? 'Alerts are sent through WhatsApp.' : 'Nothing is sent until the WhatsApp settings are added on the server.' },
    { label: 'Tally', state: 'Test mode', detail: 'Records are logged on this server. Nothing is sent to Tally yet.' }
  ];
  actions.push({ label: 'Manage Users', href: 'users.html' }, { label: 'Review Catalogue', href: 'catalog-review.html' });
  return { cards: cards.slice(0, 4), actions, queue, exceptions, notes };
};

// =====================================================================================================
// Public entry points
// =====================================================================================================

function contextFor(req, extra) {
  return {
    access: req.access, user: req.user, fa: fieldAccess(req.access),
    can: (key) => can(req.access, key), scope: (key) => branchScope(req.access, key), ...(extra || {})
  };
}

async function buildDashboard(req, workspaceId, opts) {
  const ctx = contextFor(req, opts);
  const w = WORKSPACES[workspaceId];
  const built = await BUILDERS[workspaceId](ctx);
  const sort = (list) => list.sort(byUrgency);
  return {
    workspace: { id: workspaceId, title: w.title, description: w.description },
    cards: built.cards, extra_cards: built.extra_cards || [], actions: built.actions.slice(0, 3),
    queue: { total: built.queue.length, items: sort(built.queue).slice(0, MAX_QUEUE) },
    exceptions: { total: built.exceptions.length, items: sort(built.exceptions).slice(0, MAX_QUEUE) },
    activity: await recentActivity(ctx, ACTIVITY_KINDS[workspaceId] || []),
    notes: built.notes || [], controls: built.controls || [],
    generated_at: new Date().toISOString()
  };
}

/** What needs this person's attention across every workspace they hold - only things they may act on, each once. */
async function buildNotifications(req) {
  const ctx = contextFor(req);
  const seen = new Set(), out = [];
  for (const ws of workspacesFor(req.access)) {
    const built = await BUILDERS[ws.id](ctx);
    for (const t of [...built.queue, ...built.exceptions]) {
      if (!t.next) continue; // nothing this person can do about it
      const key = t.type + '|' + t.number;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ type: t.type, number: t.number, text: `${t.type} ${t.number}: ${t.reason}`, href: t.next.href || t.href, overdue: t.overdue, tone: t.tone, due: t.due, waiting_days: t.waiting_days });
    }
  }
  return out.sort((a, b) => (a.overdue === b.overdue ? 0 : a.overdue ? -1 : 1) || (b.waiting_days || 0) - (a.waiting_days || 0)).slice(0, 20);
}

module.exports = { WORKSPACES, workspacesFor, navFor, buildDashboard, buildNotifications, approvalItems, contextFor, expectedDeliveries, expectedWhere, countExpected, ROLE_NAMES };
