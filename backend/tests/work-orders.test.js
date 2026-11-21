// Stock in store and production work orders (batches).
//   node --test tests/work-orders.test.js
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
const { primaryRole } = require('../access');

const PORT = 3306, BASE = `http://localhost:${PORT}`, TAG = 'ZZW' + crypto.randomBytes(3).toString('hex').toUpperCase();
const made = { users: [], suppliers: [], pos: [] }; const tok = {}; let server, seq = 0;
async function api(token, method, url, body) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await res.json(); } catch (e) {} return { ...j, status: res.status };
}
async function mkUser(role) {
  const hash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 4);
  const r = await pool.query('INSERT INTO users (username, password_hash, name, role) VALUES ($1,$2,$3,$4) RETURNING id', [`${TAG}_${role}`.toLowerCase(), hash, `Test ${role}`, primaryRole([role])]);
  made.users.push(r.rows[0].id); await pool.query('INSERT INTO user_roles (user_id, role) VALUES ($1,$2)', [r.rows[0].id, role]); return createSession(r.rows[0].id);
}
async function mkSupplier(over = {}) {
  const r = await pool.query('INSERT INTO suppliers (name, address, gst_number, bank_name, account_number) VALUES ($1,$2,$3,$4,$5) RETURNING id', [`${TAG} supplier ${++seq}`, over.address === undefined ? 'Plot 4, Industrial Area\nKochi' : over.address, over.gst === undefined ? '32' + crypto.randomBytes(5).toString('hex').toUpperCase() + '1Z5' : over.gst, 'SBI', '9988776655443322']);
  made.suppliers.push(r.rows[0].id); return r.rows[0].id;
}
async function mkPo(supplier, date, over = {}) {
  const r = await pool.query('INSERT INTO purchase_orders (po_number, po_date, supplier_id, subtotal, cgst_amount, sgst_amount, total_amount, delivery_date, notes) VALUES ($1,$2,$3,58920,5302.8,5302.8,69525.6,$4,$5) RETURNING id, po_ref', [`${TAG}-${++seq}`, date, supplier, over.delivery || null, over.notes || null]);
  made.pos.push(r.rows[0].id);
  await pool.query("INSERT INTO po_items (po_id, item_name, quantity, unit, rate, line_amount) VALUES ($1,'HYDROFLURIC ACIF (HF)60%',240,'Kg',188,45120),($1,'OXALIC ACID',100,'Kg',92,9200),($1,'SLES LIQUID',50,'Kg',92,4600)", [r.rows[0].id]);
  return r.rows[0];
}

test.before(async () => {
  await runMigrations();
  server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), NOTIFY_TEST_MODE: '1' }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch (e) {} await new Promise(r => setTimeout(r, 250)); }
  tok.admin = await mkUser('admin'); tok.purchase = await mkUser('purchase'); tok.store = await mkUser('store'); tok.production = await mkUser('production'); tok.qc = await mkUser('qc'); tok.purchase = tok.purchase || await mkUser('purchase'); tok.accounts = await mkUser('accounts');
});
test.after(async () => {
  try {
    await pool.query('DELETE FROM payments WHERE po_id = ANY($1)', [made.pos.length ? made.pos : [0]]);
    await pool.query("DELETE FROM stock_movements WHERE ref_type = 'grn' AND ref_id IN (SELECT id FROM grn_notes WHERE po_id = ANY($1))", [made.pos.length ? made.pos : [0]]);
    await pool.query('DELETE FROM grn_notes WHERE po_id = ANY($1)', [made.pos.length ? made.pos : [0]]);
    await pool.query('DELETE FROM po_source_links WHERE po_id = ANY($1)', [made.pos.length ? made.pos : [0]]);
    await pool.query('DELETE FROM po_source_links WHERE po_id = ANY($1)', [made.pos.length ? made.pos : [0]]);
    await pool.query('DELETE FROM po_source_links WHERE po_id = ANY($1)', [made.pos.length ? made.pos : [0]]);
    await pool.query('DELETE FROM po_source_links WHERE po_id = ANY($1)', [made.pos.length ? made.pos : [0]]);
    await pool.query('DELETE FROM grn_notes WHERE po_id = ANY($1)', [made.pos.length ? made.pos : [0]]);
    await pool.query('DELETE FROM purchase_orders WHERE id = ANY($1)', [made.pos.length ? made.pos : [0]]);
    await pool.query('DELETE FROM stock_movements WHERE material_id = ANY($1)', [ids.materials.length ? ids.materials : [0]]);
    await pool.query('DELETE FROM work_orders WHERE product_id = ANY($1)', [ids.products.length ? ids.products : [0]]);
    await pool.query('DELETE FROM bom_lines WHERE material_id = ANY($1)', [ids.materials.length ? ids.materials : [0]]);
    await pool.query('DELETE FROM recipe_versions WHERE product_id = ANY($1)', [ids.products.length ? ids.products : [0]]);
    await pool.query('DELETE FROM products WHERE id = ANY($1)', [ids.products.length ? ids.products : [0]]);
    await pool.query('DELETE FROM raw_materials WHERE id = ANY($1)', [ids.materials.length ? ids.materials : [0]]);
    await pool.query('DELETE FROM suppliers WHERE id = ANY($1)', [made.suppliers.length ? made.suppliers : [0]]);
    await pool.query('DELETE FROM audit_log WHERE actor_id = ANY($1)', [made.users.length ? made.users : [0]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users.length ? made.users : [0]]);
  } finally { server && server.kill(); await pool.end(); }
});









