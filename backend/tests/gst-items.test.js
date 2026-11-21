// GST rate per item: each order line may carry its own rate (0, 5, 12, 18, 28 ...); tax is worked out per rate.
//   node --test tests/gst-items.test.js
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
const T = require('../tax');

test('tax is worked out on the total of each rate, CGST and SGST equal, IGST for another state', () => {
  const L = [{ amount: 1000, rate: 5 }, { amount: 2000, rate: 18 }, { amount: 500, rate: null }, { amount: 100, rate: 0 }];   // blank = 18
  assert.deepEqual(T.taxLines(L, 'intra'), { cgst: 250, sgst: 250, igst: 0, total: 4100, subtotal: 3600 });
  assert.deepEqual(T.taxLines(L, 'inter'), { cgst: 0, sgst: 0, igst: 500, total: 4100, subtotal: 3600 });
  assert.deepEqual(T.taxLines([{ amount: 58920, rate: null }], 'intra'), { cgst: 5302.8, sgst: 5302.8, igst: 0, total: 69525.6, subtotal: 58920 }, 'as before when no item has its own rate');
  assert.equal(T.taxLines([{ amount: 333.33, rate: 5 }], 'intra').cgst, 8.33);
  assert.equal(T.cleanRate('12'), 12); assert.equal(T.cleanRate(''), null); assert.equal(T.cleanRate(undefined), null); assert.equal(T.cleanRate('13'), undefined); assert.equal(T.cleanRate('abc'), undefined);
});

const PORT = 3304, BASE = `http://localhost:${PORT}`, TAG = 'ZZI' + crypto.randomBytes(3).toString('hex').toUpperCase();
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
    await pool.query('DELETE FROM purchase_orders WHERE id = ANY($1)', [made.pos.length ? made.pos : [0]]);
    await pool.query('DELETE FROM production_indents WHERE id = ANY($1)', [ids.indents.length ? ids.indents : [0]]);
    await pool.query('DELETE FROM production_indents WHERE id = ANY($1)', [ids.indents.length ? ids.indents : [0]]);
    await pool.query('DELETE FROM production_indents WHERE id = ANY($1)', [ids.indents.length ? ids.indents : [0]]);
    await pool.query('DELETE FROM rate_enquiries WHERE id = ANY($1)', [ids.enq && ids.enq.length ? ids.enq : [0]]);
    await pool.query('DELETE FROM production_indents WHERE id = ANY($1)', [ids.indents.length ? ids.indents : [0]]);
    await pool.query('DELETE FROM raw_materials WHERE id = ANY($1)', [ids.materials.length ? ids.materials : [0]]);
    await pool.query('DELETE FROM suppliers WHERE id = ANY($1)', [made.suppliers.length ? made.suppliers : [0]]);
    await pool.query('DELETE FROM audit_log WHERE actor_id = ANY($1)', [made.users.length ? made.users : [0]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users.length ? made.users : [0]]);
  } finally { server && server.kill(); await pool.end(); }
});







const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
const ids = { indents: [], materials: [] };
async function mkSup(prefix) { const r = await one("INSERT INTO suppliers (name, gst_number) VALUES ($1,$2) RETURNING id", [`${TAG} sup ${++seq}`, prefix + crypto.randomBytes(5).toString('hex').toUpperCase() + '1Z5']); made.suppliers.push(r.id); return r.id; }
const row = (id) => one('SELECT subtotal::float, cgst_amount::float AS cgst, sgst_amount::float AS sgst, igst_amount::float AS igst, total_amount::float AS total FROM purchase_orders WHERE id = $1', [id]);
const MIXED = [{ item_name: 'Oil', quantity: 10, unit: 'Kg', rate: 100, gst_rate: 5 }, { item_name: 'Acid', quantity: 10, unit: 'Kg', rate: 200, gst_rate: 18 }, { item_name: 'Cap', quantity: 10, unit: 'Nos', rate: 10 }];

