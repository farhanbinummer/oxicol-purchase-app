// Integration tests: a real server on its own port against the configured database.
//   npm run test:integration
// Everything the tests create (temporary users, test products, requests, indents, POs, audit rows) is removed
// afterwards. Users get random passwords that are never printed, and sessions are created directly, so the
// login rate limiter and real credentials are never involved. Do not point this at a database you cannot afford
// a few temporary rows in.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool } = require('../database');
const { createSession } = require('../auth');
const { runMigrations } = require('../migrate');

const PORT = 3299, BASE = `http://localhost:${PORT}`;
const TAG = 'ZZT' + crypto.randomBytes(3).toString('hex').toUpperCase();
const made = { users: [], products: [], requests: [], indents: [], pos: [] };
let server; const tok = {}; let materialIds = [];

async function api(token, method, url, body) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, ...(await res.json()) };
}

async function mkUser(role, branch) {
  const username = `${TAG.toLowerCase()}_${role}${branch ? '_' + branch.toLowerCase() : ''}`;
  const hash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 4);
  const r = await pool.query('INSERT INTO users (username, password_hash, name, role, branch) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [username, hash, `Test ${role}${branch ? ' ' + branch : ''}`, role, branch || null]);
  made.users.push(r.rows[0].id);
  return createSession(r.rows[0].id);
}

async function mkProduct(admin, suffix) {
  const r = await api(admin, 'POST', '/api/catalog/products', { name: `${TAG} ${suffix}`, pack_size: '1 KG' });
  assert.equal(r.success, true, JSON.stringify(r));
  made.products.push(r.product_id);
  return r.product_id;
}
async function mkRecipe(admin, productId, qtys) {
  for (let i = 0; i < qtys.length; i++) {
    const r = await api(admin, 'PUT', '/api/bom/lines', { product_id: productId, material_id: materialIds[i], qty_per_unit: qtys[i] });
    assert.equal(r.success, true, JSON.stringify(r));
  }
}
async function mkRequest(token, items, over = {}) {
  const r = await api(token, 'POST', '/api/branch-request/create', { branch: 'Kannur', delivery_needed_by: '2027-01-15', priority: 'normal', items, ...over });
  if (r.success) made.requests.push(r.request_id);
  return r;
}

test.before(async () => {
  await runMigrations();
  server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch (e) {} await new Promise(r => setTimeout(r, 250)); }
  tok.admin = await mkUser('admin');
  tok.kannur = await mkUser('branch', 'Kannur');
  tok.thrissur = await mkUser('branch', 'Thrissur');
  tok.production = await mkUser('production');
  tok.store = await mkUser('store');
  tok.purchase = await mkUser('purchase');
  materialIds = (await pool.query('SELECT id FROM raw_materials ORDER BY id LIMIT 3')).rows.map(r => r.id);
});

test.after(async () => {
  try {
    const reqs = made.requests.length ? made.requests : [0];
    await pool.query('DELETE FROM material_plans WHERE request_id = ANY($1)', [reqs]);
    const ind = (await pool.query('SELECT planned_indent_id AS id FROM branch_stock_requests WHERE id = ANY($1) AND planned_indent_id IS NOT NULL', [reqs])).rows.map(r => r.id).concat(made.indents);
    await pool.query('DELETE FROM po_source_links WHERE source_id = ANY($1) AND source_type = $2', [reqs, 'branch']);
    await pool.query('DELETE FROM po_source_links WHERE po_id = ANY($1)', [made.pos.length ? made.pos : [0]]);
    for (const id of made.pos) { await pool.query('DELETE FROM po_items WHERE po_id = $1', [id]); await pool.query('DELETE FROM purchase_orders WHERE id = $1', [id]); }
    await pool.query('DELETE FROM branch_stock_requests WHERE id = ANY($1)', [reqs]);
    if (ind.length) await pool.query('DELETE FROM production_indents WHERE id = ANY($1)', [ind]);
    await pool.query('DELETE FROM products WHERE id = ANY($1)', [made.products.length ? made.products : [0]]);
    await pool.query('DELETE FROM audit_log WHERE actor_id = ANY($1)', [made.users.length ? made.users : [0]]);
    await pool.query('DELETE FROM audit_log WHERE summary LIKE $1', [`%${TAG}%`]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users.length ? made.users : [0]]);
  } finally { server && server.kill(); await pool.end(); }
});

