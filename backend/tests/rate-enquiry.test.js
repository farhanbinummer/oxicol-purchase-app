// Rate enquiries: ask suppliers for rates before a PO, compare quotes, choose, and raise the order from the choice.
//   node --test tests/rate-enquiry.test.js
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

const PORT = 3302, BASE = `http://localhost:${PORT}`, TAG = 'ZZR' + crypto.randomBytes(3).toString('hex').toUpperCase();
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
    await pool.query('DELETE FROM purchase_orders WHERE id = ANY($1)', [made.pos.length ? made.pos : [0]]);
    await pool.query('DELETE FROM production_indents WHERE id = ANY($1)', [ids.indents.length ? ids.indents : [0]]);
    await pool.query('DELETE FROM rate_enquiries WHERE id = ANY($1)', [ids.enq.length ? ids.enq : [0]]);
    await pool.query('DELETE FROM production_indents WHERE id = ANY($1)', [ids.indents.length ? ids.indents : [0]]);
    await pool.query('DELETE FROM suppliers WHERE id = ANY($1)', [made.suppliers.length ? made.suppliers : [0]]);
    await pool.query('DELETE FROM audit_log WHERE actor_id = ANY($1)', [made.users.length ? made.users : [0]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users.length ? made.users : [0]]);
  } finally { server && server.kill(); await pool.end(); }
});





const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
const ids = { indents: [], enq: [] };
async function mkIndent(names) {
  const r = await one("INSERT INTO production_indents (indent_number, production_head, status) VALUES ($1,'Head','approved') RETURNING id", [`${TAG}-IND${++seq}`]); ids.indents.push(r.id);
  for (const n of names) await pool.query("INSERT INTO production_indent_items (indent_id, item_name, quantity, unit) VALUES ($1,$2,5,'Kg')", [r.id, `${TAG} ${n}`]); return r.id;
}
async function mkEnquiry(ind, names, suppliers) {
  const r = await api(tok.purchase, 'POST', '/api/rate-enquiry', { title: 'Test', supplier_ids: suppliers, items: names.map(n => ({ item_name: `${TAG} ${n}`, unit: 'Kg', quantity: 5, sources: [{ type: 'production', id: ind }] })) });
  assert.equal(r.status, 201, JSON.stringify(r)); ids.enq.push(r.id); return r.id;
}
const get = (id) => api(tok.purchase, 'GET', '/api/rate-enquiry/' + id);

