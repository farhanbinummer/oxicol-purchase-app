// Workspace and access tests: a real server on its own port against the configured database.
//   npm run test:workspaces
// These check DATA ACCESS, not just menus: every role's dashboard, lists, counts, search, notifications and
// direct API calls are exercised with real sessions. Everything the tests create (users, a supplier, purchase
// orders, receipts, payments, invoices, requests) is removed afterwards; permission edits made during the run are
// restored. Users get random passwords that are never printed.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool } = require('../database');
const { createSession } = require('../auth');
const { runMigrations } = require('../migrate');
const { KEYS } = require('../permissions');

const PORT = 3298, BASE = `http://localhost:${PORT}`;
const TAG = 'ZZW' + crypto.randomBytes(3).toString('hex').toUpperCase();
const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const made = { users: [], pos: [], grns: [], payments: [], invoices: [], requests: [], indents: [], supplier: null };
let server; const tok = {}; const me = {}; let productId, supplierId; const ids = {};

async function api(token, method, url, body) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = {}; try { json = await res.json(); } catch (e) {}
  return { status: res.status, ...json };
}

/** A temporary person with one or more roles and (optionally) the branches each covers. */
async function mkUser(label, roles, scopes = {}, password) {
  const username = `${TAG.toLowerCase()}_${label}`;
  const hash = await bcrypt.hash(password || crypto.randomBytes(16).toString('hex'), 4);
  const { primaryRole } = require('../access');
  const primary = primaryRole(roles);
  const r = await pool.query('INSERT INTO users (username, password_hash, name, role, branch) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [username, hash, `Test ${label}`, primary, primary === 'branch' ? (scopes.branch || [])[0] : null]);
  const id = r.rows[0].id; made.users.push(id);
  for (const role of roles) await pool.query('INSERT INTO user_roles (user_id, role) VALUES ($1,$2)', [id, role]);
  for (const [role, list] of Object.entries(scopes)) for (const b of list) await pool.query("INSERT INTO user_scopes (user_id, role, scope_type, scope_value) VALUES ($1,$2,'branch',$3)", [id, role, b]);
  me[label] = { id, username };
  return createSession(id);
}

async function mkPO(num, daysFromToday, status) {
  const r = await pool.query(
    `INSERT INTO purchase_orders (po_number, po_date, supplier_id, subtotal, cgst_amount, sgst_amount, igst_amount, total_amount, delivery_date, status, created_by)
     VALUES ($1, CURRENT_DATE, $2, 1000, 90, 90, 0, 1180, CURRENT_DATE + $3::int, $4, $5) RETURNING id`, [`${TAG}-${num}`, supplierId, daysFromToday, status || 'created', me.admin.id]);
  made.pos.push(r.rows[0].id);
  await pool.query("INSERT INTO po_items (po_id, item_name, quantity, unit, rate, line_amount) VALUES ($1, $2, 10, 'Kg', 100, 1000)", [r.rows[0].id, `${TAG} drum`]);
  return r.rows[0].id;
}
async function mkGRN(num, poId, status) {
  const r = await pool.query(
    `INSERT INTO grn_notes (grn_number, grn_date, po_id, received_by, total_items, status, condition, created_by) VALUES ($1, CURRENT_DATE, $2, 'Test receiver', 1, $3, 'Good', $4) RETURNING id`,
    [`${TAG}-${num}`, poId, status, me.admin.id]);
  made.grns.push(r.rows[0].id);
  await pool.query("INSERT INTO grn_items (grn_id, item_name, po_quantity, received_quantity, variance, condition) VALUES ($1, $2, 10, 10, 0, 'Good')", [r.rows[0].id, `${TAG} drum`]);
  return r.rows[0].id;
}
async function mkRequest(token, items) {
  const r = await api(token, 'POST', '/api/branch-request/create', { branch: 'Kannur', delivery_needed_by: '2027-01-15', priority: 'normal', items });
  if (r.success) made.requests.push(r.request_id);
  return r;
}
const dash = (token, ws, q) => api(token, 'GET', `/api/workspace/${ws}/dashboard${q || ''}`);
const cardOf = (d, key) => (d.cards || []).find(c => c.key === key);
const allText = (o) => JSON.stringify(o);

test.before(async () => {
  await runMigrations();
  server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch (e) {} await new Promise(r => setTimeout(r, 250)); }

  tok.admin = await mkUser('admin', ['admin']);
  tok.purchase = await mkUser('purchase', ['purchase']);
  tok.store = await mkUser('store', ['store']);
  tok.accounts = await mkUser('accounts', ['accounts']);
  tok.production = await mkUser('production', ['production']);
  tok.qc = await mkUser('qc', ['qc']);
  tok.manager = await mkUser('manager', ['manager']);
  tok.kannur = await mkUser('kannur', ['branch'], { branch: ['Kannur'] });
  tok.thrissur = await mkUser('thrissur', ['branch'], { branch: ['Thrissur'] });
  tok.ernakulam = await mkUser('ernakulam', ['branch'], { branch: ['Ernakulam'] });
  tok.twobranch = await mkUser('twobranch', ['branch'], { branch: ['Kannur', 'Thrissur'] });
  tok.multi = await mkUser('multi', ['purchase', 'store']);
  tok.branchbuyer = await mkUser('branchbuyer', ['branch', 'purchase'], { branch: ['Kannur'] });

  supplierId = (await pool.query("INSERT INTO suppliers (name, status) VALUES ($1, 'active') RETURNING id", [`${TAG} Supplier`])).rows[0].id; made.supplier = supplierId;
  productId = (await pool.query('SELECT id FROM products WHERE active ORDER BY id LIMIT 1')).rows[0].id;

  // Purchase orders waiting for goods: one overdue, one due soon; one received (QC pending), one rejected, one paid-and-received
  ids.poLate = await mkPO('LATE', -3, 'created');
  ids.poSoon = await mkPO('SOON', 2, 'payment_pending');
  ids.poQc = await mkPO('QC', -1, 'in_transit');
  ids.poRej = await mkPO('REJ', -1, 'in_transit');
  ids.poInv = await mkPO('INV', -9, 'delivered');
  ids.grnQc = await mkGRN('GRN-QC', ids.poQc, 'pending_qc');
  ids.grnRej = await mkGRN('GRN-REJ', ids.poRej, 'rejected');
  ids.grnOk = await mkGRN('GRN-OK', ids.poInv, 'approved');
  const pay = await pool.query(`INSERT INTO payments (payment_id, po_id, supplier_id, payment_date, amount, payment_mode, utr_number, status, created_by)
    VALUES ($1,$2,$3,CURRENT_DATE,1180,'bank_transfer',$4,'initiated',$5) RETURNING id`, [`${TAG}-PAY`, ids.poLate, supplierId, `UTR${TAG}`, me.accounts.id]);
  made.payments.push(pay.rows[0].id); ids.pay = pay.rows[0].id;
  const inv = await pool.query(`INSERT INTO purchase_invoices (invoice_number, po_id, invoice_date, invoice_amount, gst_number, status, created_by)
    VALUES ($1,$2,CURRENT_DATE,1180,'GSTTEST','uploaded',$3) RETURNING id`, [`${TAG}-INV`, ids.poInv, me.accounts.id]);
  made.invoices.push(inv.rows[0].id);

  // Branch requests: two for Kannur (one approved), one for Thrissur
  const k1 = await mkRequest(tok.kannur, [{ product_id: productId, quantity: 5 }]);
  const k2 = await mkRequest(tok.kannur, [{ product_id: productId, quantity: 6 }]);
  const t1 = await mkRequest(tok.thrissur, [{ product_id: productId, quantity: 7 }]);
  assert.ok(k1.success && k2.success && t1.success, 'test requests were created');
  ids.k1 = k1.request_id; ids.k2 = k2.request_id; ids.t1 = t1.request_id;
  assert.equal((await api(tok.admin, 'PUT', `/api/branch-request/${ids.k2}/approve`)).success, true);
});

