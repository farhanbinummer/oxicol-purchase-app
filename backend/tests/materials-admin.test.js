// The administrator's raw material screen: list, add, edit, switch off, give units. A real server on its own port.
//   node --test tests/materials-admin.test.js
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

const PORT = 3288, BASE = `http://localhost:${PORT}`, TAG = 'ZZA' + crypto.randomBytes(3).toString('hex').toUpperCase();
const made = { users: [], codes: [] }; const tok = {}; let server, seq = 0;
async function api(token, method, url, body) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await res.json(); } catch (e) {} return { ...j, status: res.status };
}
async function mkUser(role) {
  const hash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 4);
  const r = await pool.query('INSERT INTO users (username, password_hash, name, role) VALUES ($1,$2,$3,$4) RETURNING id', [`${TAG}_${role}`.toLowerCase(), hash, `Test ${role}`, primaryRole([role])]);
  made.users.push(r.rows[0].id); await pool.query('INSERT INTO user_roles (user_id, role) VALUES ($1,$2)', [r.rows[0].id, role]); return createSession(r.rows[0].id);
}
const row = async (code) => (await pool.query('SELECT * FROM raw_materials WHERE code = $1', [code])).rows[0];
/** A material straight in the table (unit '' = none yet). */
async function mk(unit = 'Kg', over = {}) {
  const code = `${TAG}-${++seq}`; made.codes.push(code);
  const r = await pool.query("INSERT INTO raw_materials (code, name, unit, category) VALUES ($1,$2,$3,'Raw material') RETURNING id", [code, over.name || `${TAG} material ${seq}`, unit]);
  return { id: r.rows[0].id, code, name: over.name || `${TAG} material ${seq}` };
}

test.before(async () => {
  await runMigrations();
  server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), NOTIFY_TEST_MODE: '1' }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch (e) {} await new Promise(r => setTimeout(r, 250)); }
  tok.admin = await mkUser('admin'); tok.manager = await mkUser('manager'); tok.purchase = await mkUser('purchase');
});
test.after(async () => {
  try {
    await pool.query('DELETE FROM raw_materials WHERE code = ANY($1)', [made.codes.length ? made.codes : ['']]);
    await pool.query('DELETE FROM audit_log WHERE actor_id = ANY($1)', [made.users.length ? made.users : [0]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users.length ? made.users : [0]]);
  } finally { server && server.kill(); await pool.end(); }
});

test('only an administrator may use any of it', async () => {
  const m = await mk();
  for (const token of [tok.manager, tok.purchase, null]) {
    const want = token ? 403 : 401;
    assert.equal((await api(token, 'GET', '/api/admin/materials')).status, want);
    assert.equal((await api(token, 'POST', '/api/admin/materials', { code: 'X', name: 'Y', unit: 'Kg' })).status, want);
    assert.equal((await api(token, 'PUT', '/api/admin/materials/' + m.id, { name: 'Hacked' })).status, want);
    assert.equal((await api(token, 'POST', '/api/admin/materials/set-unit', { ids: [m.id], unit: 'Kg' })).status, want);
  }
  assert.notEqual((await row(m.code)).name, 'Hacked');
});

test('the list can be searched and filtered, and says how many have no unit or are switched off', async () => {
  const a = await mk('', { name: `${TAG} needs a unit` }), b = await mk('Kg', { name: `${TAG} switched off one` });
  await pool.query('UPDATE raw_materials SET active = false WHERE id = $1', [b.id]);
  const codes = (r) => r.materials.map(x => x.code);
  const all = await api(tok.admin, 'GET', '/api/admin/materials?q=' + TAG); assert.ok(codes(all).includes(a.code) && codes(all).includes(b.code));
  assert.deepEqual(all.units, ['Kg', 'Litre', 'Nos', 'Box', 'Drum']);
  assert.ok(all.totals.total >= 241 && all.totals.no_unit >= 1 && all.totals.off >= 1);
  const nu = codes(await api(tok.admin, 'GET', `/api/admin/materials?filter=no_unit&q=${TAG}`)); assert.ok(nu.includes(a.code) && !nu.includes(b.code), 'only the ones with no unit');
  const off = codes(await api(tok.admin, 'GET', `/api/admin/materials?filter=off&q=${TAG}`)); assert.ok(off.includes(b.code) && !off.includes(a.code), 'only the switched-off ones');
  assert.equal((await api(tok.admin, 'GET', '/api/admin/materials?q=' + a.code)).materials[0].recipe_lines, 0);
});

