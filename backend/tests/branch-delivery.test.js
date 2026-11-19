// Branch confirms delivery: rules (no database) and the real server. Everything created is removed afterwards.
//   node --test tests/branch-delivery.test.js
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
const { DEFAULTS, CATALOG } = require('../permissions');
const D = require('../delivery');
const R = require('../rd-logic');

// ------------------------------------------------------------------ the rules
const items = [{ id: 1, quantity: 100 }, { id: 2, quantity: 10 }];
test('rules: none, partial, complete and closed short are worked out from what was received', () => {
  assert.equal(D.deliveryState(items, {}, false).state, 'none');
  const part = D.deliveryState(items, { 1: { qty: 60, damaged: 0 } }, false);
  assert.equal(part.state, 'partial'); assert.equal(D.deliveryText(part), '60 of 110 received'); assert.equal(part.has_problem, false);
  assert.equal(D.deliveryState(items, { 1: { qty: 100, damaged: 0 }, 2: { qty: 10, damaged: 0 } }, false).state, 'complete');
  const short = D.deliveryState(items, { 1: { qty: 100, damaged: 0 }, 2: { qty: 4, damaged: 0 } }, true);
  assert.equal(short.state, 'closed_short'); assert.equal(short.has_problem, true); assert.match(D.deliveryText(short), /^Closed short/);
  assert.equal(D.deliveryState(items, { 1: { qty: 100, damaged: 0 }, 2: { qty: 10, damaged: 0 } }, true).state, 'complete', 'closed but everything arrived is simply complete');
  assert.equal(D.deliveryState([], {}, false).state, 'none', 'a request with no lines is never "complete"');
  assert.equal(D.deliveryState(items, new Map([[1, { qty: 5, damaged: 2 }]]), false).has_problem, true, 'damage is a problem');
  assert.equal(D.deliveryState([{ id: 1, quantity: 0.3 }], { 1: { qty: 0.1 + 0.2, damaged: 0 } }, false).state, 'complete', 'decimals do not leave 0.0000000004 "remaining"');
});
test('rules: only an approved or in-progress request that is not finished can be confirmed', () => {
  for (const s of ['approved', 'po_raised']) { assert.equal(D.canStillConfirm(s, 'none'), true); assert.equal(D.canStillConfirm(s, 'partial'), true); assert.equal(D.canStillConfirm(s, 'complete'), false); assert.equal(D.canStillConfirm(s, 'closed_short'), false); }
  for (const s of ['pending', 'rejected']) assert.equal(D.canStillConfirm(s, 'none'), false);
});
test('rules: a confirmation is checked against what is still expected', () => {
  const now = [{ id: 1, item_name: 'Wax', quantity: 100, received: 60 }, { id: 2, item_name: 'Cloth', quantity: 10, received: 0 }];
  const ok = D.validateReceipt({ items: [{ item_id: 1, qty: 40 }, { item_id: 2, qty: '' }], note: '' }, now); assert.deepEqual(ok.lines, [{ item_id: 1, qty: 40, damaged_qty: 0 }]);
  const bad = (b, re) => assert.match(D.validateReceipt(b, now).error || '', re);
  bad({ items: [{ item_id: 1, qty: 41 }] }, /only 40 is still expected/);
  bad({ items: [{ item_id: 1, qty: -1 }] }, /0 or more/); bad({ items: [{ item_id: 1, qty: 'abc' }] }, /0 or more/);
  bad({ items: [{ item_id: 1, qty: 5, damaged_qty: 6 }], note: 'cracked' }, /cannot be more/);
  bad({ items: [{ item_id: 1, qty: 5, damaged_qty: 1 }] }, /Say what was wrong/);
  bad({ items: [{ item_id: 1, qty: 5, damaged_qty: 1 }], note: 'abc' }, /Say what was wrong/);
  bad({ items: [{ item_id: 99, qty: 1 }] }, /not part of this request/);
  bad({ items: [{ item_id: 1, qty: 1 }, { item_id: 1, qty: 1 }] }, /twice/);
  bad({ items: [{ item_id: 1, qty: 0 }] }, /at least one item/); bad({}, /Enter what arrived/);
  bad({ items: [{ item_id: 1, qty: 40 }], final: true }, /why the rest is not coming/);
  assert.ok(D.validateReceipt({ items: [{ item_id: 1, qty: 40 }], final: true, note: 'Supplier cancelled the cloth' }, now).final);
  assert.ok(D.validateReceipt({ items: [{ item_id: 1, qty: 40 }, { item_id: 2, qty: 10 }], final: true }, now).final, 'closing with everything received needs no explanation');
  assert.equal(D.validateReceipt({ items: [{ item_id: 1, qty: 1 }], note: 'x'.repeat(500) }, now).note.length, 300);
});