test.after(async () => {
  try {
    await pool.query('DELETE FROM payments WHERE id = ANY($1)', [made.payments.length ? made.payments : [0]]);
    await pool.query('DELETE FROM purchase_invoices WHERE id = ANY($1)', [made.invoices.length ? made.invoices : [0]]);
    await pool.query('DELETE FROM grn_items WHERE grn_id = ANY($1)', [made.grns.length ? made.grns : [0]]);
    await pool.query('DELETE FROM grn_notes WHERE id = ANY($1)', [made.grns.length ? made.grns : [0]]);
    await pool.query('DELETE FROM po_source_links WHERE po_id = ANY($1)', [made.pos.length ? made.pos : [0]]);
    await pool.query('DELETE FROM po_items WHERE po_id = ANY($1)', [made.pos.length ? made.pos : [0]]);
    await pool.query('DELETE FROM purchase_orders WHERE id = ANY($1)', [made.pos.length ? made.pos : [0]]);
    await pool.query('DELETE FROM suppliers WHERE id = $1', [made.supplier || 0]);
    await pool.query('DELETE FROM branch_stock_requests WHERE id = ANY($1)', [made.requests.length ? made.requests : [0]]);
    await pool.query('DELETE FROM audit_log WHERE actor_id = ANY($1)', [made.users.length ? made.users : [0]]);
    await pool.query('DELETE FROM audit_log WHERE summary LIKE $1', [`%${TAG.toLowerCase()}%`]);
    // permissions this run edited on the qc role are put back exactly as the defaults define them
    const { DEFAULTS } = require('../permissions');
    await pool.query("DELETE FROM role_permissions WHERE role = 'qc'");
    for (const k of DEFAULTS.qc) await pool.query("INSERT INTO role_permissions (role, permission_key) VALUES ('qc',$1) ON CONFLICT DO NOTHING", [k]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users.length ? made.users : [0]]);
  } finally { server && server.kill(); await pool.end(); }
});

