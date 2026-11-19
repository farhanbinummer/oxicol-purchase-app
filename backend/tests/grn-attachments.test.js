// Photos and files on goods receipts: a real server on its own port. Everything created is removed afterwards.
//   node --test tests/grn-attachments.test.js
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
const { DEFAULTS } = require('../permissions');

const PORT = 3292, BASE = `http://localhost:${PORT}`, TAG = 'zzg' + crypto.randomBytes(3).toString('hex');
const made = { users: [], grns: [], pos: [], suppliers: [] }; const tok = {}; let server;
const JPEG = (n = 2000) => Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46]), crypto.randomBytes(n)]);
const PNG = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), crypto.randomBytes(500)]);
const PDF = () => Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(500)]);
const holders = (k) => Object.entries(DEFAULTS).filter(([, keys]) => keys.includes(k)).map(([r]) => r);

async function jget(token, url) {
  const res = await fetch(BASE + url, { headers: token ? { Authorization: 'Bearer ' + token } : {} }); let j = {}; try { j = await res.json(); } catch (e) {} return { status: res.status, ...j };
}
async function jpost(token, url, body) {
  const res = await fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body || {}) }); let j = {}; try { j = await res.json(); } catch (e) {} return { status: res.status, ...j };
}
async function up(token, grn, buf, { type = 'image/jpeg', name = 'challan.jpg', kind, note } = {}) {
  const res = await fetch(`${BASE}/api/grn/${grn}/attachments`, { method: 'POST', headers: { 'Content-Type': type, 'X-File-Name': encodeURIComponent(name), ...(kind ? { 'X-File-Kind': kind } : {}), ...(note != null ? { 'X-File-Note': encodeURIComponent(note) } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: buf });
  let j = {}; try { j = await res.json(); } catch (e) {} return { status: res.status, ...j };
}
async function mkUser(role) {
  const hash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 4);
  const r = await pool.query('INSERT INTO users (username, password_hash, name, role) VALUES ($1,$2,$3,$4) RETURNING id', [`${TAG}_${role}`, hash, `Test ${role}`, role]);
  made.users.push(r.rows[0].id); return createSession(r.rows[0].id);
}
async function mkGrn() {
  const sup = made.suppliers[0], po = made.pos[0];
  const g = await pool.query("INSERT INTO grn_notes (grn_number, po_id, received_by, total_items) VALUES ($1,$2,'Test',1) RETURNING id", [`${TAG}-${made.grns.length + 1}`, po]);
  made.grns.push(g.rows[0].id); return g.rows[0].id;
}

test.before(async () => {
  await runMigrations();
  server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), NOTIFY_TEST_MODE: '1' }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch (e) {} await new Promise(r => setTimeout(r, 250)); }
  made.suppliers.push((await pool.query("INSERT INTO suppliers (name) VALUES ($1) RETURNING id", [TAG + ' supplier'])).rows[0].id);
  made.pos.push((await pool.query("INSERT INTO purchase_orders (po_number, supplier_id, subtotal, total_amount) VALUES ($1,$2,0,0) RETURNING id", [TAG + '-PO', made.suppliers[0]])).rows[0].id);
  tok.admin = await mkUser('admin'); tok.store = await mkUser('store'); tok.qc = await mkUser('qc'); tok.manager = await mkUser('manager'); tok.accounts = await mkUser('accounts');
});
test.after(async () => {
  try {
    await pool.query('DELETE FROM grn_notes WHERE id = ANY($1)', [made.grns.length ? made.grns : [0]]);              // its files go with it
    await pool.query('DELETE FROM purchase_orders WHERE id = ANY($1)', [made.pos.length ? made.pos : [0]]);
    await pool.query('DELETE FROM suppliers WHERE id = ANY($1)', [made.suppliers.length ? made.suppliers : [0]]);
    await pool.query('DELETE FROM audit_log WHERE actor_id = ANY($1)', [made.users.length ? made.users : [0]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users.length ? made.users : [0]]);
  } finally { server && server.kill(); await pool.end(); }
});

test('who may do what is decided by the existing receipt permissions (no new permission)', async () => {
  assert.ok(holders('grn.create').includes('store') && holders('grn.approve').includes('qc'));
  assert.ok(holders('grn.view').includes('manager') && !holders('grn.create').includes('manager') && !holders('grn.approve').includes('manager'), 'the Manager can see receipts but not change them');
  assert.equal((await pool.query("SELECT to_regclass('grn_attachments') AS t")).rows[0].t, 'grn_attachments');
});

