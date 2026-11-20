// Raw material list: the import (migration 031), the type-and-choose search, and orders that carry a chosen material.
//   node --test tests/materials.test.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { pool } = require('../database');
const { createSession } = require('../auth');
const { runMigrations, STEPS } = require('../migrate');
const { DEFAULTS } = require('../permissions');
const M = require('../materials');

const LIST = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'database', 'raw-materials-sher.json'), 'utf8'));
const PORT = 3290, BASE = `http://localhost:${PORT}`, TAG = 'zzm' + crypto.randomBytes(3).toString('hex');
const made = { users: [], pos: [], indents: [], suppliers: [] }; const tok = {}; let server;
async function api(token, method, url, body) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await res.json(); } catch (e) {} return { ...j, status: res.status };      // the HTTP status wins over a "status" field in the body
}
async function mkUser(role) {
  const hash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 4);
  const r = await pool.query('INSERT INTO users (username, password_hash, name, role) VALUES ($1,$2,$3,$4) RETURNING id', [`${TAG}_${role}`, hash, `Test ${role}`, role]);
  made.users.push(r.rows[0].id); await pool.query('INSERT INTO user_roles (user_id, role) VALUES ($1,$2)', [r.rows[0].id, role]); return createSession(r.rows[0].id);
}
const byCode = async (code) => (await pool.query('SELECT * FROM raw_materials WHERE code = $1', [code])).rows[0];
const names = (r) => r.materials.map(m => m.name);

test.before(async () => {
  await runMigrations();
  server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), NOTIFY_TEST_MODE: '1' }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch (e) {} await new Promise(r => setTimeout(r, 250)); }
  tok.admin = await mkUser('admin'); tok.purchase = await mkUser('purchase'); tok.production = await mkUser('production');
  made.suppliers.push((await pool.query("INSERT INTO suppliers (name) VALUES ($1) RETURNING id", [TAG + ' supplier'])).rows[0].id);
});
test.after(async () => {
  try {
    await pool.query('DELETE FROM purchase_orders WHERE id = ANY($1)', [made.pos.length ? made.pos : [0]]);
    await pool.query('DELETE FROM production_indents WHERE id = ANY($1)', [made.indents.length ? made.indents : [0]]);
    await pool.query('DELETE FROM suppliers WHERE id = ANY($1)', [made.suppliers.length ? made.suppliers : [0]]);
    await pool.query('DELETE FROM audit_log WHERE actor_id = ANY($1)', [made.users.length ? made.users : [0]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users.length ? made.users : [0]]);
  } finally { server && server.kill(); await pool.end(); }
});

test('the list file is the billing software list: 241 items, no repeated code, every name filled', () => {
  assert.equal(LIST.length, 241); assert.equal(new Set(LIST.map(m => m.code)).size, 241); assert.ok(LIST.every(m => m.name && m.code));
  assert.ok(LIST.every(m => ['', 'Kg', 'Litre', 'Nos', 'Box'].includes(m.unit)), 'units are the app\'s own words');
  assert.equal(LIST.filter(m => !m.unit).length, 70, 'the billing list gives no unit for 70 items and none is guessed');
});

test('import: every item is in the list; materials already in the app keep their name, unit and category', async () => {
  const all = (await pool.query('SELECT code FROM raw_materials')).rows.map(r => r.code);
  for (const m of LIST) assert.ok(all.includes(m.code), m.code + ' is missing');
  const glycerine = await byCode('356'); assert.equal(glycerine.name, 'REFINED GLYCERINE CP'); assert.equal(glycerine.unit, 'Kg'); assert.equal(glycerine.hsn_code, '29054500', 'an empty HSN code is filled in');
  const oxalic = await byCode('365'); assert.equal(oxalic.unit, 'Kg', 'the billing list says Box, but the unit the recipes use is not changed');
  const used = await pool.query('SELECT COUNT(*)::int AS n FROM bom_lines'); assert.ok(used.rows[0].n > 0, 'recipes are intact');
});

