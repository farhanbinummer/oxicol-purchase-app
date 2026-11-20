// Suppliers screen: add, edit, switch off, GST number, bank details. A real server on its own port; everything created is removed afterwards.
//   node --test tests/suppliers.test.js
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

const PORT = 3286, BASE = `http://localhost:${PORT}`, TAG = 'ZZS' + crypto.randomBytes(3).toString('hex').toUpperCase();
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
const row = async (id) => (await pool.query('SELECT * FROM suppliers WHERE id = $1', [id])).rows[0];
const add = async (token, over = {}) => { const r = await api(token, 'POST', '/api/suppliers', { name: `${TAG} supplier ${++seq}`, ...over }); if (r.id) made.suppliers.push(r.id); return r; };
// a valid GST number made unique per call: 32 + 5 letters + 4 digits + letter + 1 + Z + check character
const gst = (n) => `32ABCDE${String(1000 + n).slice(-4)}F1Z5`;

test.before(async () => {
  await runMigrations();
  server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), NOTIFY_TEST_MODE: '1' }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch (e) {} await new Promise(r => setTimeout(r, 250)); }
  tok.admin = await mkUser('admin'); tok.purchase = await mkUser('purchase'); tok.manager = await mkUser('manager'); tok.accounts = await mkUser('accounts'); tok.store = await mkUser('store');
});
test.after(async () => {
  try {
    await pool.query('DELETE FROM purchase_orders WHERE id = ANY($1)', [made.pos.length ? made.pos : [0]]);
    await pool.query('DELETE FROM suppliers WHERE id = ANY($1)', [made.suppliers.length ? made.suppliers : [0]]);
    await pool.query('DELETE FROM audit_log WHERE actor_id = ANY($1)', [made.users.length ? made.users : [0]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users.length ? made.users : [0]]);
  } finally { server && server.kill(); await pool.end(); }
});

test('permission: Purchase and the Manager may add and edit suppliers; nobody else by default', async () => {
  const c = CATALOG.find(x => x.key === 'suppliers.manage'); assert.ok(c); assert.equal(c.kind, 'edit');
  assert.deepEqual(Object.entries(DEFAULTS).filter(([, k]) => k.includes('suppliers.manage')).map(([r]) => r).sort(), ['manager', 'purchase']);
  assert.deepEqual((await pool.query("SELECT role FROM role_permissions WHERE permission_key = 'suppliers.manage'")).rows.map(r => r.role).sort(), ['manager', 'purchase']);
});

test('adding a supplier with every detail; the name, contact, GST and email are tidied and saved, and it is audited', async () => {
  const r = await add(tok.purchase, { contact_person: '  Mr   Nair ', phone: '+91 98470 12345', email: 'Sales@Example.Test ', gst_number: ' 32abcde1234f1z5 ', bank_name: 'SBI', account_number: '1234 5678 9012', ifsc_code: 'sbin0001234' });
  assert.equal(r.status, 201, JSON.stringify(r)); const s = await row(r.id);
  assert.deepEqual([s.contact_person, s.phone, s.email, s.gst_number, s.bank_name, s.account_number, s.ifsc_code, s.status], ['Mr Nair', '+91 98470 12345', 'sales@example.test', '32ABCDE1234F1Z5', 'SBI', '123456789012', 'SBIN0001234', 'active']);
  const log = (await pool.query("SELECT summary, after_data FROM audit_log WHERE action = 'supplier.create' AND entity_id = $1", [r.id])).rows[0]; assert.match(log.summary, /Added supplier/);
  assert.equal(log.after_data.account_number, '****9012', 'the account number is never kept in full in the audit history');
  const mgr = await add(tok.manager); assert.equal(mgr.status, 201, 'the Manager may too');
});

test('only a name is required; everything else is optional', async () => {
  const r = await add(tok.purchase); assert.equal(r.status, 201); const s = await row(r.id); assert.equal(s.gst_number, null); assert.equal(s.phone, null);
});