test('the whole flow: start, quote, compare, choose, raise the orders (one per supplier), and the enquiry closes', async () => {
  const s1 = await mkSupplier(), s2 = await mkSupplier(), ind = await mkIndent(['A', 'B']), id = await mkEnquiry(ind, ['A', 'B'], [s1, s2]);
  let d = await get(id); assert.match(d.enquiry.enquiry_number, /^RE-\d{8}-\d{3}$/); assert.equal(d.items.length, 2); assert.equal(d.suppliers.length, 2);
  const [iA, iB] = d.items;
  for (const [it, s, r] of [[iA, s1, 100], [iA, s2, 90], [iB, s1, 50], [iB, s2, 60]]) assert.equal((await api(tok.purchase, 'PUT', `/api/rate-enquiry/${id}/quote`, { item_id: it.id, supplier_id: s, rate: r, note: 'n' })).status, 200);
  assert.equal((await api(tok.purchase, 'PUT', `/api/rate-enquiry/${id}/quote`, { item_id: iA.id, supplier_id: s2, rate: 95 })).status, 200, 'a quote can be corrected');
  assert.equal((await get(id)).quotes.length, 4, 'one quote per item and supplier');
  assert.equal((await api(tok.purchase, 'PUT', `/api/rate-enquiry/${id}/award`, { item_id: iA.id, supplier_id: s2 })).status, 200);
  assert.equal((await api(tok.purchase, 'PUT', `/api/rate-enquiry/${id}/award`, { item_id: iB.id, supplier_id: s1 })).status, 200);
  d = await get(id); assert.equal(d.items[0].awarded_rate, 95); assert.equal(d.items[1].awarded_rate, 50);
  // raise the order for supplier 2 (item A) the way the page does
  const po = await api(tok.purchase, 'POST', '/api/consolidate/create-po', { supplier_id: s2, production_indent_ids: [ind], items: [{ item_name: iA.item_name, quantity: 5, unit: 'Kg', rate: 95 }] });
  assert.equal(po.status, 201, JSON.stringify(po)); made.pos.push(po.po_id);
  assert.equal((await api(tok.purchase, 'POST', `/api/rate-enquiry/${id}/ordered`, { item_ids: [iB.id], po_id: po.po_id })).status, 400, 'item B is chosen for another supplier');
  assert.equal((await api(tok.purchase, 'POST', `/api/rate-enquiry/${id}/ordered`, { item_ids: [iA.id], po_id: po.po_id })).status, 200);
  assert.equal((await get(id)).enquiry.status, 'open', 'B is still to order');
  const po2 = await api(tok.purchase, 'POST', '/api/consolidate/create-po', { supplier_id: s1, production_indent_ids: [ind], items: [{ item_name: iB.item_name, quantity: 5, unit: 'Kg', rate: 50 }] }); made.pos.push(po2.po_id);
  assert.equal((await api(tok.purchase, 'POST', `/api/rate-enquiry/${id}/ordered`, { item_ids: [iB.id], po_id: po2.po_id })).status, 200);
  assert.equal((await get(id)).enquiry.status, 'closed', 'all ordered: closed');
  assert.equal((await one('SELECT status FROM production_indents WHERE id = $1', [ind])).status, 'po_raised');
  // the order is deleted: the line is chosen but not ordered again
  assert.equal((await api(tok.admin, 'DELETE', '/api/po/' + po.po_id)).status, 200); d = await get(id); assert.equal(d.items[0].po_id, null); assert.equal(d.items[0].awarded_supplier_id, s2);
});
test('rules: a supplier must have quoted before being chosen; quotes need a positive rate; removing a supplier removes their quotes; only the asked suppliers can quote', async () => {
  const s1 = await mkSupplier(), s2 = await mkSupplier(), s3 = await mkSupplier(), ind = await mkIndent(['A']), id = await mkEnquiry(ind, ['A'], [s1, s2]), it = (await get(id)).items[0];
  const put = (p, b) => api(tok.purchase, 'PUT', `/api/rate-enquiry/${id}${p}`, b);
  assert.equal((await put('/award', { item_id: it.id, supplier_id: s1 })).status, 400, 'no quote yet');
  for (const rate of [0, -5, 'abc']) assert.equal((await put('/quote', { item_id: it.id, supplier_id: s1, rate })).status, 400, String(rate));
  assert.equal((await put('/quote', { item_id: it.id, supplier_id: s3, rate: 10 })).status, 400, 'not asked');
  await put('/quote', { item_id: it.id, supplier_id: s1, rate: 10 }); await put('/quote', { item_id: it.id, supplier_id: s2, rate: 12 });
  await put('/award', { item_id: it.id, supplier_id: s1 });
  assert.equal((await put('/suppliers', { supplier_ids: [s2] })).status, 400, 'the chosen supplier cannot be removed');
  assert.equal((await put('/quote', { item_id: it.id, supplier_id: s1, rate: '' })).status, 400, 'nor the chosen quote');
  await put('/award', { item_id: it.id, supplier_id: null });
  assert.equal((await put('/suppliers', { supplier_ids: [s2, s3] })).status, 200);
  const d = await get(id); assert.deepEqual(d.suppliers.map(s => s.id).sort(), [s2, s3].sort()); assert.deepEqual(d.quotes.map(x => x.supplier_id), [s2]);
  assert.equal((await put('/status', { status: 'cancelled' })).status, 200); assert.equal((await put('/quote', { item_id: it.id, supplier_id: s2, rate: 9 })).status, 400, 'a cancelled enquiry takes no changes');
  assert.equal((await put('/status', { status: 'nonsense' })).status, 400);
});
test('creating needs items, valid quantities and real suppliers; everything is recorded in the audit history', async () => {
  const s1 = await mkSupplier();
  assert.equal((await api(tok.purchase, 'POST', '/api/rate-enquiry', { items: [] })).status, 400);
  assert.equal((await api(tok.purchase, 'POST', '/api/rate-enquiry', { items: [{ item_name: 'x', unit: 'Kg', quantity: 0 }] })).status, 400);
  assert.equal((await api(tok.purchase, 'POST', '/api/rate-enquiry', { supplier_ids: [987654321], items: [{ item_name: 'x', unit: 'Kg', quantity: 1 }] })).status, 400);
  const r = await api(tok.purchase, 'POST', '/api/rate-enquiry', { supplier_ids: [s1], items: [{ item_name: 'x', unit: 'Kg', quantity: 1 }] }); ids.enq.push(r.id);
  assert.equal((await one("SELECT COUNT(*)::int n FROM audit_log WHERE action = 'rate_enquiry.create' AND entity_id = $1", [r.id])).n, 1);
});
test('who may use it: Purchase and administrators; Stores, Accounts and anonymous visitors may not', async () => {
  const s1 = await mkSupplier(), ind = await mkIndent(['A']), id = await mkEnquiry(ind, ['A'], [s1]);
  assert.equal((await api(tok.admin, 'GET', '/api/rate-enquiry/' + id)).status, 200);
  for (const t of [tok.store, tok.accounts]) { assert.equal((await api(t, 'GET', '/api/rate-enquiry')).status, 403); assert.equal((await api(t, 'GET', '/api/rate-enquiry/' + id)).status, 403); assert.equal((await api(t, 'POST', '/api/rate-enquiry', { items: [{ item_name: 'x', unit: 'Kg', quantity: 1 }] })).status, 403); }
  assert.equal((await api(null, 'GET', '/api/rate-enquiry')).status, 401); assert.equal((await api(tok.purchase, 'GET', '/api/rate-enquiry/987654321')).status, 404);
  assert.ok((await api(tok.purchase, 'GET', '/api/rate-enquiry')).enquiries.some(e => e.id === id));
});
test('a supplier removed by the administrator takes its quotes and choices with it', async () => {
  const s1 = await mkSupplier(), s2 = await mkSupplier(), ind = await mkIndent(['A']), id = await mkEnquiry(ind, ['A'], [s1, s2]), it = (await get(id)).items[0];
  for (const s of [s1, s2]) await api(tok.purchase, 'PUT', `/api/rate-enquiry/${id}/quote`, { item_id: it.id, supplier_id: s, rate: 10 });
  await api(tok.purchase, 'PUT', `/api/rate-enquiry/${id}/award`, { item_id: it.id, supplier_id: s1 });
  const rm = await api(tok.admin, 'POST', '/api/admin/data/records/supplier/delete', { ids: [s1], confirm: 'DELETE', reason: 'cleaning up test data' }); assert.equal(rm.status, 200, JSON.stringify(rm));
  const d = await get(id); assert.deepEqual(d.suppliers.map(s => s.id), [s2]); assert.equal(d.quotes.length, 1); assert.equal(d.items[0].awarded_supplier_id, null);
});
test('the pages exist and are reachable: menu entry, list, detail, and the button on Purchase Requirements', () => {
  const root = path.join(__dirname, '..', '..', 'frontend'), c = fs.readFileSync(path.join(root, 'consolidate.html'), 'utf8');
  assert.ok(fs.existsSync(path.join(root, 'rate-enquiries.html')) && fs.existsSync(path.join(root, 'rate-enquiry.html'))); assert.match(c, /Ask suppliers for rates first/); assert.match(c, /rate-enquiry\.html\?id=/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'workspaces.js'), 'utf8'), /rate-enquiries\.html/);
});