const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
const ids = { products: [], materials: [], wos: [] };
async function mkMat(name, unit = 'Kg') { const m = await one("INSERT INTO raw_materials (code, name, unit, active) VALUES ($1,$2,$3,true) RETURNING id, name", [`${TAG}M${++seq}`, `${TAG} ${name}`, unit]); ids.materials.push(m.id); return m; }
/** a product whose recipe (for 10 units) uses 20 of A and 5 of B */
async function mkProduct() {
  const A = await mkMat('Acid A'), B = await mkMat('Base B'), p = await one('INSERT INTO products (name) VALUES ($1) RETURNING id', [`${TAG} product ${++seq}`]); ids.products.push(p.id);
  const rv = await one("INSERT INTO recipe_versions (product_id, version, base_output_qty, base_output_unit, wastage_included) VALUES ($1,1,10,'Nos',true) RETURNING id", [p.id]);
  await pool.query('INSERT INTO bom_lines (product_id, material_id, qty_per_unit, recipe_id) VALUES ($1,$2,20,$4),($1,$3,5,$4)', [p.id, A.id, B.id, rv.id]);
  return { product: p.id, A, B };
}
const onHand = async (m) => (await api(tok.store, 'GET', `/api/stock/${m}/movements`)).on_hand;
const adjust = (t, m, qty, note = 'Opening stock') => api(t, 'POST', '/api/stock/adjust', { material_id: m, qty, note });
const plan = (t, product, qty) => api(t, 'POST', '/api/work-orders', { product_id: product, planned_qty: qty });
const wo = (id) => api(tok.store, 'GET', '/api/work-orders/' + id);
async function mkGrn(items, qcApproved) {
  const s = (await one('INSERT INTO suppliers (name) VALUES ($1) RETURNING id', [`${TAG} sup ${++seq}`])).id; made.suppliers.push(s);
  const po = (await one("INSERT INTO purchase_orders (po_number, supplier_id, subtotal, total_amount, status) VALUES ($1,$2,100,118,'payment_done') RETURNING id", [`${TAG}-PO${++seq}`, s])).id; made.pos.push(po);
  const lines = [];
  for (const it of items) lines.push({ po_item_id: (await one("INSERT INTO po_items (po_id, item_name, quantity, unit, rate, line_amount) VALUES ($1,$2,$3,'Kg',5,50) RETURNING id", [po, it.name, it.qty])).id, received_qty: it.recv === undefined ? it.qty : it.recv, condition: it.cond || 'Good' });
  const r = await api(tok.store, 'POST', '/api/grn/create', { po_id: po, items: lines, qc_approved: !!qcApproved }); assert.equal(r.status, 201, JSON.stringify(r)); return r;
}