test('migrations are idempotent: running them again changes nothing', async () => {
  const before = (await pool.query('SELECT COUNT(*)::int n FROM app_migrations')).rows[0].n;
  await runMigrations();
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM app_migrations')).rows[0].n, before);
  assert.ok(before >= 6);
});

test('existing records are still readable after migration', async () => {
  const r = await api(tok.admin, 'GET', '/api/branch-request');
  assert.equal(r.success, true);
  const one = r.requests[0] && (await api(tok.admin, 'GET', '/api/branch-request/' + r.requests[0].id));
  if (one) assert.equal(one.success, true);
  assert.equal((await api(tok.admin, 'GET', '/api/po')).success, true);
});

test('legacy free-text items are flagged for review, never auto-merged', async () => {
  const flagged = (await pool.query("SELECT COUNT(*)::int n FROM branch_request_items WHERE product_id IS NULL AND mapping_status <> 'needs_review'")).rows[0].n;
  assert.equal(flagged, 0);
});

test('an abbreviated search lists candidates; the chosen product resolves its recipe', async () => {
  const s = await api(tok.kannur, 'GET', '/api/catalog/products/search?q=hk%20wheel');
  assert.equal(s.success, true);
  assert.ok(s.products.length >= 2, 'both wheel cleaners are offered, none silently chosen');
  const pick = s.products.find(p => /1 KG/.test(p.name));
  const r = await mkRequest(tok.kannur, [{ product_id: pick.id, quantity: 4 }]);
  assert.equal(r.success, true, JSON.stringify(r));
  await api(tok.store, 'PUT', `/api/branch-request/${r.request_id}/approve`, {});
  const plan = await api(tok.production, 'GET', '/api/bom/plan/' + r.request_id);
  assert.equal(plan.complete, true);
  assert.ok(plan.totals.length > 0, 'raw materials were calculated');
  assert.equal(plan.items[0].product_id, pick.id);
});

test('request creation rejects free text, duplicates and inactive products; unit and requester are server-controlled', async () => {
  const admin = tok.admin;
  const p = await mkProduct(admin, 'A');
  assert.equal((await mkRequest(tok.kannur, [{ item_name: 'free text', quantity: 1 }])).success, false);
  assert.match((await mkRequest(tok.kannur, [{ product_id: p, quantity: 1 }, { product_id: p, quantity: 2 }])).error, /repeats/);
  await api(admin, 'PUT', '/api/catalog/products/' + p, { active: false });
  assert.match((await mkRequest(tok.kannur, [{ product_id: p, quantity: 1 }])).error, /no longer active|not in the catalogue/);
  await api(admin, 'PUT', '/api/catalog/products/' + p, { active: true });
  const ok = await mkRequest(tok.kannur, [{ product_id: p, quantity: 2, unit: 'Litre', item_name: 'Hacked' }], { requested_by: 'Someone Else' });
  assert.equal(ok.success, true);
  const d = await api(tok.kannur, 'GET', '/api/branch-request/' + ok.request_id);
  assert.equal(d.request.requested_by, 'Test branch Kannur', 'requester comes from the login, not the form');
  assert.equal(d.items[0].unit, 'Nos', 'unit comes from the catalogue');
  assert.equal(d.items[0].item_name, `${TAG} A`, 'name is copied from the catalogue');
});

