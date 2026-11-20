// A production request can be changed by the person who raised it, but only until it is approved. A real server on its own port.
//   node --test tests/indent-edit.test.js
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

const PORT = 3285, BASE = `http://localhost:${PORT}`, TAG = 'ZZI' + crypto.randomBytes(3).toString('hex').toUpperCase();
const made = { users: [], indents: [] }; const tok = {}; let server;
async function api(token, method, url, body) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await res.json(); } catch (e) {} return { ...j, status: res.status };
}
async function mkUser(label, role) {
  const hash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 4);
  const r = await pool.query('INSERT INTO users (username, password_hash, name, role) VALUES ($1,$2,$3,$4) RETURNING id', [`${TAG}_${label}`.toLowerCase(), hash, `Test ${label}`, primaryRole([role])]);
  made.users.push(r.rows[0].id); await pool.query('INSERT INTO user_roles (user_id, role) VALUES ($1,$2)', [r.rows[0].id, role]); return createSession(r.rows[0].id);
}
const item = (name, qty = 5, over = {}) => ({ item_name: name, quantity: qty, unit: 'Kg', priority: 'normal', ...over });
async function raise(token, items, head = 'Head One') {
  const r = await api(token, 'POST', '/api/production-indent/create', { production_head: head, items: items || [item('Wax'), item('Cloth', 2, { unit: 'Nos' })] });
  assert.equal(r.status, 201, JSON.stringify(r)); made.indents.push(r.indent_id); return r.indent_id;
}
const edit = (token, id, body) => api(token, 'PUT', '/api/production-indent/' + id, body);
const row = async (id) => (await pool.query('SELECT status, production_head, edit_count, edited_at FROM production_indents WHERE id = $1', [id])).rows[0];
const names = async (id) => (await pool.query('SELECT item_name, quantity::float AS q FROM production_indent_items WHERE indent_id = $1 ORDER BY id', [id])).rows.map(x => `${x.item_name}:${x.q}`);

test.before(async () => {
  await runMigrations();
  server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), NOTIFY_TEST_MODE: '1' }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch (e) {} await new Promise(r => setTimeout(r, 250)); }
  tok.prodA = await mkUser('proda', 'production'); tok.prodB = await mkUser('prodb', 'production'); tok.store = await mkUser('store', 'store'); tok.admin = await mkUser('admin', 'admin'); tok.manager = await mkUser('manager', 'manager');
});
test.after(async () => {
  try {
    await pool.query('DELETE FROM production_indents WHERE id = ANY($1)', [made.indents.length ? made.indents : [0]]);
    await pool.query('DELETE FROM audit_log WHERE actor_id = ANY($1)', [made.users.length ? made.users : [0]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users.length ? made.users : [0]]);
  } finally { server && server.kill(); await pool.end(); }
});

test('the requester can change a pending request: head, items, quantities, units, dates and priorities', async () => {
  const id = await raise(tok.prodA);
  const d0 = await api(tok.prodA, 'GET', '/api/production-indent/' + id); assert.equal(d0.can_edit, true); assert.equal(d0.indent.edit_count, 0);
  const r = await edit(tok.prodA, id, { production_head: '  Head Two ', version: 0, items: [item('Wax', 9, { required_by: '2027-01-15', priority: 'urgent' }), item('Resin', 3, { unit: 'Litre' })] });
  assert.equal(r.status, 200, JSON.stringify(r)); assert.equal(r.edit_count, 1);
  assert.deepEqual(await names(id), ['Wax:9', 'Resin:3'], 'the items are replaced as a whole'); const s = await row(id); assert.equal(s.production_head, 'Head Two'); assert.equal(s.status, 'pending'); assert.equal(s.edit_count, 1); assert.ok(s.edited_at);
  const d1 = await api(tok.prodA, 'GET', '/api/production-indent/' + id); assert.equal(d1.items[0].priority, 'urgent'); assert.equal(String(d1.items[0].required_by).slice(0, 10), '2027-01-15');
  const log = (await pool.query("SELECT summary, before_data, after_data FROM audit_log WHERE action = 'indent.edit' AND entity_id = $1", [id])).rows[0];
  assert.deepEqual(log.before_data.items.map(x => x.item_name), ['Wax', 'Cloth']); assert.deepEqual(log.after_data.items.map(x => x.item_name), ['Wax', 'Resin']); assert.equal(log.before_data.production_head, 'Head One');
});

test('nobody else may change it: not another requester, not the approver, not an administrator or the Manager', async () => {
  const id = await raise(tok.prodA); const before = await names(id);
  for (const t of ['prodB', 'store', 'admin', 'manager']) {
    const r = await edit(tok[t], id, { production_head: 'Hacker', items: [item('Stolen', 1)] });
    assert.ok([403].includes(r.status), `${t}: ${r.status} ${r.error}`);
  }
  assert.equal((await edit(null, id, { production_head: 'x', items: [item('y')] })).status, 401);
  for (const t of ['prodB', 'store', 'admin']) assert.equal((await api(tok[t], 'GET', '/api/production-indent/' + id)).can_edit, false, t + ' is not offered the edit button');
  assert.deepEqual(await names(id), before); assert.equal((await row(id)).production_head, 'Head One'); assert.equal((await row(id)).edit_count, 0);
});