// ---------------------------------------------------------------------------------------------------
test('migrations: every existing person keeps their role and branch; the new tables exist', async () => {
  const n = (await pool.query('SELECT COUNT(*)::int n FROM users')).rows[0].n;
  const withRole = (await pool.query('SELECT COUNT(DISTINCT user_id)::int n FROM user_roles')).rows[0].n;
  assert.equal(withRole, n, 'every user has at least one role row');
  const drift = (await pool.query("SELECT COUNT(*)::int n FROM users u WHERE u.role <> ALL(SELECT r.role FROM user_roles r WHERE r.user_id = u.id)")).rows[0].n;
  assert.equal(drift, 0, 'the primary role is always one of the roles held');
  const names = (await pool.query('SELECT name FROM app_migrations')).rows.map(r => r.name);
  assert.ok(names.includes('007_roles_scopes_workspaces') && names.includes('008_field_visibility_and_new_roles'));
  const before = names.length; await runMigrations();
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM app_migrations')).rows[0].n, before, 'running again changes nothing');
});

test('migration does not broaden access: legacy roles gained only restricted-field keys, and Stores did not get them', async () => {
  const rows = (await pool.query("SELECT role, permission_key FROM role_permissions WHERE role IN ('branch','production','store','purchase','accounts') AND permission_key LIKE 'field.%'")).rows;
  assert.ok(rows.every(r => ['purchase', 'accounts'].includes(r.role)), 'only purchase and accounts hold field keys by default');
  const store = (await pool.query("SELECT permission_key FROM role_permissions WHERE role = 'store'")).rows.map(r => r.permission_key);
  assert.ok(!store.includes('field.prices') && !store.includes('field.supplier_bank'));
  assert.ok(store.includes('grn.approve') && store.includes('branch_request.approve'), 'the actions Stores had before are untouched');
});

test('each role lands on the right workspace and sees only its own', async () => {
  const expect = { purchase: 'purchase', store: 'stores', accounts: 'accounts', production: 'production', qc: 'qc', manager: 'manager', admin: 'admin', kannur: 'branch' };
  for (const [who, ws] of Object.entries(expect)) {
    const r = await api(tok[who], 'GET', '/api/workspace/me');
    assert.equal(r.success, true, who);
    assert.equal(r.active, ws, `${who} lands on ${ws}`);
    if (who !== 'admin') assert.equal(r.workspaces.length, 1, `${who} has exactly one workspace`);
  }
  const admin = await api(tok.admin, 'GET', '/api/workspace/me');
  assert.deepEqual(admin.workspaces.map(w => w.id), ['admin', 'manager'], 'an administrator keeps the approval overview they always had');
});

test('navigation: every entry points at a real page the role may use, and nothing else', async () => {
  for (const who of ['purchase', 'store', 'accounts', 'production', 'qc', 'manager', 'admin', 'kannur']) {
    const r = await api(tok[who], 'GET', '/api/workspace/me');
    const perms = new Set(r.permissions || []);
    for (const g of r.nav) for (const it of g.items) {
      assert.ok(fs.existsSync(path.join(FRONTEND, it.href.split('?')[0])), `${who}: ${it.href} is a real page`);
    }
    if (who === 'kannur') assert.deepEqual(r.nav.flatMap(g => g.items.map(i => i.label)), ['Dashboard', 'R&D Projects', 'My Branch Requests'], 'a branch can also raise and follow R&D requests');
    if (who === 'store') { assert.ok(!allText(r.nav).includes('Payments') && !allText(r.nav).includes('Purchase Orders')); }
    if (who === 'qc') { assert.ok(!allText(r.nav).includes('Users') && r.nav.flatMap(g => g.items).some(i => i.label === 'Inspection Queue')); }
    assert.ok(perms.size > 0 || who === 'admin');
  }
});

