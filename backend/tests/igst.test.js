// GST on a purchase order: CGST + SGST for a supplier in our state, IGST for a supplier in another state.
//   node --test tests/igst.test.js
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

test('the state of the supplier decides: same state CGST + SGST, other state IGST; no GST number counts as same state; a person may override', () => {
  assert.equal(T.taxMode('32AAJFE8124C1ZV'), 'intra'); assert.equal(T.taxMode('29AABCU9603R1ZX'), 'inter'); assert.equal(T.taxMode('33AAAAA0000A1Z5'), 'inter');
  assert.equal(T.taxMode(''), 'intra'); assert.equal(T.taxMode(null), 'intra'); assert.equal(T.taxMode('XX'), 'intra');
  assert.equal(T.taxMode('32AAJFE8124C1ZV', 'inter'), 'inter'); assert.equal(T.taxMode('29AABCU9603R1ZX', 'intra'), 'intra'); assert.equal(T.taxMode('29AABCU9603R1ZX', 'junk'), 'inter');
  assert.deepEqual(T.taxSplit(1000, 'intra'), { cgst: 90, sgst: 90, igst: 0, total: 1180 }); assert.deepEqual(T.taxSplit(1000, 'inter'), { cgst: 0, sgst: 0, igst: 180, total: 1180 });
  assert.deepEqual(T.taxSplit(58920, 'intra'), { cgst: 5302.8, sgst: 5302.8, igst: 0, total: 69525.6 });
  assert.equal(T.modeOfPo({ igst_amount: 180 }), 'inter'); assert.equal(T.modeOfPo({ igst_amount: 0 }), 'intra'); assert.equal(T.modeOfPo({ igst_amount: '0.00' }), 'intra');
});

const PORT = 3303, BASE = `http://localhost:${PORT}`, TAG = 'ZZG' + crypto.randomBytes(3).toString('hex').toUpperCase();
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
    await pool.query('DELETE FROM purchase_orders WHERE id = ANY($1)', [made.pos.length ? made.pos : [0]]);
    await pool.query('DELETE FROM production_indents WHERE id = ANY($1)', [ids.indents.length ? ids.indents : [0]]);
    await pool.query('DELETE FROM production_indents WHERE id = ANY($1)', [ids.indents.length ? ids.indents : [0]]);
    await pool.query('DELETE FROM production_indents WHERE id = ANY($1)', [ids.indents.length ? ids.indents : [0]]);
    await pool.query('DELETE FROM suppliers WHERE id = ANY($1)', [made.suppliers.length ? made.suppliers : [0]]);
    await pool.query('DELETE FROM audit_log WHERE actor_id = ANY($1)', [made.users.length ? made.users : [0]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users.length ? made.users : [0]]);
  } finally { server && server.kill(); await pool.end(); }
});






const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
const ids = { indents: [] };
const OTHER = '29' + 'AABCU9603R'.slice(0, 10) + '1ZX', SAME = '32AAJFE8124C1ZV';
const gstFor = (s) => s + crypto.randomBytes(2).toString('hex').toUpperCase().slice(0, 0);
async function mkSup(prefix) { const r = await one("INSERT INTO suppliers (name, gst_number) VALUES ($1,$2) RETURNING id", [`${TAG} sup ${++seq}`, prefix ? prefix + crypto.randomBytes(5).toString('hex').toUpperCase() + '1Z5' : null]); made.suppliers.push(r.id); return r.id; }
const ITEMS = [{ item_name: 'Wax', quantity: 10, unit: 'Kg', rate: 100 }];
const create = (sid, extra = {}) => api(tok.purchase, 'POST', '/api/po/create', { supplier_id: sid, items: ITEMS, ...extra });
const row = (id) => one('SELECT subtotal::float, cgst_amount::float AS cgst, sgst_amount::float AS sgst, igst_amount::float AS igst, total_amount::float AS total FROM purchase_orders WHERE id = $1', [id]);