test('once it is approved it can no longer be changed, even by the requester', async () => {
  const id = await raise(tok.prodA); const before = await names(id);
  assert.equal((await api(tok.store, 'PUT', `/api/production-indent/${id}/approve`, { version: 0 })).status, 200);
  const r = await edit(tok.prodA, id, { production_head: 'Late change', version: 0, items: [item('Different', 99)] }); assert.equal(r.status, 409); assert.match(r.error, /already "approved"/);
  assert.deepEqual(await names(id), before); assert.equal((await row(id)).production_head, 'Head One');
  assert.equal((await api(tok.prodA, 'GET', '/api/production-indent/' + id)).can_edit, false, 'the edit button goes away');
  const raisedAndGone = await edit(tok.prodA, 987654321, { production_head: 'x', items: [item('y')] }); assert.equal(raisedAndGone.status, 404);
});

test('the same checks as when raising: a bad change is refused and nothing is saved', async () => {
  const id = await raise(tok.prodA); const before = await names(id);
  const bad = async (body, re) => { const r = await edit(tok.prodA, id, { production_head: 'H', version: 0, items: [item('Ok')], ...body }); assert.equal(r.status, 400, JSON.stringify(body)); assert.match(r.error, re); };
  await bad({ production_head: '' }, /Production head/); await bad({ items: [] }, /at least one/); await bad({ items: [item('')] }, /name is required/); await bad({ items: [item('x', 0)] }, /greater than 0/);
  await bad({ items: [item('x', 1, { unit: '' })] }, /unit is required/); await bad({ items: [item('x', 1, { required_by: '2027-02-31' })] }, /date is invalid/); await bad({ items: [item('x', 1, { priority: 'asap' })] }, /priority/);
  await bad({ items: [item('x', 1, { material_id: 987654321 })] }, /no longer in the list/);
  assert.deepEqual(await names(id), before); assert.equal((await row(id)).edit_count, 0);
});

test('a chosen raw material brings its list name, as when raising', async () => {
  const m = (await pool.query("SELECT id, name FROM raw_materials WHERE active ORDER BY id LIMIT 1")).rows[0];
  const id = await raise(tok.prodA); const r = await edit(tok.prodA, id, { production_head: 'H', version: 0, items: [item('typed differently', 4, { material_id: m.id })] }); assert.equal(r.status, 200);
  assert.deepEqual(await names(id), [`${m.name}:4`]);
});

test('a stale screen cannot overwrite a newer change (version check)', async () => {
  const id = await raise(tok.prodA);
  assert.equal((await edit(tok.prodA, id, { production_head: 'First', version: 0, items: [item('A', 1)] })).status, 200);
  const stale = await edit(tok.prodA, id, { production_head: 'Second', version: 0, items: [item('B', 2)] }); assert.equal(stale.status, 409); assert.match(stale.error, /changed since you opened it/);
  assert.deepEqual(await names(id), ['A:1']); assert.equal((await edit(tok.prodA, id, { production_head: 'Second', version: 1, items: [item('B', 2)] })).status, 200);
});

test('the approver approves the version they saw: a change made after they opened it must be looked at first', async () => {
  const id = await raise(tok.prodA);
  assert.equal((await edit(tok.prodA, id, { production_head: 'H', version: 0, items: [item('Changed', 7)] })).status, 200);
  const stale = await api(tok.store, 'PUT', `/api/production-indent/${id}/approve`, { version: 0 }); assert.equal(stale.status, 409); assert.match(stale.error, /changed it after you opened it/);
  assert.equal((await row(id)).status, 'pending', 'not approved');
  assert.equal((await api(tok.store, 'PUT', `/api/production-indent/${id}/approve`, { version: 1 })).status, 200);
  assert.equal((await row(id)).status, 'approved');
  const old = await raise(tok.prodA); assert.equal((await api(tok.store, 'PUT', `/api/production-indent/${old}/approve`, {})).status, 200, 'approving without a version still works (older screens)');
});

test('an edit and an approval at the same moment: only one wins, and the approved version is always the one the approver saw', async () => {
  for (let n = 0; n < 6; n++) {
    const id = await raise(tok.prodA, [item('Original', 1)]);
    const [e, a] = await Promise.all([edit(tok.prodA, id, { production_head: 'H', version: 0, items: [item('Edited', 2)] }), api(tok.store, 'PUT', `/api/production-indent/${id}/approve`, { version: 0 })]);
    assert.ok(!(e.status === 200 && a.status === 200), `both succeeded: edit ${e.status}, approve ${a.status}`);
    const s = await row(id), items = await names(id);
    if (s.status === 'approved') assert.deepEqual(items, ['Original:1'], 'approved content = what the approver saw'); else assert.deepEqual(items, ['Edited:2']);
  }
});
