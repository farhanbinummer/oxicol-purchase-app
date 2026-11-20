// The printed purchase order (copy of the company's own template): the numbers and words it shows, the PO reference numbering, the supplier
// address, and who may print. Pure rules run without a database; the rest uses a real server on its own port.
//   node --test tests/po-print.test.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const bcrypt = require('bcryptjs');
const P = require('../po-print');
const { pool } = require('../database');
const { createSession } = require('../auth');
const { runMigrations, STEPS } = require('../migrate');
const { primaryRole } = require('../access');

// ------------------------------------------------------------------ the rules (no database)
test('money is written the Indian way, always with two decimals', () => {
  const c = [[69526, '69,526.00'], [58920, '58,920.00'], [0.4, '0.40'], [1000, '1,000.00'], [100000, '1,00,000.00'], [1234567.8, '12,34,567.80'], [999.995, '1,000.00'], [0, '0.00'], [12345678.9, '1,23,45,678.90']];
  c.forEach(([n, s]) => assert.equal(P.inr(n), s, String(n)));
});
test('quantities have four decimals and units are written like the template (KG, LTR, NOS)', () => {
  assert.equal(P.qty4(240), '240.0000'); assert.equal(P.qty4(0.5), '0.5000'); assert.equal(P.qty4('12.34567'), '12.3457');
  assert.deepEqual(['Kg', 'Litre', 'Nos', 'Box', 'Drum', 'kg', 'LTR', 'Carboy'].map(P.unitCode), ['KG', 'LTR', 'NOS', 'BOX', 'DRUM', 'KG', 'LTR', 'CARBOY']);
});
test('dates are written 3-Nov-26', () => {
  assert.equal(P.dmy('2026-11-03'), '3-Nov-26'); assert.equal(P.dmy('2027-02-10T00:00:00.000Z'), '10-Feb-27'); assert.equal(P.dmy(new Date('2026-12-25T00:00:00Z')), '25-Dec-26'); assert.equal(P.dmy(null), ''); assert.equal(P.dmy('nonsense'), '');
});
test('the amount in words follows the template ("INR ... Only") and the Indian system (thousand, lakh, crore)', () => {
  const c = [[69526, 'INR Sixty Nine Thousand Five Hundred Twenty Six Only'], [0, 'INR Zero Only'], [1, 'INR One Only'], [19, 'INR Nineteen Only'], [20, 'INR Twenty Only'], [21, 'INR Twenty One Only'], [100, 'INR One Hundred Only'],
    [101, 'INR One Hundred One Only'], [1000, 'INR One Thousand Only'], [100000, 'INR One Lakh Only'], [123456, 'INR One Lakh Twenty Three Thousand Four Hundred Fifty Six Only'], [10000000, 'INR One Crore Only'],
    [123456789, 'INR Twelve Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred Eighty Nine Only'], [150.5, 'INR One Hundred Fifty and Fifty Paise Only']];
  c.forEach(([n, s]) => assert.equal(P.amountInWords(n), s, String(n)));
});
test('the state comes from the first two characters of a GST number', () => {
  assert.deepEqual(P.stateOf('32AAJFE8124C1ZV'), { code: '32', name: 'Kerala' }); assert.equal(P.stateOf('29AABCU9603R1ZX').name, 'Karnataka'); assert.equal(P.stateOf('33AAAAA0000A1Z5').name, 'Tamil Nadu');
  assert.equal(P.stateOf('99XXXX').name, 'Centre Jurisdiction'); assert.equal(P.stateOf('00AAAA'), null); assert.equal(P.stateOf(''), null); assert.equal(P.stateOf(null), null);
});
test('the voucher number is the running number of the reference', () => { assert.equal(P.voucherNo('PO/26-27/028'), '28'); assert.equal(P.voucherNo('PO/26-27/100'), '100'); assert.equal(P.voucherNo(''), ''); assert.equal(P.voucherNo(null), ''); });
test('the company details are the template\'s, and can be changed with settings', () => {
  const c = P.company({}); assert.equal(c.name, 'OXICOL CAR CARE PRODUCTS'); assert.equal(c.gstin, '32FGVPS9596F1ZB'); assert.equal(c.state, 'Kerala'); assert.equal(c.state_code, '32'); assert.equal(c.address.length, 3);
  const d = P.company({ COMPANY_NAME: 'Other Co', COMPANY_ADDRESS: 'Line A | Line B', COMPANY_GSTIN: '29aabcu9603r1zx', COMPANY_EMAIL: 'x@y.test' });
  assert.deepEqual([d.name, d.address, d.gstin, d.state, d.email], ['Other Co', ['Line A', 'Line B'], '29AABCU9603R1ZX', 'Karnataka', 'x@y.test']);
});

