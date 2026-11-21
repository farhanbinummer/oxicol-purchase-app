// A purchase order that buys only SOME lines of a request: the other lines stay open, and come back if the order is deleted.
//   node --test tests/partial-po.test.js
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

const PORT = 3301, BASE = `http://localhost:${PORT}`, TAG = 'ZZQ' + crypto.randomBytes(3).toString('hex').toUpperCase();
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
    await pool.query('DELETE FROM purchase_orders WHERE id = ANY($1)', [made.pos.length ? made.pos : [0]]);
    await pool.query('DELETE FROM production_indents WHERE id = ANY($1)', [made2.indents.length ? made2.indents : [0]]);
    await pool.query('DELETE FROM suppliers WHERE id = ANY($1)', [made.suppliers.length ? made.suppliers : [0]]);
    await pool.query('DELETE FROM audit_log WHERE actor_id = ANY($1)', [made.users.length ? made.users : [0]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users.length ? made.users : [0]]);
  } finally { server && server.kill(); await pool.end(); }
});




const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
const made2 = { indents: [], reqs: [] };
async function mkIndent(names) {
  const r = await one("INSERT INTO production_indents (indent_number, production_head, status) VALUES ($1,'Head','approved') RETURNING id", [`${TAG}-IND${++seq}`]); made2.indents.push(r.id);
  for (const n of names) await pool.query("INSERT INTO production_indent_items (indent_id, item_name, quantity, unit) VALUES ($1,$2,5,'Kg')", [r.id, `${TAG} ${n}`]); return r.id;
}
const statusOf = async (id) => (await one('SELECT status FROM production_indents WHERE id = $1', [id])).status;
const listed = async (id) => { const d = await api(tok.purchase, 'GET', '/api/consolidate/all'); const x = d.production_indents.find(i => i.id === id); return x ? x.items.map(i => i.item_name.replace(TAG + ' ', '')) : []; };
const buy = (sid, ind, names, extra = {}) => api(tok.purchase, 'POST', '/api/consolidate/create-po', { supplier_id: sid, production_indent_ids: [ind], items: names.map(n => ({ item_name: `${TAG} ${n}`, quantity: 5, unit: 'Kg', rate: 10 })), ...extra });

test('buying some lines leaves the others open; buying the rest completes the request', async () => {
  const sid = await mkSupplier(), ind = await mkIndent(['A', 'B', 'C']);
  const p1 = await buy(sid, ind, ['A']); assert.equal(p1.status, 201, JSON.stringify(p1)); made.pos.push(p1.po_id);
  assert.equal(await statusOf(ind), 'approved', 'still waiting for B and C'); assert.deepEqual(await listed(ind), ['B', 'C'], 'only the unbought lines are offered again');
  const p2 = await buy(sid, ind, ['B', 'C']); assert.equal(p2.status, 201, JSON.stringify(p2)); made.pos.push(p2.po_id);
  assert.equal(await statusOf(ind), 'po_raised'); assert.deepEqual(await listed(ind), []);
  assert.equal((await pool.query('SELECT 1 FROM po_source_links WHERE source_id = $1 AND source_type = $2', [ind, 'production'])).rowCount, 2, 'both orders are linked');
});
test('deleting an order brings back exactly the lines it bought', async () => {
  const sid = await mkSupplier(), ind = await mkIndent(['A', 'B']);
  const p1 = await buy(sid, ind, ['A']), p2 = await buy(sid, ind, ['B']); made.pos.push(p1.po_id, p2.po_id); assert.equal(await statusOf(ind), 'po_raised');
  assert.equal((await api(tok.admin, 'DELETE', '/api/po/' + p1.po_id)).status, 200);
  assert.equal(await statusOf(ind), 'approved'); assert.deepEqual(await listed(ind), ['A']);
  assert.equal((await api(tok.admin, 'DELETE', '/api/po/' + p2.po_id)).status, 200); assert.deepEqual((await listed(ind)).sort(), ['A', 'B']);
});
test('a request with nothing in the order is refused, and the same line is never bought twice', async () => {
  const sid = await mkSupplier(), ind = await mkIndent(['A', 'B']);
  const none = await buy(sid, ind, ['Z']); assert.equal(none.status, 400); assert.match(none.error, /nothing in this order/);
  const p1 = await buy(sid, ind, ['A']); made.pos.push(p1.po_id); const again = await buy(sid, ind, ['A']); assert.equal(again.status, 400, 'A is already on an order');
  assert.equal(await statusOf(ind), 'approved');
});
test('requests that were already raised before this change keep working: all lines count as ordered', async () => {
  const sid = await mkSupplier(), ind = await mkIndent(['A', 'B']);
  const p = await buy(sid, ind, ['A', 'B']); made.pos.push(p.po_id); await pool.query('UPDATE production_indent_items SET ordered_in_po = NULL WHERE indent_id = $1', [ind]);   // as old data
  assert.equal((await api(tok.admin, 'DELETE', '/api/po/' + p.po_id)).status, 200); assert.equal(await statusOf(ind), 'approved'); assert.deepEqual((await listed(ind)).sort(), ['A', 'B']);
});