test('a photo is stored, listed without its bytes, counted in the list, and served safely', async () => {
  const g = await mkGrn(); const buf = JPEG();
  const r = await up(tok.store, g, buf, { name: 'challan 12.jpg', kind: 'challan', note: 'Supplier delivery challan' });
  assert.equal(r.status, 201, JSON.stringify(r)); assert.equal(r.mime, 'image/jpeg'); assert.equal(r.kind, 'challan');
  const d = await jget(tok.manager, '/api/grn/' + g);
  assert.equal(d.attachments.length, 1); const a = d.attachments[0];
  assert.deepEqual(Object.keys(a).sort(), ['at', 'by', 'file_name', 'id', 'kind', 'mime', 'note', 'size_bytes']);
  assert.equal(a.file_name, 'challan 12.jpg'); assert.equal(a.note, 'Supplier delivery challan'); assert.equal(a.size_bytes, buf.length); assert.equal(a.by, 'Test store');
  assert.ok(!JSON.stringify(d).includes(buf.toString('base64').slice(10, 40)), 'the file bytes are never in the details');
  assert.equal(d.can_attach, false, 'the Manager may open files but not add them'); assert.equal((await jget(tok.store, '/api/grn/' + g)).can_attach, true);
  const list = await jget(tok.manager, '/api/grn'); assert.equal(list.grns.find(x => x.id === g).file_count, 1);
  const f = await fetch(`${BASE}/api/grn/${g}/attachments/${a.id}`, { headers: { Authorization: 'Bearer ' + tok.manager } });
  assert.equal(f.status, 200); assert.equal(f.headers.get('content-type'), 'image/jpeg'); assert.equal(f.headers.get('x-content-type-options'), 'nosniff');
  assert.match(f.headers.get('content-security-policy'), /sandbox/); assert.match(f.headers.get('cache-control'), /no-store/);
  assert.ok(Buffer.from(await f.arrayBuffer()).equals(buf), 'the exact file comes back');
});

test('PNG and PDF are accepted; a PDF is downloaded, not shown in the page', async () => {
  const g = await mkGrn();
  assert.equal((await up(tok.qc, g, PNG(), { type: 'image/png', name: 'damage.png', kind: 'damage' })).status, 201);
  const p = await up(tok.qc, g, PDF(), { type: 'application/pdf', name: 'invoice', kind: 'challan' }); assert.equal(p.status, 201); assert.equal(p.file_name, 'invoice.pdf');
  const d = await jget(tok.qc, '/api/grn/' + g); const pdf = d.attachments.find(x => x.mime === 'application/pdf');
  const f = await fetch(`${BASE}/api/grn/${g}/attachments/${pdf.id}`, { headers: { Authorization: 'Bearer ' + tok.qc } });
  assert.match(f.headers.get('content-disposition'), /^attachment;/);
});

test('the file itself decides what it is: names, headers and look-alikes are not trusted', async () => {
  const g = await mkGrn();
  const html = Buffer.from('<html><script>alert(1)</script></html>');
  assert.equal((await up(tok.store, g, html, { type: 'image/jpeg', name: 'x.jpg' })).status, 400, 'a web page labelled as a photo');
  assert.equal((await up(tok.store, g, Buffer.from('MZ' + 'x'.repeat(100)), { type: 'application/pdf', name: 'x.pdf' })).status, 400, 'a program labelled as a PDF');
  assert.equal((await up(tok.store, g, Buffer.alloc(0), {})).status, 400, 'empty');
  assert.equal((await up(tok.store, g, Buffer.from('hello world'), { type: 'text/plain', name: 'a.txt' })).status, 400, 'a type we do not accept');
  const r = await up(tok.store, g, JPEG(), { name: '../../etc/passwd<script>', kind: 'nonsense' });
  assert.equal(r.status, 201); assert.ok(!/[\\/<>]/.test(r.file_name), 'no folders or markup in the stored name: ' + r.file_name); assert.equal(r.kind, 'other', 'an unknown kind becomes "other"');
  const long = await up(tok.store, g, JPEG(), { name: 'n.jpg', note: 'x'.repeat(400) }); assert.equal(long.status, 201);
  const d = await jget(tok.store, '/api/grn/' + g); assert.ok(d.attachments.every(a => (a.note || '').length <= 150));
  assert.equal(d.attachments.length, 2, 'refused files were not stored');
});

test('a file over the size limit is refused', async () => {
  const g = await mkGrn(); const big = JPEG(5 * 1024 * 1024 + 10);
  const r = await up(tok.store, g, big, {}); assert.ok([400, 413].includes(r.status), 'status ' + r.status);
  assert.equal((await jget(tok.store, '/api/grn/' + g)).attachments.length, 0);
});