const SAMPLE_ITEMS = [{ item_name: 'HYDROFLURIC ACIF (HF)60%', quantity: 240, unit: 'Kg', rate: 188, line_amount: 45120 }, { item_name: 'OXALIC ACID', quantity: 100, unit: 'Kg', rate: 92, line_amount: 9200 }, { item_name: 'SLES LIQUID', quantity: 50, unit: 'Kg', rate: 92, line_amount: 4600 }];
const SAMPLE_PO = { po_ref: 'PO/26-27/028', po_date: '2026-11-03', delivery_date: '2026-11-03', notes: '', transporter: null, subtotal: 58920, cgst_amount: 5302.8, sgst_amount: 5302.8, igst_amount: 0, total_amount: 69525.6 };
const SAMPLE_SUP = { name: 'ELEMENT CHEMICLALS', address: '1047/A,EDAYAR UNDUSTRILA DEVOLOPMENT AREA\nBINANIPURAM POST,COCHIN-683501', gst_number: '32AAJFE8124C1ZV' };
test('an order like the template\'s own example prints exactly the template\'s figures', () => {
  const b = P.buildPrint(SAMPLE_PO, SAMPLE_ITEMS, SAMPLE_SUP);
  assert.deepEqual(b.totals, { subtotal: '58,920.00', taxes: [{ label: 'CGST', amount: '5,302.80' }, { label: 'SGST', amount: '5,302.80' }], round_off: '0.40', total: '69,526.00', total_quantity: '390.0000 KG', words: 'INR Sixty Nine Thousand Five Hundred Twenty Six Only' });
  assert.deepEqual(b.items[0], { n: 1, name: 'HYDROFLURIC ACIF (HF)60%', due: '3-Nov-26', qty: '240.0000', unit: 'KG', rate: '188.00', amount: '45,120.00' });
  assert.deepEqual([b.po.voucher_no, b.po.reference, b.po.date], ['28', 'PO/26-27/028', '3-Nov-26']);
  assert.deepEqual(b.supplier, { name: 'ELEMENT CHEMICLALS', address: ['1047/A,EDAYAR UNDUSTRILA DEVOLOPMENT AREA', 'BINANIPURAM POST,COCHIN-683501'], gstin: '32AAJFE8124C1ZV', state: 'Kerala', state_code: '32' });
});
test('round off, taxes, units and missing details are handled', () => {
  assert.equal(P.buildPrint({ ...SAMPLE_PO, total_amount: 69526 }, SAMPLE_ITEMS, SAMPLE_SUP).totals.round_off, '', 'no round off line when the total is already whole');
  assert.equal(P.buildPrint({ ...SAMPLE_PO, total_amount: 69525.4 }, SAMPLE_ITEMS, SAMPLE_SUP).totals.total, '69,525.00'); assert.equal(P.buildPrint({ ...SAMPLE_PO, total_amount: 69525.4 }, SAMPLE_ITEMS, SAMPLE_SUP).totals.round_off, '-0.40', 'rounded down: the difference is shown with a minus sign');
  const igst = P.buildPrint({ ...SAMPLE_PO, cgst_amount: 0, sgst_amount: 0, igst_amount: 10605.6, total_amount: 69525.6 }, SAMPLE_ITEMS, SAMPLE_SUP).totals.taxes; assert.deepEqual(igst, [{ label: 'IGST', amount: '10,605.60' }]);
  const mixed = P.buildPrint(SAMPLE_PO, [...SAMPLE_ITEMS, { item_name: 'Cans', quantity: 10, unit: 'Nos', rate: 5, line_amount: 50 }], SAMPLE_SUP); assert.equal(mixed.totals.total_quantity, '', 'no single total when units differ');
  const none = P.buildPrint({ ...SAMPLE_PO, delivery_date: null, notes: 'Call first\n\n  Deliver by lorry ', transporter: 'VRL' }, SAMPLE_ITEMS, { name: 'No Details Ltd', address: null, gst_number: null });
  assert.equal(none.items[0].due, ''); assert.deepEqual(none.po.terms_of_delivery, ['Call first', 'Deliver by lorry']); assert.equal(none.po.dispatched_through, 'VRL'); assert.deepEqual(none.supplier, { name: 'No Details Ltd', address: [], gstin: '', state: '', state_code: '' });
});