test('dashboards have a consistent shape and use only real data', async () => {
  for (const [who, ws] of [['purchase', 'purchase'], ['store', 'stores'], ['accounts', 'accounts'], ['production', 'production'], ['qc', 'qc'], ['manager', 'manager'], ['admin', 'admin'], ['kannur', 'branch']]) {
    const d = await dash(tok[who], ws);
    assert.equal(d.success, true, `${who}: ${JSON.stringify(d).slice(0, 200)}`);
    assert.ok(d.cards.length <= 4 && d.actions.length <= 3, `${who}: at most four cards and three actions`);
    d.cards.forEach(c => { assert.ok(c.label && c.href && c.value !== undefined, `${who} card`); assert.ok(fs.existsSync(path.join(FRONTEND, c.href.split('?')[0])), `${who}: card opens a real page (${c.href})`); });
    d.actions.forEach(a => assert.ok(fs.existsSync(path.join(FRONTEND, a.href.split('?')[0])), `${who}: action ${a.href}`));
    for (const t of [...d.queue.items, ...d.exceptions.items]) {
      assert.ok(t.type && t.number && t.href && t.reason && t.responsible !== undefined && t.progress, `${who}: a task shows record, reason, owner and progress`);
      assert.ok(fs.existsSync(path.join(FRONTEND, t.href.split('?')[0])), `${who}: task opens a real page (${t.href})`);
      assert.ok(t.next || t.waiting_on, `${who}: a task shows the next permitted step or why it is waiting`);
    }
  }
});

test('a workspace that is not assigned cannot be opened, even by URL', async () => {
  assert.equal((await dash(tok.kannur, 'purchase')).status, 403);
  assert.equal((await dash(tok.store, 'accounts')).status, 403);
  assert.equal((await dash(tok.purchase, 'admin')).status, 403);
  assert.equal((await dash(tok.purchase, 'nonsense')).status, 404);
  assert.equal((await api(tok.store, 'PUT', '/api/workspace/preference', { active: 'admin' })).status, 403);
});

test('branch scope: lists, counts, details, search, notifications and actions stay inside the assigned branches', async () => {
  const mine = await api(tok.kannur, 'GET', '/api/branch-request');
  assert.ok(mine.requests.length >= 2 && mine.requests.every(r => r.branch === 'Kannur'));
  assert.ok(!mine.requests.some(r => r.id === ids.t1));
  const theirs = await api(tok.kannur, 'GET', '/api/branch-request/' + ids.t1);
  assert.equal(theirs.status, 403, 'another branch\'s record cannot be opened by id');
  assert.equal((await api(tok.kannur, 'DELETE', '/api/branch-request/' + ids.t1)).status, 403);
  assert.equal((await api(tok.ernakulam, 'GET', '/api/branch-request')).count, 0, 'a branch with no records sees none');

  const d = await dash(tok.kannur, 'branch');
  const all = [...d.queue.items, ...d.exceptions.items];
  assert.ok(all.length >= 2 && all.every(t => t.party === 'Kannur'), 'dashboard rows are only Kannur');
  assert.equal(cardOf(d, 'awaiting').value + cardOf(d, 'progress').value + cardOf(d, 'rejected').value, mine.requests.length, 'cards add up to the records the person can open');
  const e = await dash(tok.ernakulam, 'branch');
  assert.equal(e.queue.total, 0); assert.ok(e.cards.every(c => c.value === 0), 'an empty branch gets zeros, not other branches\' numbers');

  const reqNo = (await pool.query('SELECT request_number FROM branch_stock_requests WHERE id = $1', [ids.t1])).rows[0].request_number;
  assert.equal((await api(tok.kannur, 'GET', '/api/search?q=' + encodeURIComponent(reqNo))).results.length, 0, 'search does not reveal another branch');
  assert.equal((await api(tok.thrissur, 'GET', '/api/search?q=' + encodeURIComponent(reqNo))).results.length, 1);
  const n = await api(tok.kannur, 'GET', '/api/workspace/notifications');
  assert.ok(n.notifications.every(x => !x.text.includes(reqNo)), 'notifications do not mention another branch');

  const two = await api(tok.twobranch, 'GET', '/api/branch-request');
  assert.ok(two.requests.some(r => r.branch === 'Kannur') && two.requests.some(r => r.branch === 'Thrissur'), 'a person assigned two branches sees both');
  const create = await api(tok.kannur, 'POST', '/api/branch-request/create', { branch: 'Thrissur', delivery_needed_by: '2027-01-15', items: [{ product_id: productId, quantity: 1 }] });
  if (create.success) made.requests.push(create.request_id);
  assert.equal((await pool.query('SELECT branch FROM branch_stock_requests WHERE id = $1', [create.request_id])).rows[0].branch, 'Kannur', 'a request is always raised for the person\'s own branch');
});