test('only people who record or decide receipts may add or remove; others who see receipts may open; the rest see nothing', async () => {
  const g = await mkGrn(); const a = await up(tok.store, g, JPEG(), {});
  assert.equal((await up(tok.manager, g, JPEG(), {})).status, 403, 'view-only cannot add');
  assert.equal((await jpost(tok.manager, `/api/grn/${g}/attachments/${a.id}/remove`, { reason: 'not allowed' })).status, 403);
  assert.equal((await up(null, g, JPEG(), {})).status, 401);
  const noView = ['accounts'].filter(r => !holders('grn.view').includes(r));
  for (const r of noView) { assert.equal((await up(tok[r], g, JPEG(), {})).status, 403, r); assert.equal((await jget(tok[r], `/api/grn/${g}/attachments/${a.id}`)).status, 403, r); }
  assert.equal((await jget(tok.manager, `/api/grn/${g}/attachments/${a.id}`)).status, 200);
  assert.equal((await up(tok.admin, g, JPEG(), {})).status, 201, 'an administrator may');
  assert.equal((await up(tok.store, 99999999, JPEG(), {})).status, 404, 'a receipt that does not exist');
});

test('a receipt keeps at most ten files, even when many are sent at the same moment', async () => {
  const g = await mkGrn();
  const rs = await Promise.all(Array.from({ length: 13 }, () => up(tok.store, g, JPEG(300), {})));
  assert.equal(rs.filter(r => r.status === 201).length, 10); assert.equal(rs.filter(r => r.status === 409).length, 3);
  assert.equal((await jget(tok.store, '/api/grn/' + g)).attachments.length, 10);
});

test('removing needs a reason, hides the file, keeps it in the database, and is audited', async () => {
  const g = await mkGrn(); const a = await up(tok.store, g, JPEG(), { name: 'wrong.jpg' });
  assert.equal((await jpost(tok.qc, `/api/grn/${g}/attachments/${a.id}/remove`, {})).status, 400);
  assert.equal((await jpost(tok.qc, `/api/grn/${g}/attachments/${a.id}/remove`, { reason: 'abc' })).status, 400);
  assert.equal((await jpost(tok.qc, `/api/grn/${g}/attachments/${a.id}/remove`, { reason: 'Photo of the wrong delivery' })).status, 200);
  assert.equal((await jget(tok.qc, '/api/grn/' + g)).attachments.length, 0);
  assert.equal((await jget(tok.qc, `/api/grn/${g}/attachments/${a.id}`)).status, 404);
  assert.equal((await jpost(tok.qc, `/api/grn/${g}/attachments/${a.id}/remove`, { reason: 'Photo of the wrong delivery' })).status, 404, 'already removed');
  const row = (await pool.query('SELECT removed_by_name, removed_reason, length(data) AS n FROM grn_attachments WHERE id = $1', [a.id])).rows[0];
  assert.equal(row.removed_by_name, 'Test qc'); assert.equal(row.removed_reason, 'Photo of the wrong delivery'); assert.ok(row.n > 0, 'the file is still stored');
  const log = (await pool.query("SELECT action, reason, summary, before_data, after_data FROM audit_log WHERE entity = 'grn' AND entity_id = $1 AND action LIKE 'grn.attach%' ORDER BY id", [g])).rows;
  assert.deepEqual(log.map(x => x.action), ['grn.attach', 'grn.attach_remove']); assert.equal(log[1].reason, 'Photo of the wrong delivery');
  assert.ok(JSON.stringify(log).length < 1500, 'the audit entry holds no file content');
  const free = await up(tok.store, g, JPEG(), {}); assert.equal(free.status, 201, 'a removed file frees its place');
});

test('a file is only reachable through its own receipt', async () => {
  const g1 = await mkGrn(), g2 = await mkGrn(); const a = await up(tok.store, g1, JPEG(), {});
  assert.equal((await jget(tok.store, `/api/grn/${g2}/attachments/${a.id}`)).status, 404);
  assert.equal((await jpost(tok.store, `/api/grn/${g2}/attachments/${a.id}/remove`, { reason: 'wrong receipt' })).status, 404);
  assert.equal((await jget(tok.store, `/api/grn/${g1}/attachments/${a.id}`)).status, 200);
  assert.equal((await jget(tok.store, `/api/grn/${g1}/attachments/abc`)).status, 400);
});

test('deleting a receipt removes its files with it', async () => {
  const g = await mkGrn(); await up(tok.store, g, JPEG(), {});
  await pool.query('DELETE FROM grn_notes WHERE id = $1', [g]); made.grns = made.grns.filter(x => x !== g);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM grn_attachments WHERE grn_id = $1', [g])).rows[0].n, 0);
});