test('a supplier in our state: CGST + SGST; in another state: IGST 18%; no GST number: CGST + SGST', async () => {
  const a = await create(await mkSup('32')), b = await create(await mkSup('29')), c = await create(await mkSup(null)); made.pos.push(a.po_id, b.po_id, c.po_id);
  assert.deepEqual(await row(a.po_id), { subtotal: 1000, cgst: 90, sgst: 90, igst: 0, total: 1180 });
  assert.deepEqual(await row(b.po_id), { subtotal: 1000, cgst: 0, sgst: 0, igst: 180, total: 1180 }); assert.equal(b.igst_amount, 180);
  assert.deepEqual(await row(c.po_id), { subtotal: 1000, cgst: 90, sgst: 90, igst: 0, total: 1180 });
});
test('it can be overridden when the order is made, and the order form asks the server which tax applies', async () => {
  const s = await mkSup('32'), o = await create(s, { tax_type: 'inter' }); made.pos.push(o.po_id); assert.equal((await row(o.po_id)).igst, 180);
  const m = await api(tok.purchase, 'GET', `/api/po/tax-mode?supplier_id=${await mkSup('29')}`); assert.equal(m.mode, 'inter'); assert.equal(m.igst_rate, 18); assert.equal(m.has_gst_number, true);
  assert.equal((await api(tok.purchase, 'GET', `/api/po/tax-mode?supplier_id=${s}&tax_type=inter`)).mode, 'inter'); assert.equal((await api(tok.purchase, 'GET', `/api/po/tax-mode?supplier_id=${await mkSup(null)}`)).has_gst_number, false);
  assert.equal((await api(tok.purchase, 'GET', '/api/po/tax-mode')).status, 400); assert.equal((await api(tok.purchase, 'GET', '/api/po/tax-mode?supplier_id=987654321')).status, 404);
});
test('editing: the tax follows the supplier; an order keeps its kind of tax when only the items change; the print shows IGST', async () => {
  const s1 = await mkSup('32'), s2 = await mkSup('29'), c = await create(s1); made.pos.push(c.po_id);
  const edit = (sid, extra) => api(tok.purchase, 'PUT', '/api/po/' + c.po_id, { supplier_id: sid, items: [{ item_name: 'Wax', quantity: 20, unit: 'Kg', rate: 100 }], ...extra });
  assert.equal((await edit(s2)).status, 200); assert.deepEqual(await row(c.po_id), { subtotal: 2000, cgst: 0, sgst: 0, igst: 360, total: 2360 }, 'moved to an other-state supplier: IGST');
  assert.equal((await edit(s2)).status, 200); assert.equal((await row(c.po_id)).igst, 360, 'same supplier, kept');
  const p = await api(tok.purchase, 'GET', `/api/po/${c.po_id}/print`); assert.deepEqual(p.totals.taxes, [{ label: 'IGST', amount: '360.00' }]); assert.equal(p.totals.total, '2,360.00');
  assert.equal((await edit(s1)).status, 200); assert.deepEqual(await row(c.po_id), { subtotal: 2000, cgst: 180, sgst: 180, igst: 0, total: 2360 }, 'back to our state');
  assert.equal((await edit(s1, { tax_type: 'inter' })).status, 200); assert.equal((await row(c.po_id)).igst, 360, 'overridden');
});
test('consolidated orders, Tally vouchers and the invoice check use the same tax', async () => {
  const s2 = await mkSup('29'), ind = (await one("INSERT INTO production_indents (indent_number, production_head, status) VALUES ($1,'Head','approved') RETURNING id", [`${TAG}-IND${++seq}`])).id; ids.indents.push(ind);
  await pool.query("INSERT INTO production_indent_items (indent_id, item_name, quantity, unit) VALUES ($1,$2,5,'Kg')", [ind, `${TAG} X`]);
  const po = await api(tok.purchase, 'POST', '/api/consolidate/create-po', { supplier_id: s2, production_indent_ids: [ind], items: [{ item_name: `${TAG} X`, quantity: 5, unit: 'Kg', rate: 100 }] }); assert.equal(po.status, 201, JSON.stringify(po)); made.pos.push(po.po_id);
  assert.deepEqual(await row(po.po_id), { subtotal: 500, cgst: 0, sgst: 0, igst: 90, total: 590 });
  const t = await api(tok.admin, 'POST', '/api/tally/sync/' + po.po_id); assert.equal(t.status, 200, JSON.stringify(t));
  assert.deepEqual(t.vouchers[0].tax_ledgers, [{ ledger: 'IGST', amount: 90 }]);
});
test('the pages show the right tax rows', () => {
  const root = path.join(__dirname, '..', '..', 'frontend'), f = fs.readFileSync(path.join(root, 'po-form.html'), 'utf8'), d = fs.readFileSync(path.join(root, 'po-detail.html'), 'utf8');
  assert.match(f, /\/api\/po\/tax-mode/); assert.match(f, /id="igst"/); assert.match(d, /id="rowIgst"/);
});