test('multi-role person: branch scope applies to branch work only, purchasing work stays organisation-wide', async () => {
  const own = await api(tok.branchbuyer, 'GET', '/api/branch-request');
  assert.ok(own.requests.length >= 1 && own.requests.every(r => r.branch === 'Kannur'), 'branch requests are limited to Kannur');
  const buy = await api(tok.branchbuyer, 'GET', '/api/consolidate/all');
  assert.equal(buy.success, true);
  const branchesBuying = new Set(buy.branch_requests.map(r => r.branch));
  assert.ok(buy.branch_requests.length === 0 || branchesBuying.size >= 1, 'consolidation answers');
  const purchaseOnly = await api(tok.purchase, 'GET', '/api/consolidate/all');
  assert.equal(buy.branch_requests.length, purchaseOnly.branch_requests.length, 'the purchase role covers every branch, whatever else the person holds');
});

test('field visibility: Stores never receives prices, totals or bank details; Purchase does', async () => {
  const list = await api(tok.store, 'GET', '/api/po');
  assert.equal(list.success, true); assert.ok(list.prices_hidden);
  list.pos.forEach(p => assert.ok(!('total_amount' in p)));
  const one = await api(tok.store, 'GET', '/api/po/' + ids.poLate);
  assert.equal(one.success, true);
  ['subtotal', 'cgst_amount', 'sgst_amount', 'total_amount', 'bank_name', 'account_number', 'ifsc_code'].forEach(k => assert.ok(!(k in one.po), k + ' is omitted'));
  one.items.forEach(i => assert.ok(!('rate' in i) && !('line_amount' in i)));
  const sum = await api(tok.store, 'GET', '/api/dashboard/summary');
  assert.ok(!('total_purchase_value' in sum) || sum.total_purchase_value === undefined);
  assert.equal((await api(tok.store, 'GET', '/api/dashboard/analytics')).status, 403);
  const activity = await api(tok.store, 'GET', '/api/dashboard/recent-activity');
  assert.ok(activity.activity.every(a => a.amount === null));
  const sd = await dash(tok.store, 'stores');
  assert.ok(!/₹/.test(allText(sd)) && !/amount/i.test(allText(sd.queue)), 'the Stores dashboard carries no money');
  const ex = await api(tok.store, 'GET', '/api/workspace/expected-deliveries?when=all');
  assert.ok(!/"(rate|line_amount|amount|total_amount|subtotal)"/.test(allText(ex.deliveries)), 'expected deliveries never include money');

  const buyer = await api(tok.purchase, 'GET', '/api/po/' + ids.poLate);
  assert.equal(Number(buyer.po.total_amount), 1180);
  assert.ok('rate' in buyer.items[0]);
  assert.ok((await api(tok.purchase, 'GET', '/api/dashboard/summary')).total_purchase_value > 0);
  const qcView = await api(tok.qc, 'GET', '/api/po/' + ids.poLate);
  assert.deepEqual(qcView.payments, [], 'payment references are not included for a role without payment access');
  assert.ok(!('total_amount' in qcView.po));
});

test('direct URL and API access cannot bypass the permission rules', async () => {
  assert.equal((await api(tok.qc, 'POST', '/api/po/create', {})).status, 403);
  assert.equal((await api(tok.store, 'PUT', `/api/payment/${ids.pay}/approve`)).status, 403);
  assert.equal((await api(tok.purchase, 'PUT', `/api/payment/${ids.pay}/approve`)).status, 403);
  assert.equal((await api(tok.accounts, 'PUT', `/api/grn/${ids.grnQc}/approve`)).status, 403);
  assert.equal((await api(tok.production, 'PUT', `/api/grn/${ids.grnQc}/approve`)).status, 403);
  assert.equal((await api(tok.kannur, 'GET', '/api/po')).status, 403);
  assert.equal((await api(tok.kannur, 'GET', '/api/payment')).status, 403);
  assert.equal((await api(tok.kannur, 'GET', '/api/grn')).status, 403);
  assert.equal((await api(tok.qc, 'GET', '/api/payment')).status, 403);
  assert.equal((await api(tok.manager, 'PUT', `/api/payment/${ids.pay}/approve`)).status, 403, 'a manager is not given payment confirmation by default');
  assert.equal((await api(tok.store, 'GET', '/api/auth/users')).status, 403);
  assert.equal((await api(tok.manager, 'PUT', '/api/auth/role-permissions', { role: 'qc', permission_key: 'po.view', allowed: false })).status, 403, 'only an administrator edits permissions');
  assert.equal((await api(tok.purchase, 'GET', '/api/admin/audit')).status, 403);
  assert.equal((await api(null, 'GET', '/api/workspace/me')).status, 401);
});