test('goods passed at quality check go into stock (matched to a raw material by name); damaged lines and unknown names do not; only once', async () => {
  const A = await mkMat('Stock acid'), B = await mkMat('Stock base');
  const r = await mkGrn([{ name: A.name.toUpperCase(), qty: 10, recv: 8 }, { name: B.name, qty: 5, cond: 'Damaged' }, { name: `${TAG} Mystery chemical`, qty: 3 }], false);
  assert.equal(await onHand(A.id), 0, 'waiting for quality check: not in stock yet');
  const ap = await api(tok.qc, 'PUT', `/api/grn/${r.grn_id}/approve`, {}); assert.equal(ap.status, 200, JSON.stringify(ap));
  assert.equal(await onHand(A.id), 8, 'what was received, not what was ordered'); assert.equal(await onHand(B.id), 0, 'damaged is not stock'); assert.deepEqual(ap.stock.unmatched, [`${TAG} Mystery chemical`]);
  assert.equal((await pool.query("SELECT 1 FROM stock_movements WHERE ref_type = 'grn' AND ref_id = $1", [r.grn_id])).rowCount, 1);
  const r2 = await mkGrn([{ name: B.name, qty: 4 }], true); assert.equal(await onHand(B.id), 4, 'approved when created: in stock straight away'); assert.equal(r2.stock.added, 1);
  const s = await api(tok.store, 'GET', '/api/stock?q=' + encodeURIComponent(A.name)); assert.equal(s.materials[0].on_hand, 8);
});
test('a receipt rejected at quality check adds nothing', async () => {
  const A = await mkMat('Rejected acid'), r = await mkGrn([{ name: A.name, qty: 10 }], false);
  assert.equal((await api(tok.qc, 'PUT', `/api/grn/${r.grn_id}/approve`, { approved: false })).status, 200); assert.equal(await onHand(A.id), 0);
});
test('opening stock and corrections: a reason is required, stock cannot go below zero, Stores and administrators only', async () => {
  const A = await mkMat('Adjust acid');
  assert.equal((await adjust(tok.store, A.id, 50)).status, 200); assert.equal(await onHand(A.id), 50);
  assert.equal((await adjust(tok.store, A.id, 5, '')).status, 400); assert.equal((await adjust(tok.store, A.id, 0)).status, 400); assert.equal((await adjust(tok.store, A.id, -60)).status, 400, 'would go below zero');
  assert.equal((await adjust(tok.admin, A.id, -10, 'Spilled')).status, 200); assert.equal(await onHand(A.id), 40);
  for (const t of [tok.production, tok.purchase, tok.qc, tok.accounts]) assert.equal((await adjust(t, A.id, 1)).status, 403);
  assert.equal((await api(tok.production, 'GET', '/api/stock')).status, 200, 'Production can see stock'); assert.equal((await api(tok.accounts, 'GET', '/api/stock')).status, 403); assert.equal((await api(null, 'GET', '/api/stock')).status, 401);
  const h = await api(tok.store, 'GET', `/api/stock/${A.id}/movements`); assert.deepEqual(h.movements.map(m => m.qty), [-10, 50]);
  assert.equal((await one("SELECT COUNT(*)::int n FROM audit_log WHERE action = 'stock.adjust' AND entity_id = $1", [A.id])).n, 2);
});

