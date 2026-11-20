// Purchase order: expected delivery date updates and dispatch (tracking) details. A real server on its own port; everything created is removed afterwards.
//   node --test tests/po-delivery.test.js
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
const { DEFAULTS, CATALOG } = require('../permissions');
const R = require('../rd-logic');

const PORT = 3287, BASE = `http://localhost:${PORT}`, TAG = 'ZZV' + crypto.randomBytes(3).toString('hex').toUpperCase();
const made = { users: [], pos: [], suppliers: [] }; const tok = {}; let server, seq = 0, supplier;
const today = R.todayIST(), d = (n) => R.addDays(today, n);
async function api(token, method, url, body) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await res.json(); } catch (e) {} return { ...j, status: res.status };
}
async function mkUser(role) {
  const hash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 4);
  const r = await pool.query('INSERT INTO users (username, password_hash, name, role) VALUES ($1,$2,$3,$4) RETURNING id', [`${TAG}_${role}`.toLowerCase(), hash, `Test ${role}`, primaryRole([role])]);
  made.users.push(r.rows[0].id); await pool.query('INSERT INTO user_roles (user_id, role) VALUES ($1,$2)', [r.rows[0].id, role]); return createSession(r.rows[0].id);
}
async function mkPo(over = {}) {
  const o = { status: 'created', poDate: today, delivery: null, ...over };
  const r = await pool.query('INSERT INTO purchase_orders (po_number, po_date, supplier_id, subtotal, total_amount, status, delivery_date) VALUES ($1,$2,$3,100,118,$4,$5) RETURNING id', [`${TAG}-${++seq}`, o.poDate, supplier, o.status, o.delivery]);
  made.pos.push(r.rows[0].id); await pool.query("INSERT INTO po_items (po_id, item_name, quantity, unit, rate, line_amount) VALUES ($1,'Wax',10,'Kg',10,100)", [r.rows[0].id]); return { id: r.rows[0].id, number: `${TAG}-${seq}` };
}
const get = async (token, id) => api(token, 'GET', '/api/po/' + id);
const date = (token, id, body) => api(token, 'PUT', `/api/po/${id}/delivery-date`, body);
const disp = (token, id, body) => api(token, 'PUT', `/api/po/${id}/dispatch`, body);
const row = async (id) => (await pool.query("SELECT status, to_char(delivery_date,'YYYY-MM-DD') AS delivery_date, transporter, tracking_number, vehicle_number, to_char(dispatch_date,'YYYY-MM-DD') AS dispatch_date, tracking_url FROM purchase_orders WHERE id = $1", [id])).rows[0];

test.before(async () => {
  await runMigrations();
  server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), NOTIFY_TEST_MODE: '1' }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch (e) {} await new Promise(r => setTimeout(r,250)); }
  supplier = (await pool.query('INSERT INTO suppliers (name) VALUES ($1) RETURNING id', [TAG + ' supplier'])).rows[0].id; made.suppliers.push(supplier);
  tok.admin = await mkUser('admin'); tok.purchase = await mkUser('purchase'); tok.manager = await mkUser('manager'); tok.store = await mkUser('store');
});
test.after(async () => {
  try {
    await pool.query('DELETE FROM purchase_orders WHERE id = ANY($1)', [made.pos.length ? made.pos : [0]]);
    await pool.query('DELETE FROM suppliers WHERE id = ANY($1)', [made.suppliers.length ? made.suppliers : [0]]);
    await pool.query('DELETE FROM audit_log WHERE actor_id = ANY($1)', [made.users.length ? made.users : [0]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users.length ? made.users : [0]]);
  } finally { server && server.kill(); await pool.end(); }
});

test('permission: Purchase and the Manager hold po.update_delivery, nobody else by default', async () => {
  const c = CATALOG.find(x => x.key === 'po.update_delivery'); assert.ok(c); assert.equal(c.kind, 'edit');
  assert.deepEqual(Object.entries(DEFAULTS).filter(([, k]) => k.includes('po.update_delivery')).map(([r]) => r).sort(), ['manager', 'purchase']);
  assert.deepEqual((await pool.query("SELECT role FROM role_permissions WHERE permission_key = 'po.update_delivery'")).rows.map(r => r.role).sort(), ['manager', 'purchase']);
});