// ------------------------------------------------------------------ the real server
const PORT = 3291, BASE = `http://localhost:${PORT}`, TAG = 'ZZD' + crypto.randomBytes(3).toString('hex').toUpperCase();
const made = { users: [], requests: [] }; const tok = {}; let server;
async function api(token, method, url, body) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await res.json(); } catch (e) {} return { status: res.status, ...j };
}
async function mkUser(label, role, branch) {
  const hash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 4);
  const r = await pool.query('INSERT INTO users (username, password_hash, name, role, branch) VALUES ($1,$2,$3,$4,$5) RETURNING id', [`${TAG}_${label}`.toLowerCase(), hash, `Test ${label}`, role, branch || null]);
  made.users.push(r.rows[0].id); await pool.query('INSERT INTO user_roles (user_id, role) VALUES ($1,$2)', [r.rows[0].id, role]);
  if (branch) await pool.query("INSERT INTO user_scopes (user_id, role, scope_type, scope_value) VALUES ($1,$2,'branch',$3)", [r.rows[0].id, role, branch]);
  return createSession(r.rows[0].id);
}
let seq = 0;
async function mkReq(over = {}) {
  const o = { branch: 'Kannur', status: 'approved', due: R.todayIST(), ...over };
  const r = await pool.query("INSERT INTO branch_stock_requests (request_number, branch, requested_by, status, delivery_needed_by) VALUES ($1,$2,'Test',$3,$4) RETURNING id", [`${TAG}-${++seq}`, o.branch, o.status, o.due]);
  made.requests.push(r.rows[0].id);
  const wax = (await pool.query("INSERT INTO branch_request_items (request_id, item_name, quantity, unit) VALUES ($1,'Wax',100,'Nos') RETURNING id", [r.rows[0].id])).rows[0].id;
  const cloth = (await pool.query("INSERT INTO branch_request_items (request_id, item_name, quantity, unit) VALUES ($1,'Cloth',10,'Nos') RETURNING id", [r.rows[0].id])).rows[0].id;
  return { id: r.rows[0].id, number: `${TAG}-${seq}`, wax, cloth };
}
const confirm = (token, q, items, extra = {}) => api(token, 'POST', `/api/branch-request/${q.id}/receipts`, { items, ...extra });

test.before(async () => {
  await runMigrations();
  server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), NOTIFY_TEST_MODE: '1' }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch (e) {} await new Promise(r => setTimeout(r, 250)); }
  tok.admin = await mkUser('admin', 'admin'); tok.manager = await mkUser('manager', 'manager');
  tok.kannur = await mkUser('kannur', 'branch', 'Kannur'); tok.thrissur = await mkUser('thrissur', 'branch', 'Thrissur');
});
test.after(async () => {
  try {
    await pool.query('DELETE FROM branch_stock_requests WHERE id = ANY($1)', [made.requests.length ? made.requests : [0]]);       // receipts go with them
    await pool.query('DELETE FROM audit_log WHERE actor_id = ANY($1)', [made.users.length ? made.users : [0]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users.length ? made.users : [0]]);
  } finally { server && server.kill(); await pool.end(); }
});

test('permission: the new key is in the catalogue, held by the Branch role and the Manager (and the administrator), nobody else', async () => {
  const c = CATALOG.find(x => x.key === 'branch_request.confirm_delivery'); assert.ok(c); assert.equal(c.kind, 'edit');
  const holders = Object.entries(DEFAULTS).filter(([, k]) => k.includes('branch_request.confirm_delivery')).map(([r]) => r); assert.deepEqual(holders.sort(), ['branch', 'manager']);
  const db = await pool.query("SELECT role FROM role_permissions WHERE permission_key = 'branch_request.confirm_delivery'"); assert.deepEqual(db.rows.map(r => r.role).sort(), ['branch', 'manager']);
});