test('the whole batch: plan from the recipe, Stores issues (stock goes down), Production records the result, Quality check passes it', async () => {
  const { product, A, B } = await mkProduct(); await adjust(tok.store, A.id, 100); await adjust(tok.store, B.id, 100);
  const pv = await api(tok.production, 'GET', `/api/work-orders/preview?product_id=${product}&qty=30`); assert.equal(pv.status, 200);
  assert.deepEqual(pv.materials.map(m => [m.qty, m.on_hand, m.short]).sort(), [[15, 100, 0], [60, 100, 0]].sort(), '30 units = 3 x the recipe for 10');
  const c = await plan(tok.production, product, 30); assert.equal(c.status, 201, JSON.stringify(c)); ids.wos.push(c.id); assert.match(c.batch_number, /^BT-\d\d-\d\d-\d{3}$/);
  let d = await wo(c.id); assert.equal(d.work_order.status, 'planned'); assert.deepEqual(d.materials.map(m => m.planned_qty).sort((x, y) => x - y), [15, 60]); assert.equal(d.can.issue, true);
  assert.equal((await api(tok.production, 'POST', `/api/work-orders/${c.id}/issue`, {})).status, 403, 'Production cannot issue from store');
  assert.equal((await api(tok.store, 'POST', `/api/work-orders/${c.id}/complete`, { finished_qty: 30 })).status, 403, 'Stores cannot record the result');
  const is = await api(tok.store, 'POST', `/api/work-orders/${c.id}/issue`, {}); assert.equal(is.status, 200, JSON.stringify(is));
  assert.equal(await onHand(A.id), 40); assert.equal(await onHand(B.id), 85);
  assert.equal((await api(tok.store, 'POST', `/api/work-orders/${c.id}/issue`, {})).status, 400, 'cannot be issued twice');
  assert.equal((await api(tok.production, 'PUT', '/api/work-orders/' + c.id, { planned_qty: 5 })).status, 400, 'cannot be changed once issued');
  assert.equal((await api(tok.production, 'POST', `/api/work-orders/${c.id}/qc`, { passed: true })).status, 403); assert.equal((await api(tok.qc, 'POST', `/api/work-orders/${c.id}/qc`, { passed: true })).status, 400, 'not finished yet');
  assert.equal((await api(tok.production, 'POST', `/api/work-orders/${c.id}/complete`, { finished_qty: 0 })).status, 400);
  const done = await api(tok.production, 'POST', `/api/work-orders/${c.id}/complete`, { finished_qty: 27, result_notes: 'Some lost in transfer' }); assert.equal(done.status, 200, JSON.stringify(done)); assert.equal(done.yield_pct, 90);
  d = await wo(c.id); assert.equal(d.work_order.status, 'completed'); assert.equal(d.work_order.yield_pct, 90); assert.equal((await api(tok.qc, 'GET', '/api/work-orders/' + c.id)).can.qc, true); assert.equal(d.can.qc, false, 'Stores see no quality buttons');
  assert.equal((await api(tok.qc, 'POST', `/api/work-orders/${c.id}/qc`, { passed: false })).status, 400, 'a failure needs a reason');
  assert.equal((await api(tok.qc, 'POST', `/api/work-orders/${c.id}/qc`, { passed: true, notes: 'Within spec' })).status, 200); d = await wo(c.id); assert.equal(d.work_order.status, 'qc_passed'); assert.equal(d.work_order.qc_by_name, 'Test qc');
  assert.equal((await api(tok.production, 'POST', `/api/work-orders/${c.id}/cancel`, { reason: 'too late now' })).status, 400, 'a finished batch cannot be cancelled');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE entity_id = $1 AND action LIKE 'work_order.%'", [c.id])).rowCount >= 4);
});
test('not enough in store: the issue is refused, says which materials, and takes nothing', async () => {
  const { product, A, B } = await mkProduct(); await adjust(tok.store, A.id, 100); await adjust(tok.store, B.id, 10);
  const c = await plan(tok.production, product, 30); ids.wos.push(c.id);          // needs 60 A and 15 B
  assert.equal((await api(tok.production, 'GET', `/api/work-orders/preview?product_id=${product}&qty=30`)).materials.find(m => m.name === B.name).short, 5);
  const is = await api(tok.store, 'POST', `/api/work-orders/${c.id}/issue`, {}); assert.equal(is.status, 409); assert.deepEqual(is.shortages.map(s => [s.name, s.wanted, s.in_store]), [[B.name, 15, 10]]);
  assert.equal(await onHand(A.id), 100); assert.equal(await onHand(B.id), 10); assert.equal((await wo(c.id)).work_order.status, 'planned');
  const part = await api(tok.store, 'POST', `/api/work-orders/${c.id}/issue`, { lines: [{ material_id: B.id, qty: 10 }] }); assert.equal(part.status, 200, 'Stores may issue less than planned'); assert.equal(await onHand(B.id), 0);
  assert.equal((await wo(c.id)).materials.find(m => m.material_id === B.id).issued_qty, 10);
});
test('two batches competing for the same stock: only one can take it', async () => {
  const { product, A, B } = await mkProduct(); await adjust(tok.store, A.id, 60); await adjust(tok.store, B.id, 15);
  const c1 = await plan(tok.production, product, 30), c2 = await plan(tok.production, product, 30); ids.wos.push(c1.id, c2.id);
  const rs = await Promise.all([api(tok.store, 'POST', `/api/work-orders/${c1.id}/issue`, {}), api(tok.store, 'POST', `/api/work-orders/${c2.id}/issue`, {})]);
  assert.deepEqual(rs.map(r => r.status).sort(), [200, 409]); assert.equal(await onHand(A.id), 0); assert.equal(await onHand(B.id), 0, 'never below zero');
});
test('cancelling: a planned batch just stops; an issued one puts its materials back; a reason is needed', async () => {
  const { product, A, B } = await mkProduct(); await adjust(tok.store, A.id, 100); await adjust(tok.store, B.id, 100);
  const c = await plan(tok.production, product, 10); ids.wos.push(c.id);
  assert.equal((await api(tok.production, 'POST', `/api/work-orders/${c.id}/cancel`, { reason: 'x' })).status, 400);
  await api(tok.store, 'POST', `/api/work-orders/${c.id}/issue`, {}); assert.equal(await onHand(A.id), 80);
  const x = await api(tok.production, 'POST', `/api/work-orders/${c.id}/cancel`, { reason: 'Customer cancelled' }); assert.equal(x.status, 200); assert.equal(x.returned, 2);
  assert.equal(await onHand(A.id), 100); assert.equal(await onHand(B.id), 100); assert.equal((await wo(c.id)).work_order.status, 'cancelled');
  const c2 = await plan(tok.production, product, 10); ids.wos.push(c2.id); assert.equal((await api(tok.production, 'POST', `/api/work-orders/${c2.id}/cancel`, { reason: 'Planned by mistake' })).status, 200); assert.equal(await onHand(A.id), 100);
});
test('changing a planned batch recalculates its materials; a product without a recipe cannot be planned', async () => {
  const { product, A } = await mkProduct(), c = await plan(tok.production, product, 10); ids.wos.push(c.id);
  assert.equal((await api(tok.production, 'PUT', '/api/work-orders/' + c.id, { planned_qty: 20, planned_date: '2026-12-01', notes: 'Bigger' })).status, 200);
  const d = await wo(c.id); assert.equal(d.work_order.planned_qty, 20); assert.equal(d.work_order.planned_date, '2026-12-01'); assert.equal(d.materials.find(m => m.material_id === A.id).planned_qty, 40);
  const bare = (await one('INSERT INTO products (name) VALUES ($1) RETURNING id', [`${TAG} no recipe`])).id; ids.products.push(bare);
  const r = await plan(tok.production, bare, 5); assert.equal(r.status, 400); assert.match(r.error, /no active recipe/);
  assert.equal((await plan(tok.production, product, 0)).status, 400); assert.equal((await plan(tok.production, 987654321, 5)).status, 400);
  assert.ok((await api(tok.production, 'GET', '/api/work-orders/products')).products.some(p => p.id === product)); assert.ok(!(await api(tok.production, 'GET', '/api/work-orders/products')).products.some(p => p.id === bare));
});
test('who may do what with work orders', async () => {
  const { product } = await mkProduct(); const c = await plan(tok.production, product, 10); ids.wos.push(c.id);
  for (const t of [tok.store, tok.qc, tok.purchase, tok.accounts]) assert.equal((await plan(t, product, 1)).status, 403, 'only Production plans');
  for (const t of [tok.production, tok.store, tok.qc, tok.purchase, tok.admin]) assert.equal((await api(t, 'GET', '/api/work-orders/' + c.id)).status, 200);
  assert.equal((await api(tok.accounts, 'GET', '/api/work-orders')).status, 403); assert.equal((await api(null, 'GET', '/api/work-orders')).status, 401); assert.equal((await api(tok.store, 'GET', '/api/work-orders/987654321')).status, 404);
  const list = await api(tok.qc, 'GET', '/api/work-orders?status=planned&q=' + encodeURIComponent(c.batch_number)); assert.ok(list.work_orders.some(w => w.id === c.id));
});
test('removing records: a material with stock or batches cannot be removed; removing a receipt takes its stock back out', async () => {
  const A = await mkMat('Removal acid'); await adjust(tok.store, A.id, 5);
  const rm = await api(tok.admin, 'POST', '/api/admin/data/records/material/delete', { ids: [A.id], confirm: (await one('SELECT code FROM raw_materials WHERE id = $1', [A.id])).code, reason: 'cleaning up test data' }); assert.equal(rm.status, 409, JSON.stringify(rm)); assert.match(rm.error, /stock records/);
  const g = await mkGrn([{ name: A.name, qty: 7 }], true); assert.equal(await onHand(A.id), 12);
  assert.equal((await api(tok.admin, 'POST', '/api/admin/data/records/grn/delete', { ids: [g.grn_id], confirm: g.grn_number, reason: 'cleaning up test data' })).status, 200); assert.equal(await onHand(A.id), 5);
});
test('the pages and menu entries exist', () => {
  const root = path.join(__dirname, '..', '..', 'frontend'); for (const f of ['stock.html', 'work-orders.html', 'work-order-form.html', 'work-order.html']) assert.ok(fs.existsSync(path.join(root, f)), f);
  const w = fs.readFileSync(path.join(__dirname, '..', 'workspaces.js'), 'utf8'); for (const h of ['work-orders.html', 'stock.html', 'work-orders.html?status=completed', 'work-orders.html?status=planned']) assert.ok(w.includes(h), h);
});