test('missing recipe blocks planning, names the demand, and refuses to create the indent', async () => {
  const p = await mkProduct(tok.admin, 'NORECIPE');
  const r = await mkRequest(tok.kannur, [{ product_id: p, quantity: 7 }]);
  await api(tok.store, 'PUT', `/api/branch-request/${r.request_id}/approve`, {});
  const plan = await api(tok.production, 'GET', '/api/bom/plan/' + r.request_id);
  assert.equal(plan.complete, false);
  assert.equal(plan.blocked[0].reason, 'recipe_missing');
  assert.equal(plan.blocked[0].quantity, 7);
  const draft = await api(tok.production, 'POST', `/api/bom/plan/${r.request_id}/draft-indent`, {});
  assert.equal(draft.status, 409);
  assert.match(draft.error, /Planning blocked/);
  const after = (await pool.query('SELECT planned_indent_id FROM branch_stock_requests WHERE id = $1', [r.request_id])).rows[0];
  assert.equal(after.planned_indent_id, null, 'nothing was marked planned');
});

test('a legacy item blocks planning until someone links it to a product, and the link is audited', async () => {
  const p = await mkProduct(tok.admin, 'LEGACY'); await mkRecipe(tok.admin, p, [2, 3]);
  const r = await mkRequest(tok.kannur, [{ product_id: p, quantity: 1 }]);
  const item = (await pool.query('SELECT id FROM branch_request_items WHERE request_id = $1', [r.request_id])).rows[0].id;
  await pool.query("UPDATE branch_request_items SET product_id = NULL, mapping_status = 'needs_review' WHERE id = $1", [item]);
  await api(tok.store, 'PUT', `/api/branch-request/${r.request_id}/approve`, {});
  assert.equal((await api(tok.production, 'GET', '/api/bom/plan/' + r.request_id)).blocked[0].reason, 'unmapped');
  const un = await api(tok.store, 'GET', '/api/catalog/unmapped');
  assert.ok(un.items.some(i => i.item_id === item));
  assert.equal((await api(tok.kannur, 'PUT', '/api/catalog/map-item', { item_id: item, product_id: p })).status, 403, 'a branch cannot link items');
  assert.equal((await api(tok.store, 'PUT', '/api/catalog/map-item', { item_id: item, product_id: p })).success, true);
  assert.equal((await api(tok.production, 'GET', '/api/bom/plan/' + r.request_id)).complete, true);
  const log = await pool.query("SELECT actor_name FROM audit_log WHERE action = 'request_item.map' AND entity_id = $1", [item]);
  assert.equal(log.rows[0].actor_name, 'Test store');
});

test('a request cannot be bought twice: planned requests are held back from Consolidate and refused', async () => {
  const p = await mkProduct(tok.admin, 'DOUBLE'); await mkRecipe(tok.admin, p, [1, 2]);
  const r = await mkRequest(tok.kannur, [{ product_id: p, quantity: 3 }]);
  assert.equal((await api(tok.purchase, 'GET', '/api/consolidate/all')).branch_requests.some(x => x.id === r.request_id), false, 'pending demand is not purchasable');
  await api(tok.store, 'PUT', `/api/branch-request/${r.request_id}/approve`, {});
  assert.equal((await api(tok.purchase, 'GET', '/api/consolidate/all')).branch_requests.some(x => x.id === r.request_id), true, 'approved demand is');
  const d = await api(tok.production, 'POST', `/api/bom/plan/${r.request_id}/draft-indent`, {});
  assert.equal(d.success, true, JSON.stringify(d));
  made.indents.push(d.indent_id);
  const list = await api(tok.purchase, 'GET', '/api/consolidate/all');
  assert.equal(list.branch_requests.some(x => x.id === r.request_id), false, 'planned request is no longer listed');
  assert.ok(list.held_back.some(x => x.id === r.request_id), 'but it is shown as held back');
  const sup = (await pool.query("SELECT id FROM suppliers WHERE status = 'active' LIMIT 1")).rows[0];
  const po = await api(tok.purchase, 'POST', '/api/consolidate/create-po', { supplier_id: sup.id, branch_request_ids: [r.request_id], items: [{ item_name: 'x', quantity: 1, unit: 'Nos', rate: 1 }] });
  assert.equal(po.success, false);
  assert.match(po.error, /twice/);
  assert.match((await api(tok.production, 'POST', `/api/bom/plan/${r.request_id}/draft-indent`, {})).error, /Already planned/);
});