test('import: new materials come with the unit, HSN code and GST rate from the list; a missing unit stays empty', async () => {
  const alphox = await byCode('R003'); assert.equal(alphox.name, 'ALPHOX 200 (EMULSIFIER)'); assert.equal(alphox.unit, 'Kg'); assert.equal(alphox.hsn_code, '34021300'); assert.equal(Number(alphox.gst_rate), 18); assert.equal(alphox.category, 'Raw material'); assert.equal(alphox.active, true);
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'database', 'bom-seed.json'), 'utf8')).materials.map(x => x.code);
  const blank = LIST.find(m => !m.unit && !seed.includes(m.code)); assert.ok(blank, 'a new item with no unit in the list');
  assert.equal((await byCode(blank.code)).unit, '', 'nothing was guessed');
  const expected = LIST.filter(m => !m.unit && !seed.includes(m.code)).map(m => m.code); const got = (await pool.query("SELECT code FROM raw_materials WHERE unit = '' AND code = ANY($1)", [expected])).rows.length; assert.equal(got, expected.length, 'every unit-less new item is present with an empty unit');
});

test('import: running it again changes nothing, and never undoes an administrator\'s edit', async () => {
  const step = STEPS.find(s => s.name === '031_raw_material_list'); assert.ok(step);
  const before = (await pool.query('SELECT COUNT(*)::int AS n FROM raw_materials')).rows[0].n;
  const m = await byCode('R004'); await pool.query("UPDATE raw_materials SET name = $1, unit = 'Litre' WHERE id = $2", [TAG + ' renamed', m.id]);
  try {
    const c = await pool.connect(); try { await step.run(c); await step.run(c); } finally { c.release(); }
    const after = await byCode('R004'); assert.equal(after.name, TAG + ' renamed'); assert.equal(after.unit, 'Litre');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM raw_materials')).rows[0].n, before);
  } finally { await pool.query('UPDATE raw_materials SET name = $1, unit = $2 WHERE id = $3', [m.name, m.unit, m.id]); }
});

test('search: type a few letters, get suggestions; a code or a full name comes first; several words all have to match', async () => {
  let r = await api(tok.purchase, 'GET', '/api/catalog/materials/search?q=glyc'); assert.equal(r.status, 200); assert.ok(names(r).includes('REFINED GLYCERINE CP'));
  r = await api(tok.purchase, 'GET', '/api/catalog/materials/search?q=R003'); assert.equal(r.materials[0].name, 'ALPHOX 200 (EMULSIFIER)'); assert.equal(r.materials[0].matched_via, 'code');
  r = await api(tok.purchase, 'GET', '/api/catalog/materials/search?q=silicon%20fluid'); assert.ok(r.materials.length >= 1 && r.materials.every(m => /silicon/i.test(m.name) && /fluid/i.test(m.name)));
  r = await api(tok.purchase, 'GET', '/api/catalog/materials/search?q=alphox%20200'); assert.equal(r.materials[0].code, 'R003');
  r = await api(tok.purchase, 'GET', '/api/catalog/materials/search?q=zzzzqqq'); assert.deepEqual(r.materials, []);
  const m = r; assert.equal(m.success, true);
  r = await api(tok.purchase, 'GET', '/api/catalog/materials/search?q=glyc'); assert.deepEqual(Object.keys(r.materials[0]).sort(), ['code', 'gst_rate', 'hsn_code', 'id', 'matched_via', 'name', 'unit']);
});
test('search: with nothing typed the first ten are listed; the number is capped; switched-off materials are never offered', async () => {
  let r = await api(tok.purchase, 'GET', '/api/catalog/materials/search'); assert.equal(r.materials.length, 10);
  assert.deepEqual(names(r), [...names(r)].sort((a, b) => a.localeCompare(b)), 'alphabetical');
  r = await api(tok.purchase, 'GET', '/api/catalog/materials/search?limit=500'); assert.equal(r.materials.length, 20);
  r = await api(tok.purchase, 'GET', '/api/catalog/materials/search?q=' + 'x'.repeat(500)); assert.equal(r.status, 200);
  const g = await byCode('R003'); await pool.query('UPDATE raw_materials SET active = false WHERE id = $1', [g.id]);
  try { r = await api(tok.purchase, 'GET', '/api/catalog/materials/search?q=alphox'); assert.ok(!r.materials.some(x => x.id === g.id)); }
  finally { await pool.query('UPDATE raw_materials SET active = true WHERE id = $1', [g.id]); }
});
test('search: needs a sign-in and one of: catalogue access, purchase order or production request rights', async () => {
  assert.equal((await api(null, 'GET', '/api/catalog/materials/search?q=a')).status, 401);
  for (const t of ['production', 'admin']) assert.equal((await api(tok[t], 'GET', '/api/catalog/materials/search?q=a')).status, 200, t);
  const none = Object.keys(DEFAULTS).filter(r => !['catalog.view', 'po.create', 'production_indent.create'].some(k => DEFAULTS[r].includes(k)));
  for (const role of none.slice(0, 1)) { const t = await mkUser(role); assert.equal((await api(t, 'GET', '/api/catalog/materials/search?q=a')).status, 403, role); }
});