test('editing: name, unit, category, HSN and GST are checked and saved, with an audit entry', async () => {
  const m = await mk('');
  const ok = await api(tok.admin, 'PUT', '/api/admin/materials/' + m.id, { name: `  ${TAG}   Renamed  `, unit: 'Litre', category: 'Packaging', hsn_code: '39100020', gst_rate: 18 }); assert.equal(ok.status, 200, JSON.stringify(ok));
  const r = await row(m.code); assert.equal(r.name, `${TAG} Renamed`, 'spaces tidied'); assert.equal(r.unit, 'Litre'); assert.equal(r.category, 'Packaging'); assert.equal(r.hsn_code, '39100020'); assert.equal(Number(r.gst_rate), 18); assert.equal(r.code, m.code, 'the code never changes');
  const log = (await pool.query("SELECT * FROM audit_log WHERE entity = 'material' AND entity_id = $1 ORDER BY id DESC LIMIT 1", [m.id])).rows[0]; assert.equal(log.actor_id, made.users[0]); assert.equal(log.before_data.unit, ''); assert.equal(log.after_data.unit, 'Litre');
  const bad = async (body, re) => { const x = await api(tok.admin, 'PUT', '/api/admin/materials/' + m.id, body); assert.equal(x.status, 400, JSON.stringify(body)); assert.match(x.error, re); };
  await bad({ name: '   ' }, /name cannot be empty/); await bad({ name: 'x'.repeat(201) }, /too long/); await bad({ unit: 'Furlong' }, /Choose a unit/); await bad({ unit: '' }, /Choose a unit/);
  await bad({ category: 'Food' }, /Category/); await bad({ hsn_code: '12' }, /HSN/); await bad({ hsn_code: 'ABCD' }, /HSN/); await bad({ gst_rate: 99 }, /between 0 and 40/); await bad({ gst_rate: 'abc' }, /between 0 and 40/); await bad({ active: 'no' }, /true or false/); await bad({}, /Nothing to change/);
  assert.equal((await api(tok.admin, 'PUT', '/api/admin/materials/' + m.id, { unit: 'Litre' })).status, 400, 'saving the same value is "nothing changed"');
  assert.equal((await api(tok.admin, 'PUT', '/api/admin/materials/' + m.id, { hsn_code: '', gst_rate: '' })).status, 200); const c = await row(m.code); assert.equal(c.hsn_code, null); assert.equal(c.gst_rate, null);
  assert.equal((await api(tok.admin, 'PUT', '/api/admin/materials/987654321', { name: 'x' })).status, 404); assert.equal((await api(tok.admin, 'PUT', '/api/admin/materials/abc', { name: 'x' })).status, 400);
});

test('a name cannot be used twice (capital letters do not matter)', async () => {
  const a = await mk('Kg', { name: `${TAG} Twin A` }), b = await mk('Kg', { name: `${TAG} Twin B` });
  const r = await api(tok.admin, 'PUT', '/api/admin/materials/' + b.id, { name: `${TAG} TWIN a` }); assert.equal(r.status, 409); assert.match(r.error, new RegExp(a.code));
  assert.equal((await api(tok.admin, 'PUT', '/api/admin/materials/' + a.id, { name: `${TAG} TWIN A` })).status, 200, 'changing the capitals of its own name is fine');
  const c = await api(tok.admin, 'POST', '/api/admin/materials', { code: `${TAG}-NEW1`, name: `${TAG} twin b`, unit: 'Kg' }); made.codes.push(`${TAG}-NEW1`); assert.equal(c.status, 409);
});