test('the reverse also holds: a request already in a PO cannot be planned', async () => {
  const p = await mkProduct(tok.admin, 'REVERSE'); await mkRecipe(tok.admin, p, [1]);
  const r = await mkRequest(tok.kannur, [{ product_id: p, quantity: 1 }]);
  await api(tok.store, 'PUT', `/api/branch-request/${r.request_id}/approve`, {});
  const sup = (await pool.query("SELECT id FROM suppliers WHERE status = 'active' LIMIT 1")).rows[0];
  const po = await api(tok.purchase, 'POST', '/api/consolidate/create-po', { supplier_id: sup.id, branch_request_ids: [r.request_id], items: [{ item_name: 'x', quantity: 1, unit: 'Nos', rate: 5 }] });
  assert.equal(po.success, true, JSON.stringify(po)); made.pos.push(po.po_id);
  assert.match((await api(tok.production, 'POST', `/api/bom/plan/${r.request_id}/draft-indent`, {})).error, /twice/);
  assert.equal((await api(tok.purchase, 'POST', '/api/consolidate/create-po', { supplier_id: sup.id, branch_request_ids: [r.request_id], items: [{ item_name: 'x', quantity: 1, unit: 'Nos', rate: 5 }] })).success, false, 'the same request cannot make a second PO');
});

test('repeated or simultaneous submissions create one record, not two', async () => {
  const p = await mkProduct(tok.admin, 'RACE'); await mkRecipe(tok.admin, p, [1, 2]);
  const r = await mkRequest(tok.kannur, [{ product_id: p, quantity: 2 }]);
  const approvals = await Promise.all([1, 2, 3].map(() => api(tok.store, 'PUT', `/api/branch-request/${r.request_id}/approve`, {})));
  assert.equal(approvals.filter(a => a.success).length, 1);
  const drafts = await Promise.all([1, 2, 3].map(() => api(tok.production, 'POST', `/api/bom/plan/${r.request_id}/draft-indent`, {})));
  assert.equal(drafts.filter(d => d.success).length, 1);
  drafts.filter(d => d.success).forEach(d => made.indents.push(d.indent_id));
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM material_plans WHERE request_id = $1', [r.request_id])).rows[0].n, 1);
});

test('editing a recipe that a plan used creates a new version; the old plan keeps its figures', async () => {
  const p = await mkProduct(tok.admin, 'VERSION'); await mkRecipe(tok.admin, p, [2]);
  const r = await mkRequest(tok.kannur, [{ product_id: p, quantity: 10 }]);
  await api(tok.store, 'PUT', `/api/branch-request/${r.request_id}/approve`, {});
  const d = await api(tok.production, 'POST', `/api/bom/plan/${r.request_id}/draft-indent`, {}); made.indents.push(d.indent_id);
  const used = (await pool.query('SELECT inputs FROM material_plans WHERE request_id = $1', [r.request_id])).rows[0].inputs;
  assert.equal(used.items[0].recipe_version, 1);
  const edit = await api(tok.admin, 'PUT', '/api/bom/lines', { product_id: p, material_id: materialIds[0], qty_per_unit: 9 });
  assert.equal(edit.new_version, true);
  assert.equal(edit.version, 2);
  const now = await api(tok.admin, 'GET', '/api/bom/products/' + p);
  assert.equal(now.recipe.version, 2);
  assert.deepEqual(now.versions.map(v => v.status), ['active', 'retired']);
  const kept = (await pool.query('SELECT inputs FROM material_plans WHERE request_id = $1', [r.request_id])).rows[0].inputs;
  assert.equal(kept.items[0].recipe_version, 1, 'the approved plan still points at version 1');
});

