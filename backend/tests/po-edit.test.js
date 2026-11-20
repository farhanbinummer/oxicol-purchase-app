// Editing a purchase order: who may, until when, what is recalculated, and that it is written to the audit history.
//   node --test tests/po-edit.test.js
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

const PORT = 3300, BASE = `http://localhost:${PORT}`, TAG = 'ZZE' + crypto.randomBytes(3).toString('hex').toUpperCase();
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
  tok.admin = await mkUser('admin'); tok.purchase = await mkUser('purchase'); tok.store = await mkUser('store'); tok.accounts = await mkUser('accounts');
});
test.after(async () => {
  try {
    await pool.query('DELETE FROM payments WHERE po_id = ANY($1)', [made.pos.length ? made.pos : [0]]);
    await pool.query('DELETE FROM grn_notes WHERE po_id = ANY($1)', [made.pos.length ? made.pos : [0]]);
    await pool.query('DELETE FROM purchase_orders WHERE id = ANY($1)', [made.pos.length ? made.pos : [0]]);
    await pool.query('DELETE FROM suppliers WHERE id = ANY($1)', [made.suppliers.length ? made.suppliers : [0]]);
    await pool.query('DELETE FROM audit_log WHERE actor_id = ANY($1)', [made.users.length ? made.users : [0]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users.length ? made.users : [0]]);
  } finally { server && server.kill(); await pool.end(); }
});


const items2 = [{ item_name: 'Wax', quantity: 10, unit: 'Kg', rate: 100 }, { item_name: 'Cloth', quantity: 2, unit: 'Nos', rate: 50 }];
const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
async function newPo(s) { const c = await api(tok.purchase, 'POST', '/api/po/create', { supplier_id: s, items: [{ item_name: 'Resin', quantity: 1, unit: 'Kg', rate: 10 }] }); assert.equal(c.status, 201, JSON.stringify(c)); made.pos.push(c.po_id); return c.po_id; }

test('an order can be changed: supplier, items, rates, date and notes; totals and tax are recalculated; the number and reference stay', async () => {
  const s1 = await mkSupplier(), s2 = await mkSupplier(), id = await newPo(s1), before = await one('SELECT po_number, po_ref FROM purchase_orders WHERE id = $1', [id]);
  const r = await api(tok.purchase, 'PUT', '/api/po/' + id, { supplier_id: s2, delivery_date: '2026-12-15', notes: 'Changed', items: items2 }); assert.equal(r.status, 200, JSON.stringify(r));
  assert.deepEqual([r.subtotal, r.cgst_amount, r.sgst_amount, r.total_amount], [1100, 99, 99, 1298]);
  const po = await one("SELECT supplier_id, to_char(delivery_date,'YYYY-MM-DD') AS d, notes, subtotal::float, total_amount::float, po_number, po_ref FROM purchase_orders WHERE id = $1", [id]);
  assert.deepEqual([po.supplier_id, po.d, po.notes, po.subtotal, po.total_amount, po.po_number, po.po_ref], [s2, '2026-12-15', 'Changed', 1100, 1298, before.po_number, before.po_ref]);
  const lines = (await pool.query('SELECT item_name, quantity::float, rate::float, line_amount::float FROM po_items WHERE po_id = $1 ORDER BY id', [id])).rows;
  assert.deepEqual(lines, [{ item_name: 'Wax', quantity: 10, rate: 100, line_amount: 1000 }, { item_name: 'Cloth', quantity: 2, rate: 50, line_amount: 100 }]);
});
test('the change is in the audit history with what it was before', async () => {
  const s = await mkSupplier(), id = await newPo(s);
  assert.equal((await api(tok.admin, 'PUT', '/api/po/' + id, { supplier_id: s, items: items2 })).status, 200);
  const a = await one("SELECT * FROM audit_log WHERE action = 'po.edit' AND entity_id = $1", [id]);
  assert.equal(a.before_data.items[0].item_name, 'Resin'); assert.equal(a.after_data.total_amount, 1298); assert.equal(a.actor_role, 'admin'); assert.match(a.summary, /edited/);
});
test('it is refused once a payment or goods receipt exists (a failed payment does not count), or the order has moved on', async () => {
  const s = await mkSupplier(), id = await newPo(s), put = () => api(tok.purchase, 'PUT', '/api/po/' + id, { supplier_id: s, items: items2 });
  const pay = (await one("INSERT INTO payments (payment_id, po_id, supplier_id, amount, payment_mode, status) VALUES ($1,$2,$3,11,'cash','failed') RETURNING id", [`${TAG}-P1`, id, s])).id;
  assert.equal((await put()).status, 200, 'a failed payment leaves it editable');
  await pool.query("UPDATE payments SET status = 'confirmed' WHERE id = $1", [pay]); assert.equal((await put()).status, 400);
  await pool.query('DELETE FROM payments WHERE id = $1', [pay]); assert.equal((await put()).status, 200);
  await pool.query("INSERT INTO grn_notes (grn_number, po_id, received_by, total_items) VALUES ($1,$2,'x',1)", [`${TAG}-G1`, id]); assert.equal((await put()).status, 400);
  await pool.query('DELETE FROM grn_notes WHERE po_id = $1', [id]); await pool.query("UPDATE purchase_orders SET status = 'in_transit' WHERE id = $1", [id]); assert.equal((await put()).status, 400);
  assert.equal((await one('SELECT total_amount::float AS t FROM purchase_orders WHERE id = $1', [id])).t, 1298, 'a refused edit changes nothing');
});
test('bad input changes nothing, and only people who may edit can edit', async () => {
  const s = await mkSupplier(), id = await newPo(s), url = '/api/po/' + id, was = (await one('SELECT total_amount::float AS t FROM purchase_orders WHERE id = $1', [id])).t;
  for (const body of [{ supplier_id: s, items: [] }, { supplier_id: s, items: [{ item_name: 'x', quantity: 0, unit: 'Kg', rate: 1 }] }, { supplier_id: 999999999, items: items2 }, { items: items2 }, { supplier_id: s, delivery_date: 'soon', items: items2 }])
    assert.equal((await api(tok.purchase, 'PUT', url, body)).status, 400, JSON.stringify(body));
  assert.equal((await one('SELECT total_amount::float AS t FROM purchase_orders WHERE id = $1', [id])).t, was);
  assert.equal((await api(tok.store, 'PUT', url, { supplier_id: s, items: items2 })).status, 403); assert.equal((await api(tok.accounts, 'PUT', url, { supplier_id: s, items: items2 })).status, 403);
  assert.equal((await api(null, 'PUT', url, { supplier_id: s, items: items2 })).status, 401); assert.equal((await api(tok.purchase, 'PUT', '/api/po/987654321', { supplier_id: s, items: items2 })).status, 404);
});
test('the order page offers Edit, and the form can load and save an existing order', () => {
  const root = path.join(__dirname, '..', '..', 'frontend'), d = fs.readFileSync(path.join(root, 'po-detail.html'), 'utf8'), f = fs.readFileSync(path.join(root, 'po-form.html'), 'utf8');
  assert.match(d, /po-form\.html\?edit=/); assert.match(d, /oxiCan\('po\.edit'\)/); assert.match(f, /method: editId \? 'PUT' : 'POST'/);
});