test('adding a material: code, name and unit are needed; the code must be new', async () => {
  const code = `${TAG}-ADD`; made.codes.push(code);
  const bad = async (b, re, st = 400) => { const x = await api(tok.admin, 'POST', '/api/admin/materials', b); assert.equal(x.status, st, JSON.stringify(b)); assert.match(x.error, re); };
  await bad({ name: 'x', unit: 'Kg' }, /code is required/); await bad({ code, unit: 'Kg' }, /name is required/); await bad({ code, name: 'x' }, /Choose a unit/); await bad({ code: 'c'.repeat(31), name: 'x', unit: 'Kg' }, /code is required/);
  const ok = await api(tok.admin, 'POST', '/api/admin/materials', { code, name: `${TAG} brand new`, unit: 'Drum', hsn_code: '3402', gst_rate: 18 }); assert.equal(ok.status, 201, JSON.stringify(ok));
  const r = await row(code); assert.equal(r.unit, 'Drum'); assert.equal(r.category, 'Raw material'); assert.equal(r.active, true); assert.equal(Number(r.gst_rate), 18);
  await bad({ code, name: `${TAG} another name`, unit: 'Kg' }, /code already exists/, 409);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'material.create' AND entity_id = $1", [ok.id])).rows[0].n, 1);
});

test('switching off hides a material from the type-and-choose search, keeps it in recipes, and can be undone', async () => {
  const m = await mk('Kg', { name: `${TAG} Searchable` });
  const find = async () => (await api(tok.purchase, 'GET', '/api/catalog/materials/search?q=' + TAG + '%20searchable')).materials.some(x => x.id === m.id);
  assert.equal(await find(), true);
  assert.equal((await api(tok.admin, 'PUT', '/api/admin/materials/' + m.id, { active: false })).status, 200); assert.equal(await find(), false);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'material.off' AND entity_id = $1", [m.id])).rows[0].n, 1);
  assert.equal((await api(tok.admin, 'PUT', '/api/admin/materials/' + m.id, { active: true })).status, 200); assert.equal(await find(), true);
});

test('a chosen unit shows up when people type: the unit is what the order form fills in', async () => {
  const m = await mk('', { name: `${TAG} Unitless` });
  const get = async () => (await api(tok.purchase, 'GET', '/api/catalog/materials/search?q=' + TAG + '%20unitless')).materials.find(x => x.id === m.id);
  assert.equal((await get()).unit, ''); await api(tok.admin, 'PUT', '/api/admin/materials/' + m.id, { unit: 'Kg' }); assert.equal((await get()).unit, 'Kg');
});

test('giving a unit to many at once only touches materials that have none, and says how many', async () => {
  const a = await mk(''), b = await mk(''), c = await mk('Nos');
  const r = await api(tok.admin, 'POST', '/api/admin/materials/set-unit', { ids: [a.id, b.id, c.id], unit: 'Kg' }); assert.equal(r.status, 200); assert.equal(r.changed, 2); assert.equal(r.skipped, 1);
  assert.equal((await row(a.code)).unit, 'Kg'); assert.equal((await row(b.code)).unit, 'Kg'); assert.equal((await row(c.code)).unit, 'Nos', 'an existing unit is never changed here');
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'material.update' AND entity_id = ANY($1)", [[a.id, b.id]])).rows[0].n, 2);
  assert.equal((await api(tok.admin, 'POST', '/api/admin/materials/set-unit', { ids: [a.id], unit: 'Furlong' })).status, 400);
  assert.equal((await api(tok.admin, 'POST', '/api/admin/materials/set-unit', { ids: [], unit: 'Kg' })).status, 400);
  assert.equal((await api(tok.admin, 'POST', '/api/admin/materials/set-unit', { ids: Array.from({ length: 101 }, (_, i) => i + 1), unit: 'Kg' })).status, 400);
});