const po = (items) => api(tok.purchase, 'POST', '/api/po/create', { supplier_id: made.suppliers[0], items });
test('purchase order: a chosen material brings its list name and HSN code; typed text still works; a bad choice is refused', async () => {
  const g = await byCode('R003');
  const a = await po([{ item_name: 'alphox 200 typed badly', material_id: g.id, quantity: 5, unit: 'Kg', rate: 100 }, { item_name: 'Something not on the list', quantity: 1, unit: 'Nos', rate: 50 }]);
  assert.equal(a.status, 201, JSON.stringify(a)); made.pos.push(a.po_id || (await pool.query('SELECT id FROM purchase_orders WHERE po_number = $1', [a.po_number])).rows[0].id);
  const rows = (await pool.query('SELECT i.item_name, i.hsn_code, i.unit FROM po_items i JOIN purchase_orders p ON p.id = i.po_id WHERE p.po_number = $1 ORDER BY i.id', [a.po_number])).rows;
  assert.equal(rows[0].item_name, 'ALPHOX 200 (EMULSIFIER)'); assert.equal(rows[0].hsn_code, '34021300'); assert.equal(rows[0].unit, 'Kg');
  assert.equal(rows[1].item_name, 'Something not on the list'); assert.equal(rows[1].hsn_code, null);
  const bad = await po([{ item_name: 'x', material_id: 987654321, quantity: 1, unit: 'Kg', rate: 1 }]); assert.equal(bad.status, 400); assert.match(bad.error, /Item 1: that raw material is no longer in the list/);
  const junk = await po([{ item_name: 'x', material_id: 'abc', quantity: 1, unit: 'Kg', rate: 1 }]); assert.equal(junk.status, 400); assert.match(junk.error, /not valid/);
  await pool.query('UPDATE raw_materials SET active = false WHERE id = $1', [g.id]);
  try { assert.equal((await po([{ item_name: 'x', material_id: g.id, quantity: 1, unit: 'Kg', rate: 1 }])).status, 400, 'a switched-off material cannot be ordered'); }
  finally { await pool.query('UPDATE raw_materials SET active = true WHERE id = $1', [g.id]); }
  const before = (await pool.query('SELECT COUNT(*)::int AS n FROM purchase_orders')).rows[0].n;
  assert.equal((await po([{ item_name: 'y', material_id: 987654321, quantity: 1, unit: 'Kg', rate: 1 }])).status, 400);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM purchase_orders')).rows[0].n, before, 'nothing was saved');
});
test('production request: a chosen material brings its list name', async () => {
  const g = await byCode('R004');
  const r = await api(tok.production, 'POST', '/api/production-indent/create', { production_head: 'Test', items: [{ item_name: 'peg four hundred', material_id: g.id, quantity: 20, unit: 'Kg' }, { item_name: 'Free text chemical', quantity: 1, unit: 'Kg' }] });
  assert.equal(r.status, 201, JSON.stringify(r)); made.indents.push(r.indent_id);
  const rows = (await pool.query('SELECT item_name FROM production_indent_items WHERE indent_id = $1 ORDER BY id', [r.indent_id])).rows.map(x => x.item_name);
  assert.deepEqual(rows, [g.name, 'Free text chemical']);
  assert.equal((await api(tok.production, 'POST', '/api/production-indent/create', { production_head: 'Test', items: [{ item_name: 'x', material_id: 987654321, quantity: 1, unit: 'Kg' }] })).status, 400);
});
test('rules: material ids are checked on their own', async () => {
  assert.equal(M.idOf('12'), 12); assert.equal(M.idOf('0'), null); assert.equal(M.idOf('-1'), null); assert.equal(M.idOf('1.5'), null); assert.equal(M.idOf('abc'), null);
  assert.deepEqual((await M.resolveMaterials(pool, [{ item_name: 'free text' }, { material_id: '' }, { material_id: null }])).map.size, 0);
});