test('an order with items at different GST rates: each item taxed at its own rate (blank = 18)', async () => {
  const s = await mkSup('32'), c = await api(tok.purchase, 'POST', '/api/po/create', { supplier_id: s, items: MIXED }); assert.equal(c.status, 201, JSON.stringify(c)); made.pos.push(c.po_id);
  // 1000 @5% = 50, 2000 @18% = 360, 100 @18% = 18  ->  tax 428, CGST 214 + SGST 214
  assert.deepEqual(await row(c.po_id), { subtotal: 3100, cgst: 214, sgst: 214, igst: 0, total: 3528 });
  const d = await api(tok.purchase, 'GET', '/api/po/' + c.po_id); assert.deepEqual(d.items.map(i => i.gst_rate === null ? null : Number(i.gst_rate)), [5, 18, null]);
  const o = await api(tok.purchase, 'POST', '/api/po/create', { supplier_id: await mkSup('29'), items: MIXED }); made.pos.push(o.po_id);
  assert.deepEqual(await row(o.po_id), { subtotal: 3100, cgst: 0, sgst: 0, igst: 428, total: 3528 }, 'another state: all as IGST');
});
test('a rate that is not a GST slab is refused; blank means the default', async () => {
  const s = await mkSup('32');
  for (const g of ['13', 'abc', -5]) assert.equal((await api(tok.purchase, 'POST', '/api/po/create', { supplier_id: s, items: [{ item_name: 'x', quantity: 1, unit: 'Kg', rate: 10, gst_rate: g }] })).status, 400, String(g));
  const ok = await api(tok.purchase, 'POST', '/api/po/create', { supplier_id: s, items: [{ item_name: 'x', quantity: 1, unit: 'Kg', rate: 100, gst_rate: '' }] }); made.pos.push(ok.po_id); assert.equal((await row(ok.po_id)).total, 118);
});
test('an item picked from the raw material list takes the material\'s own GST rate unless one is typed', async () => {
  const m = await one("INSERT INTO raw_materials (code, name, unit, gst_rate, active) VALUES ($1,$2,'Kg',12,true) RETURNING id, name", [`${TAG}M${++seq}`, `${TAG} Resin`]); ids.materials.push(m.id);
  const s = await mkSup('32');
  const a = await api(tok.purchase, 'POST', '/api/po/create', { supplier_id: s, items: [{ material_id: m.id, item_name: 'x', quantity: 1, unit: 'Kg', rate: 100 }] }); made.pos.push(a.po_id); assert.equal((await row(a.po_id)).total, 112);
  const b = await api(tok.purchase, 'POST', '/api/po/create', { supplier_id: s, items: [{ material_id: m.id, item_name: 'x', quantity: 1, unit: 'Kg', rate: 100, gst_rate: 5 }] }); made.pos.push(b.po_id); assert.equal((await row(b.po_id)).total, 105, 'typed rate wins');
});
test('editing keeps and recalculates the per-item rates, and the audit history has them', async () => {
  const s = await mkSup('32'), c = await api(tok.purchase, 'POST', '/api/po/create', { supplier_id: s, items: MIXED }); made.pos.push(c.po_id);
  const e = await api(tok.purchase, 'PUT', '/api/po/' + c.po_id, { supplier_id: s, items: [{ item_name: 'Oil', quantity: 20, unit: 'Kg', rate: 100, gst_rate: 5 }] }); assert.equal(e.status, 200, JSON.stringify(e));
  assert.deepEqual(await row(c.po_id), { subtotal: 2000, cgst: 50, sgst: 50, igst: 0, total: 2100 });
  const a = await one("SELECT before_data FROM audit_log WHERE action = 'po.edit' AND entity_id = $1", [c.po_id]); assert.equal(Number(a.before_data.items[0].gst_rate), 5);
});
test('orders from Purchase Requirements take per-item rates (and the material\'s rate by name)', async () => {
  const m = await one("INSERT INTO raw_materials (code, name, unit, gst_rate, active) VALUES ($1,$2,'Kg',5,true) RETURNING id", [`${TAG}M${++seq}`, `${TAG} Salt`]); ids.materials.push(m.id);
  const s = await mkSup('32'), ind = (await one("INSERT INTO production_indents (indent_number, production_head, status) VALUES ($1,'Head','approved') RETURNING id", [`${TAG}-IND${++seq}`])).id; ids.indents.push(ind);
  for (const n of ['Salt', 'Other']) await pool.query("INSERT INTO production_indent_items (indent_id, item_name, quantity, unit) VALUES ($1,$2,10,'Kg')", [ind, `${TAG} ${n}`]);
  const po = await api(tok.purchase, 'POST', '/api/consolidate/create-po', { supplier_id: s, production_indent_ids: [ind], items: [{ item_name: `${TAG} Salt`, quantity: 10, unit: 'Kg', rate: 100 }, { item_name: `${TAG} Other`, quantity: 10, unit: 'Kg', rate: 100, gst_rate: 28 }] });
  assert.equal(po.status, 201, JSON.stringify(po)); made.pos.push(po.po_id); assert.deepEqual(await row(po.po_id), { subtotal: 2000, cgst: 165, sgst: 165, igst: 0, total: 2330 });   // 1000@5 + 1000@28 = 50 + 280
  assert.equal((await api(tok.purchase, 'POST', '/api/consolidate/create-po', { supplier_id: s, production_indent_ids: [ind], items: [{ item_name: `${TAG} Salt`, quantity: 1, unit: 'Kg', rate: 1, gst_rate: 7 }] })).status, 400);
});
test('rate enquiry: the item\'s GST rate can be set on the enquiry', async () => {
  const s = await mkSup('32'), e = await api(tok.purchase, 'POST', '/api/rate-enquiry', { supplier_ids: [s], items: [{ item_name: 'Z', unit: 'Kg', quantity: 1, gst_rate: 12 }] }); assert.equal(e.status, 201, JSON.stringify(e)); ids.enq = [e.id];
  let d = await api(tok.purchase, 'GET', '/api/rate-enquiry/' + e.id); assert.equal(d.items[0].gst_rate, 12);
  assert.equal((await api(tok.purchase, 'PUT', `/api/rate-enquiry/${e.id}/item`, { item_id: d.items[0].id, gst_rate: '5' })).status, 200); d = await api(tok.purchase, 'GET', '/api/rate-enquiry/' + e.id); assert.equal(d.items[0].gst_rate, 5);
  assert.equal((await api(tok.purchase, 'PUT', `/api/rate-enquiry/${e.id}/item`, { item_id: d.items[0].id, gst_rate: '9' })).status, 400);
});
test('the pages carry the per-item GST column', () => {
  const root = path.join(__dirname, '..', '..', 'frontend'); for (const f of ['po-form.html', 'po-detail.html', 'consolidate.html']) assert.match(fs.readFileSync(path.join(root, f), 'utf8'), /GST %/, f);
  assert.match(fs.readFileSync(path.join(root, 'rate-enquiry.html'), 'utf8'), /gst_rate/);
});