// ------------------------------------------------------------------ the real server and database
const PORT = 3284, BASE = `http://localhost:${PORT}`, TAG = 'ZZP' + crypto.randomBytes(3).toString('hex').toUpperCase();
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
  tok.admin = await mkUser('admin'); tok.purchase = await mkUser('purchase'); tok.store = await mkUser('store');
});
test.after(async () => {
  try {
    await pool.query('DELETE FROM purchase_orders WHERE id = ANY($1)', [made.pos.length ? made.pos : [0]]);
    await pool.query('DELETE FROM suppliers WHERE id = ANY($1)', [made.suppliers.length ? made.suppliers : [0]]);
    await pool.query('DELETE FROM audit_log WHERE actor_id = ANY($1)', [made.users.length ? made.users : [0]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users.length ? made.users : [0]]);
  } finally { server && server.kill(); await pool.end(); }
});

test('every order gets a reference like PO/26-27/028: the financial year (April to March) and a running number inside it', async () => {
  const s = await mkSupplier();
  const a = await mkPo(s, '2026-11-03'), b = await mkPo(s, '2026-11-04'), c = await mkPo(s, '2027-02-10'), d = await mkPo(s, '2026-03-31'), e = await mkPo(s, '2026-04-01'), f = await mkPo(s, '2025-04-01');
  const num = (r) => Number(/(\d+)$/.exec(r)[1]);
  assert.match(a.po_ref, /^PO\/26-27\/\d{3}$/); assert.equal(num(b.po_ref), num(a.po_ref) + 1, 'running number'); assert.match(c.po_ref, /^PO\/26-27\//, 'February still belongs to the same financial year');
  assert.equal(num(c.po_ref), num(b.po_ref) + 1); assert.match(d.po_ref, /^PO\/25-26\//, '31 March is the last day of the old year'); assert.match(e.po_ref, /^PO\/26-27\//, '1 April starts the new year'); assert.match(f.po_ref, /^PO\/25-26\//);
  assert.equal(num(f.po_ref), num(d.po_ref) + 1, 'another year has its own running number');
  assert.equal(new Set([a, b, c, d, e, f].map(x => x.po_ref)).size, 6);
});
test('two orders created at the same moment never share a reference', async () => {
  const s = await mkSupplier();
  const rs = await Promise.all(Array.from({ length: 8 }, () => mkPo(s, '2026-12-01')));
  const nums = rs.map(r => Number(/(\d+)$/.exec(r.po_ref)[1])).sort((x, y) => x - y);
  assert.equal(new Set(nums).size, 8, nums.join(',')); assert.equal(nums[7] - nums[0], 7, 'consecutive');
});
test('an order made through the app gets a reference too, and running the migration again changes nothing', async () => {
  const s = await mkSupplier();
  const c = await api(tok.purchase, 'POST', '/api/po/create', { supplier_id: s, items: [{ item_name: 'Wax', quantity: 1, unit: 'Kg', rate: 10 }] }); assert.equal(c.status, 201, JSON.stringify(c)); made.pos.push(c.po_id);
  const r = (await pool.query('SELECT po_ref FROM purchase_orders WHERE id = $1', [c.po_id])).rows[0].po_ref; assert.match(r, /^PO\/\d{2}-\d{2}\/\d{3}$/);
  const before = (await pool.query('SELECT id, po_ref FROM purchase_orders ORDER BY id')).rows;
  const step = STEPS.find(x => x.name === '035_po_print_template'); assert.ok(step); const cl = await pool.connect(); try { await step.run(cl); await step.run(cl); } finally { cl.release(); }
  assert.deepEqual((await pool.query('SELECT id, po_ref FROM purchase_orders ORDER BY id')).rows, before);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM purchase_orders WHERE po_ref IS NULL')).rows[0].n, 0, 'no order is left without a reference');
  const dup = await pool.query('SELECT po_ref FROM purchase_orders GROUP BY po_ref HAVING COUNT(*) > 1'); assert.equal(dup.rowCount, 0);
});

test('the print data: the whole template filled from the order, with the supplier\'s address and state', async () => {
  const s = await mkSupplier({ address: '1047/A, Edayar Industrial Area\nBinanipuram Post, Cochin-683501' }); const po = await mkPo(s, '2026-11-03', { delivery: '2026-11-10', notes: 'Deliver before noon' });
  await pool.query("UPDATE purchase_orders SET transporter = 'VRL Logistics' WHERE id = $1", [po.id]);
  const r = await api(tok.purchase, 'GET', `/api/po/${po.id}/print`); assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.company.name, 'OXICOL CAR CARE PRODUCTS'); assert.equal(r.po.reference, po.po_ref); assert.equal(r.po.date, '3-Nov-26'); assert.equal(r.po.dispatched_through, 'VRL Logistics'); assert.deepEqual(r.po.terms_of_delivery, ['Deliver before noon']);
  assert.deepEqual(r.supplier.address, ['1047/A, Edayar Industrial Area', 'Binanipuram Post, Cochin-683501']); assert.equal(r.supplier.state, 'Kerala'); assert.equal(r.items.length, 3); assert.equal(r.items[0].due, '10-Nov-26'); assert.equal(r.totals.total, '69,526.00'); assert.equal(r.totals.total_quantity, '390.0000 KG');
  assert.ok(!JSON.stringify(r).includes('9988776655443322') && !JSON.stringify(r).includes('SBI'), 'the supplier\'s bank details are never on the printout');
});
test('who may print: people who may see orders AND prices (administrators, Purchase), not Stores; nothing is printed for an unknown order', async () => {
  const s = await mkSupplier(); const po = await mkPo(s, '2026-11-03');
  assert.equal((await api(tok.admin, 'GET', `/api/po/${po.id}/print`)).status, 200); assert.equal((await api(tok.purchase, 'GET', `/api/po/${po.id}/print`)).status, 200);
  const st = await api(tok.store, 'GET', `/api/po/${po.id}/print`); assert.ok([403].includes(st.status), 'Stores never see prices: ' + st.status); assert.equal(st.items, undefined);
  assert.equal((await api(null, 'GET', `/api/po/${po.id}/print`)).status, 401); assert.equal((await api(tok.purchase, 'GET', '/api/po/987654321/print')).status, 404); assert.equal((await api(tok.purchase, 'GET', '/api/po/abc/print')).status, 400);
});

test('a supplier\'s address is saved line by line (at most 6 lines of 80 characters) and shown on the list', async () => {
  const s = await mkSupplier({ address: null });
  assert.equal((await api(tok.purchase, 'PUT', '/api/suppliers/' + s, { address: '  Plot 4,   Industrial Area \n\n Kochi \r\n Kerala' })).status, 200);
  assert.equal((await pool.query('SELECT address FROM suppliers WHERE id = $1', [s])).rows[0].address, 'Plot 4, Industrial Area\nKochi\nKerala');
  const l = (await api(tok.purchase, 'GET', '/api/suppliers/list?q=' + TAG)).suppliers.find(x => x.id === s); assert.equal(l.address, 'Plot 4, Industrial Area\nKochi\nKerala');
  assert.equal((await api(tok.purchase, 'PUT', '/api/suppliers/' + s, { address: Array.from({ length: 7 }, (_, i) => 'line ' + i).join('\n') })).status, 400);
  assert.equal((await api(tok.purchase, 'PUT', '/api/suppliers/' + s, { address: 'x'.repeat(81) })).status, 400);
  assert.equal((await api(tok.purchase, 'PUT', '/api/suppliers/' + s, { address: '' })).status, 200); assert.equal((await pool.query('SELECT address FROM suppliers WHERE id = $1', [s])).rows[0].address, null, 'it can be cleared');
});

test('the print page is a bare sheet (no menu), uses the template\'s own logo and is reachable from the order page', () => {
  const root = path.join(__dirname, '..', '..', 'frontend'), page = fs.readFileSync(path.join(root, 'po-print.html'), 'utf8');
  assert.match(page, /<html lang="en" data-bare>/); assert.ok(fs.existsSync(path.join(root, 'icons', 'po-logo.png'))); assert.match(page, /icons\/po-logo\.png/);
  assert.match(fs.readFileSync(path.join(root, 'common.js'), 'utf8'), /hasAttribute\('data-bare'\)/);
  assert.match(fs.readFileSync(path.join(root, 'po-detail.html'), 'utf8'), /po-print\.html\?id=/);
  assert.match(page, /@page \{ size: A4; margin: 0; \}/); assert.match(page, /Print \/ Save as PDF/);
});