test('the expected date can be set, then changed with a reason; every change is kept with who, when and why', async () => {
  const p = await mkPo();
  assert.equal((await get(tok.purchase, p.id)).can_update_delivery, true); assert.equal((await get(tok.store, p.id)).can_update_delivery, false);
  const first = await date(tok.purchase, p.id, { delivery_date: d(5) }); assert.equal(first.status, 200, JSON.stringify(first)); assert.equal((await row(p.id)).delivery_date, d(5));
  assert.equal((await date(tok.purchase, p.id, { delivery_date: d(8) })).status, 400, 'a reason is needed once there is a date');
  assert.equal((await date(tok.purchase, p.id, { delivery_date: d(8), reason: 'abc' })).status, 400);
  assert.equal((await date(tok.manager, p.id, { delivery_date: d(8), reason: 'Supplier said three days late' })).status, 200, 'the Manager may too');
  assert.equal((await date(tok.purchase, p.id, { delivery_date: d(8), reason: 'same date again' })).status, 400, 'nothing changed');
  const log = (await get(tok.store, p.id)).delivery_log; assert.equal(log.length, 2);
  assert.deepEqual(log[0].old_values, { delivery_date: d(5) }); assert.deepEqual(log[0].new_values, { delivery_date: d(8) }); assert.equal(log[0].reason, 'Supplier said three days late'); assert.equal(log[0].by_name, 'Test manager');
  assert.equal(log[1].old_values.delivery_date, null);
  const a = (await pool.query("SELECT summary, reason FROM audit_log WHERE action = 'po.delivery_date' AND entity_id = $1 ORDER BY id DESC", [p.id])).rows; assert.equal(a.length, 2); assert.match(a[0].summary, new RegExp(`changed from ${d(5)} to ${d(8)}`));
});

test('dates are checked, and only people who hold the key may change them', async () => {
  const p = await mkPo({ poDate: d(-3) });
  const bad = async (body, re) => { const r = await date(tok.purchase, p.id, body); assert.equal(r.status, 400, JSON.stringify(body)); assert.match(r.error, re); };
  await bad({}, /valid date/); await bad({ delivery_date: 'tomorrow' }, /valid date/); await bad({ delivery_date: '2026-02-30' }, /valid date/);
  await bad({ delivery_date: d(-4) }, /before the order date/); await bad({ delivery_date: d(400) }, /more than a year/);
  for (const [t, want] of [['store', 403], [null, 401]]) assert.equal((await date(tok[t], p.id, { delivery_date: d(2) })).status, want);
  assert.equal((await date(tok.purchase, 987654321, { delivery_date: d(2) })).status, 404); assert.equal((await date(tok.purchase, 'abc', { delivery_date: d(2) })).status, 400);
  assert.equal((await row(p.id)).delivery_date, null, 'nothing was saved');
});

test('an order that has been delivered can no longer be changed', async () => {
  const p = await mkPo({ status: 'delivered', delivery: d(1) });
  assert.equal((await date(tok.purchase, p.id, { delivery_date: d(3), reason: 'too late to change' })).status, 409);
  assert.equal((await disp(tok.purchase, p.id, { tracking_number: 'ABC123' })).status, 409);
  assert.equal((await get(tok.purchase, p.id)).can_update_delivery, false);
});

test('a changed date is what Expected Deliveries and "Overdue" use', async () => {
  const p = await mkPo({ poDate: d(-10), delivery: d(-2) });
  const overdue = async () => (await api(tok.store, 'GET', '/api/workspace/expected-deliveries?when=overdue')).deliveries.some(x => x.id === p.id);
  assert.equal(await overdue(), true);
  await date(tok.purchase, p.id, { delivery_date: d(4), reason: 'New date from the supplier' });
  assert.equal(await overdue(), false);
  assert.equal((await api(tok.store, 'GET', '/api/workspace/expected-deliveries?when=soon')).deliveries.some(x => x.id === p.id), true);
});

test('dispatch details: transporter, tracking number, vehicle, date and link are saved and shown to Stores', async () => {
  const p = await mkPo({ status: 'payment_done', delivery: d(3), poDate: d(-4) });
  const ok = await disp(tok.purchase, p.id, { transporter: '  VRL   Logistics ', tracking_number: 'LR 778-12/A', vehicle_number: 'kl 10 ab 1234', dispatch_date: d(-1), tracking_url: 'https://track.example.test/lr?no=77812' });
  assert.equal(ok.status, 200, JSON.stringify(ok)); const r = await row(p.id);
  assert.deepEqual([r.transporter, r.tracking_number, r.vehicle_number, r.dispatch_date, r.tracking_url, r.status], ['VRL Logistics', 'LR 778-12/A', 'KL 10 AB 1234', d(-1), 'https://track.example.test/lr?no=77812', 'payment_done'], 'spaces tidied, the vehicle in capitals, the status untouched');
  const e = (await api(tok.store, 'GET', '/api/workspace/expected-deliveries')).deliveries.find(x => x.id === p.id);
  assert.equal(e.po_date, d(-4), 'the order date comes too, so the date form can stop earlier dates'); assert.equal(e.tracking_number, 'LR 778-12/A'); assert.equal(e.transporter, 'VRL Logistics'); assert.equal(e.vehicle_number, 'KL 10 AB 1234'); assert.equal(e.dispatch_date, d(-1)); assert.equal(e.tracking_url, 'https://track.example.test/lr?no=77812');
  const log = (await get(tok.store, p.id)).delivery_log.find(x => x.kind === 'dispatch'); assert.equal(log.by_name, 'Test purchase'); assert.equal(log.new_values.tracking_number, 'LR 778-12/A');
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'po.dispatch' AND entity_id = $1", [p.id])).rows[0].n, 1);
});