test('every field is checked, with a plain message', async () => {
  const bad = async (body, re, status = 400) => { const r = await api(tok.purchase, 'POST', '/api/suppliers', { name: `${TAG} bad ${++seq}`, ...body }); assert.equal(r.status, status, JSON.stringify(body)); assert.match(r.error, re); };
  assert.equal((await api(tok.purchase, 'POST', '/api/suppliers', {})).status, 400); assert.equal((await api(tok.purchase, 'POST', '/api/suppliers', { name: '   ' })).status, 400);
  await bad({ phone: 'call me' }, /phone number/); await bad({ phone: '123' }, /phone number/); await bad({ email: 'nope' }, /email/); await bad({ email: 'a@b' }, /email/);
  await bad({ gst_number: '12345' }, /GST number/); await bad({ gst_number: '32ABCDE1234F1Z' }, /GST number/); await bad({ gst_number: '99!!!!!!!!!!!!!' }, /GST number/);
  await bad({ ifsc_code: 'SBIN123' }, /IFSC/); await bad({ ifsc_code: 'SBIN1001234' }, /IFSC/); await bad({ account_number: '12' }, /account number/); await bad({ account_number: '12 34-56' }, /account number/);
  assert.equal(await pool.query("SELECT COUNT(*)::int AS n FROM suppliers WHERE name LIKE $1", [TAG + ' bad%']).then(r => r.rows[0].n), 0, 'nothing was saved');
});

test('a name or GST number cannot be used twice (capital letters do not matter)', async () => {
  const a = await add(tok.purchase, { name: `${TAG} Twin`, gst_number: gst(1) }); assert.equal(a.status, 201);
  const sameName = await api(tok.purchase, 'POST', '/api/suppliers', { name: `${TAG} TWIN` }); assert.equal(sameName.status, 409); assert.match(sameName.error, /name already exists/);
  const sameGst = await api(tok.purchase, 'POST', '/api/suppliers', { name: `${TAG} other`, gst_number: gst(1).toLowerCase() }); assert.equal(sameGst.status, 409); assert.match(sameGst.error, new RegExp(`${TAG} Twin`));
  const b = await add(tok.purchase, { name: `${TAG} Second`, gst_number: gst(2) }); assert.equal(b.status, 201);
  assert.equal((await api(tok.purchase, 'PUT', '/api/suppliers/' + b.id, { gst_number: gst(1) })).status, 409); assert.equal((await api(tok.purchase, 'PUT', '/api/suppliers/' + b.id, { name: `${TAG} twin` })).status, 409);
  assert.equal((await api(tok.purchase, 'PUT', '/api/suppliers/' + a.id, { name: `${TAG} TWIN` })).status, 200, 'changing the capitals of its own name is not a clash with itself');
  assert.equal((await api(tok.purchase, 'PUT', '/api/suppliers/' + a.id, { name: `${TAG} TWIN`, gst_number: gst(1) })).status, 400, 'the same values again: nothing changed');
});

test('editing saves only what changed, keeps the old values in the audit history, and says "nothing changed" when it is', async () => {
  const s = await add(tok.purchase, { name: `${TAG} Edit me`, phone: '9847012345', gst_number: gst(3) });
  assert.equal((await api(tok.manager, 'PUT', '/api/suppliers/' + s.id, { phone: '9847099999', contact_person: 'New person' })).status, 200);
  const r = await row(s.id); assert.equal(r.phone, '9847099999'); assert.equal(r.contact_person, 'New person'); assert.equal(r.gst_number, gst(3), 'untouched');
  const log = (await pool.query("SELECT before_data, after_data FROM audit_log WHERE action = 'supplier.update' AND entity_id = $1", [s.id])).rows[0]; assert.equal(log.before_data.phone, '9847012345'); assert.equal(log.after_data.phone, '9847099999'); assert.ok(!('gst_number' in log.after_data));
  assert.equal((await api(tok.purchase, 'PUT', '/api/suppliers/' + s.id, { phone: '9847099999' })).status, 400);
  assert.equal((await api(tok.purchase, 'PUT', '/api/suppliers/' + s.id, { gst_number: '' })).status, 200); assert.equal((await row(s.id)).gst_number, null, 'a value can be cleared');
  assert.equal((await api(tok.purchase, 'PUT', '/api/suppliers/987654321', { phone: '9847099999' })).status, 404); assert.equal((await api(tok.purchase, 'PUT', '/api/suppliers/abc', { phone: '9847099999' })).status, 400); assert.equal((await api(tok.purchase, 'PUT', '/api/suppliers/' + s.id, {})).status, 400);
});

