// Administrator removal of any kind of record (orders, receipts, payments, invoices, requests, suppliers, materials, products).
// A real server on its own port; everything created is removed afterwards.
//   node --test tests/admin-records.test.js
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
const { primaryRole } = require('../access');

const PORT = 3289, BASE = `http://localhost:${PORT}`, TAG = 'ZZR' + crypto.randomBytes(3).toString('hex').toUpperCase();
const made = { users: [], suppliers: [], pos: [], reqs: [], indents: [], products: [], materials: [] }; const tok = {}; let server, seq = 0;
async function api(token, method, url, body) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await res.json(); } catch (e) {} return { ...j, status: res.status };
}
async function mkUser(role) {
  const hash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 4);
  const r = await pool.query('INSERT INTO users (username, password_hash, name, role) VALUES ($1,$2,$3,$4) RETURNING id', [`${TAG}_${role}`.toLowerCase(), hash, `Test ${role}`, primaryRole([role])]);
  made.users.push(r.rows[0].id); await pool.query('INSERT INTO user_roles (user_id, role) VALUES ($1,$2)', [r.rows[0].id, role]); return createSession(r.rows[0].id);
}
const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
const count = async (sql, p) => (await pool.query(sql, p)).rows[0].n;
const gone = async (table, col, id) => assert.equal(await count(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${col} = $1`, [id]), 0, `${table} still has rows for ${id}`);
const del = (kind, ids, confirm, reason = 'cleaning up test data') => api(tok.admin, 'POST', `/api/admin/data/records/${kind}/delete`, { ids, confirm, reason });

async function mkSupplier(name) { const id = (await one('INSERT INTO suppliers (name) VALUES ($1) RETURNING id', [`${TAG} ${name || 'supplier'} ${++seq}`])).id; made.suppliers.push(id); return id; }
/** A purchase order with two lines, a payment, a goods receipt (one line), an invoice and its match. */
async function mkOrder(supplier) {
  const n = ++seq, sid = supplier || await mkSupplier();
  const po = (await one("INSERT INTO purchase_orders (po_number, supplier_id, subtotal, total_amount, status) VALUES ($1,$2,100,118,'payment_done') RETURNING id", [`${TAG}-PO${n}`, sid])).id; made.pos.push(po);
  await pool.query("INSERT INTO po_items (po_id, item_name, quantity, unit, rate, line_amount) VALUES ($1,'Wax',1,'Kg',50,50),($1,'Cloth',1,'Nos',50,50)", [po]);
  const pay = (await one("INSERT INTO payments (payment_id, po_id, supplier_id, amount, payment_mode, status) VALUES ($1,$2,$3,118,'cash','confirmed') RETURNING id", [`${TAG}-PAY${n}`, po, sid])).id;
  const grn = (await one("INSERT INTO grn_notes (grn_number, po_id, received_by, total_items) VALUES ($1,$2,'x',1) RETURNING id", [`${TAG}-GRN${n}`, po])).id;
  await pool.query("INSERT INTO grn_items (grn_id, item_name, po_quantity, received_quantity, variance) VALUES ($1,'Wax',1,1,0)", [grn]);
  const inv = (await one("INSERT INTO purchase_invoices (invoice_number, po_id, invoice_date, invoice_amount) VALUES ($1,$2,CURRENT_DATE,118) RETURNING id", [`${TAG}-INV${n}`, po])).id;
  const m = (await one("INSERT INTO three_way_match (invoice_id, po_id, po_total, grn_total, invoice_total, variance_amount, status) VALUES ($1,$2,118,118,118,0,'matched') RETURNING id", [inv, po])).id;
  return { po, number: `${TAG}-PO${n}`, pay, grn, inv, m, sid, payNo: `${TAG}-PAY${n}`, grnNo: `${TAG}-GRN${n}`, invNo: `${TAG}-INV${n}` };
}
async function mkRequest(status = 'approved') {
  const n = ++seq, id = (await one("INSERT INTO branch_stock_requests (request_number, branch, requested_by, status) VALUES ($1,'Kannur','x',$2) RETURNING id", [`${TAG}-REQ${n}`, status])).id; made.reqs.push(id);
  await pool.query("INSERT INTO branch_request_items (request_id, item_name, quantity, unit) VALUES ($1,'Shampoo',5,'Nos')", [id]); return { id, number: `${TAG}-REQ${n}` };
}
async function mkIndent(status = 'approved') {
  const n = ++seq, id = (await one("INSERT INTO production_indents (indent_number, production_head, status) VALUES ($1,'Head',$2) RETURNING id", [`${TAG}-IND${n}`, status])).id; made.indents.push(id);
  await pool.query("INSERT INTO production_indent_items (indent_id, item_name, quantity, unit) VALUES ($1,'Resin',3,'Kg')", [id]); return { id, number: `${TAG}-IND${n}` };
}

test.before(async () => {
  await runMigrations();
  server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), NOTIFY_TEST_MODE: '1' }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch (e) {} await new Promise(r => setTimeout(r, 250)); }
  tok.admin = await mkUser('admin'); tok.manager = await mkUser('manager'); tok.purchase = await mkUser('purchase');
});
test.after(async () => {
  try {
    await pool.query('DELETE FROM material_plans WHERE request_id = ANY($1) OR indent_id = ANY($2)', [made.reqs.length ? made.reqs : [0], made.indents.length ? made.indents : [0]]);
    await pool.query('DELETE FROM po_source_links WHERE po_id = ANY($1)', [made.pos.length ? made.pos : [0]]);
    await pool.query('DELETE FROM three_way_match WHERE po_id = ANY($1)', [made.pos.length ? made.pos : [0]]);
    await pool.query('DELETE FROM purchase_invoices WHERE po_id = ANY($1)', [made.pos.length ? made.pos : [0]]);
    await pool.query('DELETE FROM payments WHERE po_id = ANY($1)', [made.pos.length ? made.pos : [0]]);
    await pool.query('DELETE FROM grn_notes WHERE po_id = ANY($1)', [made.pos.length ? made.pos : [0]]);
    await pool.query('DELETE FROM purchase_orders WHERE id = ANY($1)', [made.pos.length ? made.pos : [0]]);
    await pool.query('DELETE FROM branch_stock_requests WHERE id = ANY($1)', [made.reqs.length ? made.reqs : [0]]);
    await pool.query('DELETE FROM production_indents WHERE id = ANY($1)', [made.indents.length ? made.indents : [0]]);
    await pool.query('DELETE FROM products WHERE id = ANY($1)', [made.products.length ? made.products : [0]]);
    await pool.query('DELETE FROM raw_materials WHERE id = ANY($1)', [made.materials.length ? made.materials : [0]]);
    await pool.query('DELETE FROM suppliers WHERE id = ANY($1)', [made.suppliers.length ? made.suppliers : [0]]);
    await pool.query('DELETE FROM audit_log WHERE actor_id = ANY($1)', [made.users.length ? made.users : [0]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users.length ? made.users : [0]]);
  } finally { server && server.kill(); await pool.end(); }
});

test('only an administrator may list or remove anything', async () => {
  const o = await mkOrder();
  for (const token of [tok.manager, tok.purchase, null]) {
    const want = token ? 403 : 401;
    assert.equal((await api(token, 'GET', '/api/admin/data/records')).status, want);
    assert.equal((await api(token, 'GET', '/api/admin/data/records/po')).status, want);
    assert.equal((await api(token, 'POST', '/api/admin/data/records/po/delete', { ids: [o.po], confirm: o.number, reason: 'not allowed' })).status, want);
  }
  assert.equal(await count('SELECT COUNT(*)::int AS n FROM purchase_orders WHERE id = $1', [o.po]), 1);
});

test('every kind is offered, listed with what is under each record, and searchable', async () => {
  const k = await api(tok.admin, 'GET', '/api/admin/data/records'); assert.deepEqual(k.kinds.map(x => x.kind), ['rd_project', 'po', 'grn', 'payment', 'invoice', 'branch_request', 'indent', 'supplier', 'material', 'product']);
  const o = await mkOrder();
  const l = await api(tok.admin, 'GET', '/api/admin/data/records/po?q=' + o.number); const row = l.rows.find(r => r.id === o.po); assert.ok(row);
  assert.deepEqual(row.counts, { Items: 2, Payments: 1, 'Goods receipts': 1, Invoices: 1 }); assert.equal(row.amount, 118); assert.equal(row.blocked, null);
  for (const kind of k.kinds.map(x => x.kind)) assert.equal((await api(tok.admin, 'GET', `/api/admin/data/records/${kind}?q=${TAG}`)).status, 200, kind);
  assert.equal((await api(tok.admin, 'GET', '/api/admin/data/records/nonsense')).status, 404); assert.equal((await api(tok.admin, 'POST', '/api/admin/data/records/nonsense/delete', { ids: [1] })).status, 404);
});

test('a wrong confirmation, no reason, or a bad list removes nothing', async () => {
  const o = await mkOrder();
  assert.equal((await del('po', [o.po], 'nope')).status, 400); assert.equal((await del('po', [o.po], '')).status, 400); assert.equal((await del('po', [o.po], o.number, '')).status, 400); assert.equal((await del('po', [o.po], o.number, 'abc')).status, 400);
  assert.equal((await del('po', [], o.number)).status, 400); assert.equal((await del('po', Array.from({ length: 51 }, (_, i) => i + 1), 'x')).status, 400);
  assert.equal((await del('po', [o.po, 987654321], 'DELETE 2 PURCHASE ORDERS')).status, 404, 'one of them does not exist');
  assert.equal(await count('SELECT COUNT(*)::int AS n FROM purchase_orders WHERE id = $1', [o.po]), 1);
});

test('purchase order: removed with its lines, payments, receipts and invoices; other orders and the supplier stay; audited with the amount', async () => {
  const a = await mkOrder(), b = await mkOrder(a.sid);
  const r = await del('po', [a.po], a.number, 'ordered by mistake'); assert.equal(r.status, 200, JSON.stringify(r)); assert.equal(r.removed, 1);
  await gone('purchase_orders', 'id', a.po); await gone('po_items', 'po_id', a.po); await gone('payments', 'id', a.pay); await gone('grn_notes', 'id', a.grn); await gone('grn_items', 'grn_id', a.grn); await gone('purchase_invoices', 'id', a.inv); await gone('three_way_match', 'id', a.m);
  assert.equal(await count('SELECT COUNT(*)::int AS n FROM purchase_orders WHERE id = $1', [b.po]), 1, 'the other order is untouched'); assert.equal(await count('SELECT COUNT(*)::int AS n FROM payments WHERE id = $1', [b.pay]), 1); assert.equal(await count('SELECT COUNT(*)::int AS n FROM suppliers WHERE id = $1', [a.sid]), 1);
  const log = await one("SELECT * FROM audit_log WHERE action = 'admin.po_delete' AND entity_id = $1", [a.po]); assert.equal(log.reason, 'ordered by mistake'); assert.equal(log.actor_id, made.users[0]); assert.equal(log.before_data.total_amount, 118); assert.equal(log.before_data.under_it.Payments, 1); assert.match(log.summary, /1 payments/);
});

test('removing an order sends its requests back to "approved" unless another order still covers them', async () => {
  const req = await mkRequest('po_raised'), ind = await mkIndent('po_raised'), a = await mkOrder(), b = await mkOrder();
  await pool.query("INSERT INTO po_source_links (po_id, source_type, source_id) VALUES ($1,'branch',$2),($1,'production',$3),($4,'branch',$2)", [a.po, req.id, ind.id, b.po]);
  await del('po', [a.po], a.number);
  assert.equal((await one('SELECT status FROM branch_stock_requests WHERE id = $1', [req.id])).status, 'po_raised', 'the second order still covers it');
  assert.equal((await one('SELECT status FROM production_indents WHERE id = $1', [ind.id])).status, 'approved', 'no order left: waiting for one again');
  await del('po', [b.po], b.number);
  assert.equal((await one('SELECT status FROM branch_stock_requests WHERE id = $1', [req.id])).status, 'approved');
});

test('goods receipt, payment and invoice can each be removed on their own', async () => {
  const o = await mkOrder();
  assert.equal((await del('grn', [o.grn], o.grnNo)).status, 200); await gone('grn_notes', 'id', o.grn); await gone('grn_items', 'grn_id', o.grn);
  assert.equal((await del('payment', [o.pay], o.payNo)).status, 200); await gone('payments', 'id', o.pay);
  assert.equal((await del('invoice', [o.inv], o.invNo)).status, 200); await gone('purchase_invoices', 'id', o.inv); await gone('three_way_match', 'id', o.m);
  assert.equal(await count('SELECT COUNT(*)::int AS n FROM purchase_orders WHERE id = $1', [o.po]), 1, 'the order itself stays');
  const log = await one("SELECT before_data FROM audit_log WHERE action = 'admin.payment_delete' AND entity_id = $1", [o.pay]); assert.equal(log.before_data.amount, 118);
});

test('branch request and production request: lines, plans and links go; what pointed at them is cleaned up; orders stay', async () => {
  const req = await mkRequest(), ind = await mkIndent(), o = await mkOrder();
  await pool.query("INSERT INTO material_plans (request_id, indent_id, basis, inputs) VALUES ($1,$2,'x','{}')", [req.id, ind.id]);
  await pool.query("UPDATE branch_stock_requests SET planned_indent_id = $1 WHERE id = $2", [ind.id, req.id]);
  await pool.query("INSERT INTO po_source_links (po_id, source_type, source_id) VALUES ($1,'production',$2),($1,'branch',$3)", [o.po, ind.id, req.id]);
  assert.equal((await del('indent', [ind.id], ind.number)).status, 200);
  await gone('production_indents', 'id', ind.id); await gone('production_indent_items', 'indent_id', ind.id); await gone('material_plans', 'indent_id', ind.id);
  assert.equal((await one('SELECT planned_indent_id FROM branch_stock_requests WHERE id = $1', [req.id])).planned_indent_id, null, 'the request is not "planned" any more');
  assert.equal((await del('branch_request', [req.id], req.number)).status, 200);
  await gone('branch_stock_requests', 'id', req.id); await gone('branch_request_items', 'request_id', req.id); await gone('po_source_links', 'po_id', o.po);
  assert.equal(await count('SELECT COUNT(*)::int AS n FROM purchase_orders WHERE id = $1', [o.po]), 1, 'the order stays');
});

test('a supplier, raw material or product that is still in use cannot be removed; unused ones can', async () => {
  const used = await mkSupplier('used'); await mkOrder(used); const free = await mkSupplier('free');
  const l = await api(tok.admin, 'GET', '/api/admin/data/records/supplier?q=' + TAG); assert.match(l.rows.find(r => r.id === used).blocked, /Used by 1 purchase order and 1 payment\./); assert.equal(l.rows.find(r => r.id === free).blocked, null);
  const stop = await del('supplier', [used], 'DELETE'); assert.equal(stop.status, 409); assert.match(stop.error, /Remove those first/);
  assert.equal((await del('supplier', [used, free], 'DELETE 2 SUPPLIERS')).status, 409); assert.equal(await count('SELECT COUNT(*)::int AS n FROM suppliers WHERE id = $1', [free]), 1, 'all or nothing');
  assert.equal((await del('supplier', [free], 'DELETE')).status, 200);
  // materials: one used in a recipe, one not
  const prod = (await one("INSERT INTO products (name) VALUES ($1) RETURNING id", [TAG + ' product'])).id; made.products.push(prod);
  const m1 = (await one("INSERT INTO raw_materials (code, name, unit) VALUES ($1,$2,'Kg') RETURNING id", [TAG + 'M1', TAG + ' used material'])).id, m2 = (await one("INSERT INTO raw_materials (code, name, unit) VALUES ($1,$2,'Kg') RETURNING id", [TAG + 'M2', TAG + ' free material'])).id; made.materials.push(m1, m2);
  const rv = (await one("INSERT INTO recipe_versions (product_id, version, base_output_qty) VALUES ($1,1,1) RETURNING id", [prod])).id; await pool.query('INSERT INTO bom_lines (product_id, material_id, qty_per_unit, recipe_id) VALUES ($1,$2,1,$3)', [prod, m1, rv]);
  assert.equal((await del('material', [m1], TAG + 'M1')).status, 409); assert.equal((await del('material', [m2], TAG + 'M2')).status, 200); await gone('raw_materials', 'id', m2);
  // product: requested by a branch -> blocked; remove the request, then it goes with its recipe
  const req = await mkRequest(); await pool.query('UPDATE branch_request_items SET product_id = $1 WHERE request_id = $2', [prod, req.id]);
  assert.equal((await del('product', [prod], 'wrong text')).status, 400, 'the confirm text is the product code or DELETE');
  const code = (await one('SELECT code FROM products WHERE id = $1', [prod])).code || 'DELETE';
  assert.equal((await del('product', [prod], code)).status, 409);
  await del('branch_request', [req.id], req.number);
  assert.equal((await del('product', [prod], code)).status, 200); await gone('products', 'id', prod); await gone('recipe_versions', 'product_id', prod); await gone('bom_lines', 'product_id', prod);
  assert.equal(await count('SELECT COUNT(*)::int AS n FROM raw_materials WHERE id = $1', [m1]), 1, 'the material itself stays');
});

test('several at once need "DELETE n ..." and are all-or-nothing; the audit history is never removed', async () => {
  const a = await mkOrder(), b = await mkOrder();
  assert.equal((await del('po', [a.po, b.po], 'DELETE')).status, 400);
  const r = await del('po', [a.po, b.po], 'DELETE 2 PURCHASE ORDERS'); assert.equal(r.removed, 2);
  assert.equal(await count("SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'admin.po_delete' AND entity_id = ANY($1)", [[a.po, b.po]]), 2);
  const res = await fetch(`${BASE}/api/admin/data/records/audit_log/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok.admin }, body: JSON.stringify({ ids: [1], confirm: 'DELETE', reason: 'try to hide it' }) });
  assert.equal(res.status, 404, 'there is no way to remove audit entries');
});