test('dispatch details are checked: something to track, a safe link, a real date, a reason when changing', async () => {
  const p = await mkPo({ poDate: d(-5) });
  const bad = async (body, re) => { const r = await disp(tok.purchase, p.id, body); assert.equal(r.status, 400, JSON.stringify(body)); assert.match(r.error, re); };
  await bad({}, /at least the transporter/); await bad({ transporter: '  ' }, /at least the transporter/);
  await bad({ tracking_number: '<script>alert(1)</script>' }, /letters, numbers/); await bad({ tracking_number: '-LR' }, /letters, numbers/);
  await bad({ tracking_number: 'A1', tracking_url: 'http://track.example.test' }, /https/); await bad({ tracking_number: 'A1', tracking_url: 'javascript:alert(1)' }, /https/);
  await bad({ tracking_number: 'A1', tracking_url: 'https://user:pw@track.example.test' }, /https/); await bad({ tracking_number: 'A1', tracking_url: 'not a link' }, /https/);
  await bad({ tracking_number: 'A1', dispatch_date: d(1) }, /future/); await bad({ tracking_number: 'A1', dispatch_date: d(-6) }, /before the order date/); await bad({ tracking_number: 'A1', dispatch_date: '2026-02-30' }, /valid date/);
  assert.equal((await disp(tok.store, p.id, { tracking_number: 'A1' })).status, 403); assert.equal((await disp(null, p.id, { tracking_number: 'A1' })).status, 401);
  assert.equal((await row(p.id)).tracking_number, null, 'nothing was saved');
  assert.equal((await disp(tok.purchase, p.id, { tracking_number: 'A1', transporter: 'DTDC' })).status, 200);
  assert.equal((await disp(tok.purchase, p.id, { tracking_number: 'A2', transporter: 'DTDC' })).status, 400, 'a reason is needed to change details');
  assert.equal((await disp(tok.purchase, p.id, { tracking_number: 'A2', transporter: 'DTDC', reason: 'Supplier sent a new number' })).status, 200);
  assert.equal((await disp(tok.purchase, p.id, { tracking_number: 'A2', transporter: 'DTDC', reason: 'no real change' })).status, 400, 'nothing changed');
  const log = (await get(tok.purchase, p.id)).delivery_log; assert.equal(log.length, 2); assert.equal(log[0].old_values.tracking_number, 'A1'); assert.equal(log[0].new_values.tracking_number, 'A2');
});

test('"also mark as in transit" only works once payment is done, and never goes backwards', async () => {
  const early = await mkPo({ status: 'created' });
  const r = await disp(tok.purchase, early.id, { tracking_number: 'T1', mark_in_transit: true }); assert.equal(r.status, 400); assert.match(r.error, /payment is done/); assert.equal((await row(early.id)).status, 'created');
  assert.equal((await disp(tok.purchase, early.id, { tracking_number: 'T1' })).status, 200); assert.equal((await row(early.id)).status, 'created', 'details alone never change the status, so an advance payment can still be recorded');
  const paid = await mkPo({ status: 'payment_done' });
  const ok = await disp(tok.purchase, paid.id, { tracking_number: 'T2', mark_in_transit: true }); assert.equal(ok.status, 200); assert.equal(ok.status === 200 && (await row(paid.id)).status, 'in_transit');
  const again = await disp(tok.purchase, paid.id, { tracking_number: 'T3', reason: 'Corrected number', mark_in_transit: true }); assert.equal(again.status, 400, 'it is already in transit, not payment_done');
  assert.equal((await disp(tok.purchase, paid.id, { tracking_number: 'T3', reason: 'Corrected number' })).status, 200); assert.equal((await row(paid.id)).status, 'in_transit', 'still in transit');
});

test('an order\'s history goes with it when the order is removed by an administrator', async () => {
  const p = await mkPo(); await date(tok.purchase, p.id, { delivery_date: d(2) });
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM po_delivery_log WHERE po_id = $1', [p.id])).rows[0].n, 1);
  const rm = await api(tok.admin, 'POST', '/api/admin/data/records/po/delete', { ids: [p.id], confirm: p.number, reason: 'test cleanup' }); assert.equal(rm.status, 200, JSON.stringify(rm));
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM po_delivery_log WHERE po_id = $1', [p.id])).rows[0].n, 0);
});