test('switching off hides a supplier from the order dropdown and keeps its old orders; it can be switched back on', async () => {
  const s = await add(tok.purchase, { name: `${TAG} Switchable` });
  const po = (await pool.query("INSERT INTO purchase_orders (po_number, supplier_id, subtotal, total_amount) VALUES ($1,$2,10,11.8) RETURNING id", [`${TAG}-PO`, s.id])).rows[0].id; made.pos.push(po);
  const inDropdown = async () => (await api(tok.purchase, 'GET', '/api/suppliers')).suppliers.some(x => x.id === s.id);
  assert.equal(await inDropdown(), true);
  assert.equal((await api(tok.purchase, 'PUT', '/api/suppliers/' + s.id, { active: false })).status, 200); assert.equal(await inDropdown(), false);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM purchase_orders WHERE id = $1', [po])).rows[0].n, 1, 'the old order stays');
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'supplier.off' AND entity_id = $1", [s.id])).rows[0].n, 1);
  const off = (await api(tok.purchase, 'GET', '/api/suppliers/list?filter=off')).suppliers; assert.ok(off.some(x => x.id === s.id) && off.every(x => x.status === 'inactive'));
  const all = (await api(tok.purchase, 'GET', '/api/suppliers/list?q=Switchable')).suppliers.find(x => x.id === s.id); assert.equal(all.orders, 1);
  assert.equal((await api(tok.purchase, 'PUT', '/api/suppliers/' + s.id, { active: true })).status, 200); assert.equal(await inDropdown(), true);
  assert.equal((await api(tok.purchase, 'PUT', '/api/suppliers/' + s.id, { active: 'no' })).status, 400);
});

test('the list: searchable by name, GST number, contact or phone; shows orders and payments', async () => {
  const s = await add(tok.purchase, { name: `${TAG} Searchy`, contact_person: 'Zebulon Quark', phone: '9000011122', gst_number: gst(4) });
  for (const q of ['Searchy', gst(4).slice(0, 8), 'zebulon', '90000111']) assert.ok((await api(tok.purchase, 'GET', '/api/suppliers/list?q=' + q)).suppliers.some(x => x.id === s.id), q);
  const l = await api(tok.purchase, 'GET', '/api/suppliers/list'); assert.ok(l.totals.total >= 1 && l.totals.off >= 0); assert.equal(l.can_manage, true);
});

test('who may do what: everyone who sees suppliers may read; only Purchase, the Manager and administrators change them', async () => {
  const s = await add(tok.purchase);
  for (const t of ['accounts', 'store']) {
    const l = await api(tok[t], 'GET', '/api/suppliers/list'); if (l.status === 200) assert.equal(l.can_manage, false, t);
    assert.equal((await api(tok[t], 'POST', '/api/suppliers', { name: `${TAG} nope` })).status, 403, t); assert.equal((await api(tok[t], 'PUT', '/api/suppliers/' + s.id, { phone: '9847012345' })).status, 403, t);
  }
  assert.equal((await api(null, 'POST', '/api/suppliers', { name: 'x' })).status, 401); assert.equal((await api(null, 'GET', '/api/suppliers/list')).status, 401);
  assert.equal((await add(tok.admin)).status, 201, 'an administrator may');
});

test('bank details are only shown to, and only accepted from, people who hold bank access', async () => {
  const s = await add(tok.purchase, { bank_name: 'SBI', account_number: '987654321012', ifsc_code: 'SBIN0001234' });
  const own = (await api(tok.purchase, 'GET', '/api/suppliers/list?q=' + TAG)).suppliers.find(x => x.id === s.id); assert.equal(own.account_number, '987654321012');
  assert.equal((await api(tok.purchase, 'GET', '/api/suppliers/list')).can_bank, true);
  const mgr = await api(tok.manager, 'GET', '/api/suppliers/list?q=' + TAG); const m = mgr.suppliers.find(x => x.id === s.id);
  assert.equal(mgr.can_bank, false); assert.ok(!('account_number' in m) && !('bank_name' in m) && !('ifsc_code' in m), 'the Manager never receives bank details');
  assert.equal((await api(tok.manager, 'GET', '/api/suppliers')).suppliers.some(x => 'account_number' in x), false);
  const tryWrite = await api(tok.manager, 'PUT', '/api/suppliers/' + s.id, { account_number: '111111111111' }); assert.equal(tryWrite.status, 403);
  assert.equal((await api(tok.manager, 'POST', '/api/suppliers', { name: `${TAG} mgr bank`, ifsc_code: 'SBIN0001234' })).status, 403);
  assert.equal((await row(s.id)).account_number, '987654321012', 'unchanged');
  assert.equal((await api(tok.manager, 'PUT', '/api/suppliers/' + s.id, { phone: '9847012345', account_number: '', bank_name: '' })).status, 200, 'empty bank fields from a form that hides them are ignored');
  const after = await row(s.id); assert.equal(after.bank_name, 'SBI', 'and do not wipe the bank details'); assert.equal(after.phone, '9847012345');
});