test('a branch confirms in parts; the list and the details show how much has arrived; the request itself is not changed', async () => {
  const q = await mkReq();
  assert.equal((await api(tok.kannur, 'GET', '/api/branch-request/' + q.id)).delivery.state, 'none');
  const a = await confirm(tok.kannur, q, [{ item_id: q.wax, qty: 30 }]); assert.equal(a.status, 201, JSON.stringify(a)); assert.equal(a.state, 'partial'); assert.equal(a.text, '30 of 110 received');
  const d = await api(tok.kannur, 'GET', '/api/branch-request/' + q.id);
  assert.equal(d.delivery.state, 'partial'); assert.equal(d.delivery.can_confirm, true); assert.equal(d.delivery.receipts.length, 1); assert.equal(d.delivery.receipts[0].by, 'Test kannur');
  assert.deepEqual(d.delivery.lines.find(l => l.item_id === q.wax), { item_id: q.wax, requested: 100, received: 30, damaged: 0, remaining: 70 });
  assert.equal(d.request.status, 'approved', 'confirming never changes the request status');
  const list = await api(tok.kannur, 'GET', '/api/branch-request'); const row = list.requests.find(r => r.id === q.id); assert.equal(row.delivery.text, '30 of 110 received');
  const b = await confirm(tok.kannur, q, [{ item_id: q.wax, qty: 70 }, { item_id: q.cloth, qty: 10 }]); assert.equal(b.state, 'complete');
  assert.equal((await api(tok.kannur, 'GET', '/api/branch-request/' + q.id)).delivery.can_confirm, false);
  assert.equal((await confirm(tok.kannur, q, [{ item_id: q.wax, qty: 1 }])).status, 409, 'nothing more can be confirmed once everything has arrived');
  const log = (await pool.query("SELECT summary FROM audit_log WHERE action = 'request.delivery' AND entity_id = $1 ORDER BY id", [q.id])).rows; assert.equal(log.length, 2); assert.match(log[1].summary, /Received/);
});

test('wrong quantities are refused and nothing is saved', async () => {
  const q = await mkReq();
  const no = async (items, extra, re) => { const r = await confirm(tok.kannur, q, items, extra); assert.equal(r.status, 400, JSON.stringify(r)); assert.match(r.error, re); };
  await no([{ item_id: q.wax, qty: 101 }], {}, /only 100 is still expected/);
  await no([{ item_id: q.wax, qty: 10, damaged_qty: 11 }], { note: 'broken' }, /cannot be more/);
  await no([{ item_id: q.wax, qty: 10, damaged_qty: 2 }], {}, /Say what was wrong/);
  await no([], {}, /at least one item/); await no([{ item_id: q.wax, qty: 0 }], {}, /at least one item/);
  await no([{ item_id: 987654321, qty: 1 }], {}, /not part of this request/); await no([{ item_id: q.wax, qty: -5 }], {}, /0 or more/);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM branch_receipts WHERE request_id = $1', [q.id])).rows[0].n, 0);
});

test('damage must be explained, shows as a problem, and reaches the Manager', async () => {
  const q = await mkReq();
  const r = await confirm(tok.kannur, q, [{ item_id: q.wax, qty: 100, damaged_qty: 12 }, { item_id: q.cloth, qty: 10 }], { note: '12 tins dented in transit' }); assert.equal(r.status, 201, JSON.stringify(r)); assert.equal(r.state, 'complete');
  const d = await api(tok.kannur, 'GET', '/api/branch-request/' + q.id); assert.equal(d.delivery.has_problem, true); assert.equal(d.delivery.damaged, 12); assert.equal(d.delivery.receipts[0].note, '12 tins dented in transit');
  const m = await api(tok.manager, 'GET', '/api/workspace/manager/dashboard');
  const ex = m.exceptions.items.find(x => x.number === q.number); assert.ok(ex, 'the Manager sees the problem'); assert.match(ex.reason, /12 reported damaged/);
  const own = await api(tok.kannur, 'GET', '/api/workspace/branch/dashboard'); assert.ok(own.exceptions.items.some(x => x.number === q.number), 'and so does the branch');
});

