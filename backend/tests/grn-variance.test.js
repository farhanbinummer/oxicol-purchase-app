// Goods receipt: the variance can be typed, and a reason can be written for a difference.
//   node --test tests/grn-variance.test.js
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

const PORT = 3305, BASE = `http://localhost:${PORT}`, TAG = 'ZZV' + crypto.randomBytes(3).toString('hex').toUpperCase();
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
    await pool.query('DELETE FROM po_source_links WHERE po_id = ANY($1)', [made.pos.length ? made.pos : [0]]);
    await pool.query('DELETE FROM po_source_links WHERE po_id = ANY($1)', [made.pos.length ? made.pos : [0]]);
    await pool.query('DELETE FROM po_source_links WHERE po_id = ANY($1)', [made.pos.length ? made.pos : [0]]);
    await pool.query('DELETE FROM po_source_links WHERE po_id = ANY($1)', [made.pos.length ? made.pos : [0]]);
    await pool.query('DELETE FROM grn_notes WHERE po_id = ANY($1)', [made.pos.length ? made.pos : [0]]);
    await pool.query('DELETE FROM purchase_orders WHERE id = ANY($1)', [made.pos.length ? made.pos : [0]]);
    await pool.query('DELETE FROM suppliers WHERE id = ANY($1)', [made.suppliers.length ? made.suppliers : [0]]);
    await pool.query('DELETE FROM audit_log WHERE actor_id = ANY($1)', [made.users.length ? made.users : [0]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users.length ? made.users : [0]]);
  } finally { server && server.kill(); await pool.end(); }
});








const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
async function mkPo() {
  const s = (await one('INSERT INTO suppliers (name) VALUES ($1) RETURNING id', [`${TAG} sup ${++seq}`])).id; made.suppliers.push(s);
  const po = (await one("INSERT INTO purchase_orders (po_number, supplier_id, subtotal, total_amount, status) VALUES ($1,$2,100,118,'payment_done') RETURNING id", [`${TAG}-PO${++seq}`, s])).id; made.pos.push(po);
  const its = [(await one("INSERT INTO po_items (po_id, item_name, quantity, unit, rate, line_amount) VALUES ($1,'Wax',10,'Kg',5,50) RETURNING id", [po])).id, (await one("INSERT INTO po_items (po_id, item_name, quantity, unit, rate, line_amount) VALUES ($1,'Cloth',4,'Nos',12.5,50) RETURNING id", [po])).id];
  return { po, its };
}
const grn = (t, po, items) => api(t, 'POST', '/api/grn/create', { po_id: po, items });

test('a reason can be written for a difference; it is saved, shown on the receipt and kept with the variance', async () => {
  const { po, its } = await mkPo();
  const r = await grn(tok.store, po, [{ po_item_id: its[0], received_qty: 7, condition: 'Short', variance_note: '  2 bags torn, rest to follow  ' }, { po_item_id: its[1], received_qty: 4, condition: 'Good' }]);
  assert.equal(r.status, 201, JSON.stringify(r));
  const d = await api(tok.store, 'GET', '/api/grn/' + r.grn_id); const wax = d.items.find(i => i.item_name === 'Wax'), cloth = d.items.find(i => i.item_name === 'Cloth');
  assert.equal(Number(wax.variance), -3); assert.equal(wax.variance_note, '2 bags torn, rest to follow'); assert.equal(cloth.variance_note, null); assert.equal(d.discrepancies, true);
});
test('a reason longer than 200 characters is refused and nothing is saved', async () => {
  const { po, its } = await mkPo();
  const r = await grn(tok.store, po, [{ po_item_id: its[0], received_qty: 7, variance_note: 'x'.repeat(201) }, { po_item_id: its[1], received_qty: 4 }]);
  assert.equal(r.status, 400); assert.equal((await one('SELECT COUNT(*)::int n FROM grn_notes WHERE po_id = $1', [po])).n, 0);
});
test('the form has a Variance box that can be typed in (received follows it) and a reason box per item', () => {
  const root = path.join(__dirname, '..', '..', 'frontend'), f = fs.readFileSync(path.join(root, 'grn-form.html'), 'utf8'), d = fs.readFileSync(path.join(root, 'grn-detail.html'), 'utf8');
  assert.match(f, /className = 'varin'/); assert.match(f, /recalc\('variance'\)/); assert.match(f, /variance_note: tr\.querySelector\('\.vnote'\)\.value/); assert.match(d, /Reason for the difference/);
});