test('search shows only what the person may open, and follows permission changes at once', async () => {
  const poNo = (await pool.query('SELECT po_number FROM purchase_orders WHERE id = $1', [ids.poLate])).rows[0].po_number;
  assert.equal((await api(tok.purchase, 'GET', '/api/search?q=' + poNo)).results.length, 1);
  assert.equal((await api(tok.kannur, 'GET', '/api/search?q=' + poNo)).results.length, 0);
  const utr = 'UTR' + TAG;
  assert.equal((await api(tok.store, 'GET', '/api/search?q=' + utr)).results.length, 0, 'payment references are not searchable without payment access');
  assert.equal((await api(tok.accounts, 'GET', '/api/search?q=' + utr)).results.length, 1);
});

test('revoking a permission takes effect on the very next request, everywhere', async () => {
  const poNo = (await pool.query('SELECT po_number FROM purchase_orders WHERE id = $1', [ids.poLate])).rows[0].po_number;
  assert.equal((await api(tok.qc, 'GET', '/api/po/' + ids.poLate)).success, true);
  assert.equal((await api(tok.qc, 'GET', '/api/search?q=' + poNo)).results.length, 1);
  const revoke = await api(tok.admin, 'PUT', '/api/auth/role-permissions', { role: 'qc', permission_key: 'po.view', allowed: false });
  assert.equal(revoke.success, true);
  try {
    assert.equal((await api(tok.qc, 'GET', '/api/po/' + ids.poLate)).status, 403, 'the record is refused');
    assert.equal((await api(tok.qc, 'GET', '/api/search?q=' + poNo)).results.length, 0, 'search stops listing it');
    const g = await api(tok.admin, 'PUT', '/api/auth/role-permissions', { role: 'qc', permission_key: 'grn.view', allowed: false });
    assert.equal(g.success, true);
    const d = await dash(tok.qc, 'qc');
    assert.equal(d.cards.length, 0, 'the dashboard drops sections it may no longer read');
    assert.equal((await api(tok.qc, 'GET', '/api/grn/' + ids.grnQc)).status, 403);
    const audit = await pool.query("SELECT COUNT(*)::int n FROM audit_log WHERE action IN ('permission.revoke','permission.grant') AND actor_id = $1", [me.admin.id]);
    assert.ok(audit.rows[0].n >= 2, 'permission edits are recorded');
  } finally {
    await api(tok.admin, 'PUT', '/api/auth/role-permissions', { role: 'qc', permission_key: 'po.view', allowed: true });
    await api(tok.admin, 'PUT', '/api/auth/role-permissions', { role: 'qc', permission_key: 'grn.view', allowed: true });
  }
  assert.equal((await api(tok.qc, 'GET', '/api/po/' + ids.poLate)).success, true);
});