test('"nothing more is coming" closes a short delivery, with a reason', async () => {
  const q = await mkReq();
  assert.equal((await confirm(tok.kannur, q, [{ item_id: q.wax, qty: 100 }], { final: true })).status, 400, 'a reason is needed when something will not arrive');
  const r = await confirm(tok.kannur, q, [{ item_id: q.wax, qty: 100 }, { item_id: q.cloth, qty: 4 }], { final: true, note: 'Supplier could only send 4 cloths' }); assert.equal(r.status, 201); assert.equal(r.state, 'closed_short');
  const d = await api(tok.kannur, 'GET', '/api/branch-request/' + q.id); assert.equal(d.delivery.has_problem, true); assert.equal(d.delivery.can_confirm, false); assert.equal(d.delivery.receipts[0].is_final, true);
  assert.equal((await confirm(tok.kannur, q, [{ item_id: q.cloth, qty: 1 }])).status, 409, 'closed');
  const m = await api(tok.manager, 'GET', '/api/workspace/manager/dashboard'); assert.ok(m.exceptions.items.some(x => x.number === q.number && /nothing more is coming/.test(x.reason)));
  const nothing = await mkReq(); assert.equal((await confirm(tok.kannur, nothing, [], { final: true, note: 'Nothing was ever delivered' })).state, 'closed_short', 'a branch may close a request when nothing arrived at all');
});

test('only a request that is being fulfilled can be confirmed', async () => {
  for (const status of ['pending', 'rejected']) { const q = await mkReq({ status }); const r = await confirm(tok.kannur, q, [{ item_id: q.wax, qty: 1 }]); assert.equal(r.status, 409, status); }
  assert.equal((await confirm(tok.kannur, { id: 99999999 }, [{ item_id: 1, qty: 1 }])).status, 404);
  const po = await mkReq({ status: 'po_raised' }); assert.equal((await confirm(tok.kannur, po, [{ item_id: po.wax, qty: 1 }])).status, 201, 'also while the purchase order is being arranged');
});

test('who may confirm: the branch concerned, the Manager and administrators; not another branch, not a stranger', async () => {
  const q = await mkReq();
  assert.equal((await confirm(tok.thrissur, q, [{ item_id: q.wax, qty: 1 }])).status, 403, 'a different branch');
  assert.equal((await confirm(null, q, [{ item_id: q.wax, qty: 1 }])).status, 401);
  assert.equal((await api(tok.manager, 'GET', '/api/branch-request/' + q.id)).delivery.can_confirm, true, 'the Manager is offered the form');
  const byManager = await confirm(tok.manager, q, [{ item_id: q.wax, qty: 1 }]); assert.equal(byManager.status, 201, 'the Manager may confirm for any branch (for example when the branch phones it in)');
  assert.equal((await api(tok.kannur, 'GET', '/api/branch-request/' + q.id)).delivery.receipts[0].by, 'Test manager', 'and it is recorded under the Manager\'s own name');
  assert.equal((await confirm(tok.admin, q, [{ item_id: q.wax, qty: 1 }])).status, 201, 'an administrator may');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM branch_receipts WHERE request_id = $1', [q.id])).rows[0].n, 2);
});

test('simultaneous confirmations can never receive more than was requested', async () => {
  const q = await mkReq();
  const rs = await Promise.all(Array.from({ length: 6 }, () => confirm(tok.kannur, q, [{ item_id: q.wax, qty: 30 }])));
  assert.equal(rs.filter(r => r.status === 201).length, 3, JSON.stringify(rs.map(r => r.status)));
  const d = await api(tok.kannur, 'GET', '/api/branch-request/' + q.id); assert.equal(d.delivery.lines.find(l => l.item_id === q.wax).received, 90);
});

test('the branch dashboard asks for deliveries whose date has come, and finished requests leave its list', async () => {
  const due = await mkReq({ due: R.addDays(R.todayIST(), -2) }), later = await mkReq({ due: R.addDays(R.todayIST(), 20) }), done = await mkReq({ due: R.addDays(R.todayIST(), -1) });
  await confirm(tok.kannur, done, [{ item_id: done.wax, qty: 100 }, { item_id: done.cloth, qty: 10 }]);
  const w = await api(tok.kannur, 'GET', '/api/workspace/branch/dashboard');
  const c = w.cards.find(x => x.label === 'Deliveries to confirm'); assert.ok(c, JSON.stringify(w.cards.map(x => x.label)));
  const numbers = w.queue.items.map(x => x.number);
  assert.ok(numbers.includes(due.number) && numbers.includes(later.number)); assert.ok(!numbers.includes(done.number), 'a fully received request is no longer waiting');
  assert.equal(w.queue.items.find(x => x.number === due.number).next.label, 'Confirm delivery'); assert.equal(w.queue.items.find(x => x.number === later.number).next.label, 'Open request');
  const man = await api(tok.manager, 'GET', '/api/workspace/manager/dashboard'); assert.ok(!man.exceptions.items.some(x => x.number === done.number), 'no problem was reported on it');
});