test('permissions are enforced by the server, and branch scoping holds', async () => {
  const p = await mkProduct(tok.admin, 'SCOPE');
  const r = await mkRequest(tok.kannur, [{ product_id: p, quantity: 1 }]);
  assert.equal((await api(tok.thrissur, 'GET', '/api/branch-request/' + r.request_id)).status, 403, 'another branch cannot read it');
  assert.equal((await api(tok.thrissur, 'GET', '/api/branch-request')).requests.some(x => x.id === r.request_id), false, 'nor see it in lists');
  assert.equal((await api(tok.kannur, 'PUT', `/api/branch-request/${r.request_id}/approve`, {})).status, 403, 'a branch cannot approve');
  assert.equal((await api(tok.kannur, 'GET', '/api/admin/audit')).status, 403);
  assert.equal((await api(tok.store, 'GET', '/api/admin/system')).status, 403);
  assert.equal((await api(tok.production, 'PUT', '/api/bom/lines', { product_id: p, material_id: materialIds[0], qty_per_unit: 1 })).status, 403, 'recipes are admin-only');
  assert.equal((await api(tok.purchase, 'POST', '/api/catalog/products', { name: 'nope' })).status, 403);
  assert.equal((await api(null, 'GET', '/api/catalog/products/search?q=a')).status, 401);
  const mine = await api(tok.kannur, 'GET', '/api/auth/my-permissions');
  assert.equal(mine.admin, false);
  assert.ok(mine.permissions.includes('branch_request.create') && !mine.permissions.includes('branch_request.approve'));
});

test('invalid transitions are rejected by the server', async () => {
  const p = await mkProduct(tok.admin, 'TRANS');
  const r = await mkRequest(tok.kannur, [{ product_id: p, quantity: 1 }]);
  await api(tok.store, 'PUT', `/api/branch-request/${r.request_id}/approve`, {});
  assert.equal((await api(tok.store, 'PUT', `/api/branch-request/${r.request_id}/approve`, {})).success, false, 'cannot approve twice');
  assert.equal((await api(tok.kannur, 'DELETE', '/api/branch-request/' + r.request_id)).success, false, 'cannot delete once approved');
});

test('the audit history records the signed-in actor and never a secret', async () => {
  const p = await mkProduct(tok.admin, 'AUDIT');
  const r = await mkRequest(tok.kannur, [{ product_id: p, quantity: 1 }]);
  const a = await api(tok.admin, 'GET', '/api/admin/audit?q=' + encodeURIComponent(TAG));
  assert.equal(a.success, true);
  assert.ok(a.total >= 1);
  const row = await pool.query("SELECT actor_name, actor_role FROM audit_log WHERE action = 'request.create' AND entity_id = $1", [r.request_id]);
  assert.deepEqual(row.rows[0], { actor_name: 'Test branch Kannur', actor_role: 'branch' });
  const leaked = await pool.query("SELECT COUNT(*)::int n FROM audit_log WHERE (before_data::text || after_data::text || COALESCE(summary,'')) ~* '(\"password|password_hash|\"token\"|secret)' AND actor_id = ANY($1)", [made.users]);
  assert.equal(leaked.rows[0].n, 0);
});

test('system status is admin-only and exposes no secret values', async () => {
  const s = await api(tok.admin, 'GET', '/api/admin/system');
  assert.equal(s.database.ok, true);
  assert.equal(s.accounting.state, 'test_mode');
  const text = JSON.stringify(s);
  for (const k of ['SMTP_PASS', 'DATABASE_URL', 'DB_PASSWORD', 'WHATSAPP_TOKEN']) {
    const v = process.env[k]; if (v) assert.equal(text.includes(v), false, k + ' leaked');
  }
});