test('dashboard counts match the records the person can actually open', async () => {
  const pur = await dash(tok.purchase, 'purchase');
  const cons = await api(tok.purchase, 'GET', '/api/consolidate/all');
  assert.equal(cardOf(pur, 'requirements').value, cons.branch_requests.length + cons.production_indents.length, 'purchase requirements = what Consolidation lists');
  for (const [key, when] of [['overdue', 'overdue'], ['due_soon', 'soon']]) {
    const list = await api(tok.purchase, 'GET', '/api/workspace/expected-deliveries?when=' + when);
    assert.equal(cardOf(pur, key).value, list.count, `${key} = expected deliveries (${when})`);
  }
  assert.ok(allText((await api(tok.purchase, 'GET', '/api/workspace/expected-deliveries?when=overdue')).deliveries).includes(TAG + '-LATE'));
  assert.equal(cardOf(pur, 'unpaid').value, (await api(tok.purchase, 'GET', '/api/po')).pos.filter(p => ['created', 'payment_pending'].includes(p.status)).length, 'unpaid = PO list filter');

  const qc = await dash(tok.qc, 'qc');
  const grns = (await api(tok.qc, 'GET', '/api/grn')).grns;
  assert.equal(cardOf(qc, 'awaiting').value, grns.filter(g => g.status === 'pending_qc').length);
  assert.equal(cardOf(qc, 'decided').value, grns.filter(g => g.status !== 'pending_qc').length);
  assert.ok(qc.queue.items.some(t => t.number === TAG + '-GRN-QC'), 'the test receipt is in the inspection queue');
  const st = await dash(tok.store, 'stores');
  assert.equal(cardOf(st, 'qc').value, cardOf(qc, 'awaiting').value);
  assert.equal(cardOf(st, 'late').value, (await api(tok.store, 'GET', '/api/workspace/expected-deliveries?when=overdue')).count);

  const acc = await dash(tok.accounts, 'accounts');
  const pays = (await api(tok.accounts, 'GET', '/api/payment')).payments;
  assert.equal(cardOf(acc, 'confirm').value, pays.filter(p => p.status === 'initiated').length);
  assert.ok(acc.queue.items.some(t => t.number === TAG + '-PAY' && t.next && t.next.label === 'Confirm payment'));
  assert.ok(acc.queue.items.some(t => t.number === TAG + '-INV'), 'the uploaded invoice waits for review');

  const prod = await dash(tok.production, 'production');
  const plan = await api(tok.production, 'GET', '/api/bom/plan');
  assert.equal(cardOf(prod, 'demand').value, plan.requests.filter(r => !r.planned_indent_id).length, 'production demand = material planning list');
  const br = await api(tok.kannur, 'GET', '/api/branch-request');
  const bd = await dash(tok.kannur, 'branch');
  assert.equal(cardOf(bd, 'awaiting').value, br.requests.filter(r => r.status === 'pending').length);
  assert.equal(cardOf(bd, 'progress').value, br.requests.filter(r => ['approved', 'po_raised'].includes(r.status)).length);
});

test('notifications: relevant only, each item once, and only for steps the person may take', async () => {
  for (const who of ['purchase', 'store', 'accounts', 'qc', 'production', 'manager', 'kannur']) {
    const r = await api(tok[who], 'GET', '/api/workspace/notifications');
    assert.equal(r.success, true, who);
    const keys = r.notifications.map(n => n.type + '|' + n.number);
    assert.equal(new Set(keys).size, keys.length, `${who}: no duplicates`);
    r.notifications.forEach(n => assert.ok(fs.existsSync(path.join(FRONTEND, n.href.split('?')[0])), `${who}: ${n.href} opens a real page`));
  }
  const store = await api(tok.store, 'GET', '/api/workspace/notifications');
  assert.ok(!store.notifications.some(n => n.type === 'Payment' || n.type === 'Invoice'), 'Stores is not told about payments or invoices');
  const qc = await api(tok.qc, 'GET', '/api/workspace/notifications');
  assert.ok(qc.notifications.some(n => n.number === TAG + '-GRN-QC'), 'QC is told a receipt is ready to inspect');
  const acc = await api(tok.accounts, 'GET', '/api/workspace/notifications');
  assert.ok(!acc.notifications.some(n => n.type === 'Goods receipt' && n.number === TAG + '-GRN-QC'), 'Accounts cannot decide quality, so is not told to');
});

test('approvals use the signed-in person, never a typed name; context travels with the request', async () => {
  const before = await api(tok.manager, 'GET', '/api/workspace/approvals');
  assert.equal(before.success, true);
  const a = before.approvals.find(x => x.number && x.type === 'Branch request' && x.party === 'Kannur');
  assert.ok(a && a.context.requester && a.context.source && a.context.quantity, 'an approval shows requester, source, quantity');
  assert.ok(!before.approvals.some(x => x.type === 'Payment'), 'a manager is not shown payments they cannot confirm');
  const ap = await api(tok.accounts, 'PUT', `/api/payment/${ids.pay}/approve`, { approved_by: 'Somebody Else' });
  assert.equal(ap.success, true);
  const row = (await pool.query('SELECT approved_by FROM payments WHERE id = $1', [ids.pay])).rows[0];
  assert.equal(row.approved_by, 'Test accounts', 'the approver recorded is the signed-in account');
  const auditRow = (await pool.query("SELECT actor_id FROM audit_log WHERE action = 'payment.confirm' AND entity_id = $1 ORDER BY id DESC LIMIT 1", [ids.pay])).rows[0];
  assert.equal(auditRow.actor_id, me.accounts.id);
  const mgrApprove = await api(tok.manager, 'PUT', `/api/branch-request/${ids.k1}/approve`);
  assert.equal(mgrApprove.success, true);
  assert.equal((await pool.query("SELECT actor_id FROM audit_log WHERE action = 'request.approve' AND entity_id = $1 ORDER BY id DESC LIMIT 1", [ids.k1])).rows[0].actor_id, me.manager.id);
});

test('a person with several roles switches workspace without changing identity, scope or permissions', async () => {
  const a = await api(tok.multi, 'GET', '/api/workspace/me');
  assert.deepEqual(a.workspaces.map(w => w.id), ['purchase', 'stores']);
  assert.equal(a.active, 'purchase');
  const perms = JSON.stringify([...a.permissions].sort());
  const sw = await api(tok.multi, 'PUT', '/api/workspace/preference', { active: 'stores' });
  assert.equal(sw.success, true);
  const b = await api(tok.multi, 'GET', '/api/workspace/me');
  assert.equal(b.active, 'stores', 'the choice is remembered');
  assert.equal(b.user.id, a.user.id);
  assert.equal(JSON.stringify([...b.permissions].sort()), perms, 'switching grants nothing and removes nothing');
  assert.ok(b.nav.flatMap(g => g.items).some(i => i.label === 'Expected Deliveries'));
  assert.equal((await api(tok.multi, 'GET', '/api/po')).success, true, 'purchasing data is still reachable while Stores is active');
  assert.equal((await dash(tok.multi, 'purchase')).success, true);
  assert.equal((await api(tok.multi, 'PUT', '/api/workspace/preference', { default: 'stores' })).default, 'stores');
  const act = await api(tok.multi, 'GET', '/api/workspace/me?workspace=purchase');
  assert.equal(act.active, 'purchase', 'a workspace can also be requested explicitly');
  assert.equal((await api(tok.multi, 'PUT', '/api/workspace/preference', { default: 'admin' })).status, 403);
});

test('signing in lands on the chosen default workspace', async () => {
  const pw = 'pw-' + crypto.randomBytes(6).toString('hex');
  await mkUser('login', ['purchase', 'accounts'], {}, pw);
  await pool.query("INSERT INTO user_workspace_prefs (user_id, default_workspace, last_workspace) VALUES ($1,'accounts','purchase')", [me.login.id]);
  const l = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: me.login.username, password: pw }) }).then(r => r.json());
  assert.equal(l.success, true);
  assert.deepEqual(l.user.roles.sort(), ['accounts', 'purchase']);
  assert.equal((await api(l.token, 'GET', '/api/workspace/me')).active, 'accounts');
});

test('administration: roles are managed with guards, scope validation and an audit trail', async () => {
  const bad = await api(tok.admin, 'PUT', `/api/auth/users/${me.multi.id}/access`, { roles: ['branch'], scopes: {} });
  assert.equal(bad.status, 400, 'the branch role needs a branch');
  assert.equal((await api(tok.admin, 'PUT', `/api/auth/users/${me.multi.id}/access`, { roles: ['nonsense'] })).status, 400);
  assert.equal((await api(tok.admin, 'PUT', `/api/auth/users/${me.multi.id}/access`, { roles: ['purchase'], scopes: { manager: ['Kannur'] } })).status, 400, 'branches for a role not held');
  const ok = await api(tok.admin, 'PUT', `/api/auth/users/${me.multi.id}/access`, { roles: ['purchase', 'qc'], scopes: {} });
  assert.equal(ok.success, true);
  assert.deepEqual((await api(tok.multi, 'GET', '/api/workspace/me')).workspaces.map(w => w.id), ['purchase', 'qc'], 'the change applies to the next request, with no sign-out');
  assert.equal((await api(tok.purchase, 'PUT', `/api/auth/users/${me.multi.id}/access`, { roles: ['admin'] })).status, 403, 'only an administrator changes access');
  const entry = await pool.query("SELECT before_data, after_data FROM audit_log WHERE action = 'user.access' AND entity_id = $1 ORDER BY id DESC LIMIT 1", [me.multi.id]);
  assert.deepEqual(entry.rows[0].after_data.roles, ['purchase', 'qc']);
  const { otherActiveAdmin } = require('../routes/auth');
  assert.equal(await otherActiveAdmin({ query: async () => ({ rowCount: 0 }) }, 1), false, 'with no other active administrator the guard refuses');
  assert.equal(await otherActiveAdmin(pool, me.admin.id), true, 'and allows a change while another active administrator remains');
  const created = await api(tok.admin, 'POST', '/api/auth/users', { username: `${TAG.toLowerCase()}_new`, name: 'Created in test', password: 'abcd1234', roles: ['store', 'qc'] });
  assert.equal(created.success, true);
  made.users.push(created.user_id);
  assert.equal(created.role, 'store');
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM user_roles WHERE user_id = $1', [created.user_id])).rows[0].n, 2);
});
