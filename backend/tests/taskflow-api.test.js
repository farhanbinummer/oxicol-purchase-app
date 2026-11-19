// TaskFlow summary through the real server and database (permissions and dashboard flag only: the fake settings below are never
// used to reach the network because the only call that would, by the Manager, is made against the server that has them switched off).
//   node --test tests/taskflow-api.test.js
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

const ON = 3294, OFF = 3293, TAG = 'zzf' + crypto.randomBytes(3).toString('hex');
const made = []; const tok = {}; const servers = [];
const FAKE = { TASKFLOW_FIREBASE_API_KEY: 'fake-key-for-test', TASKFLOW_DATABASE_URL: 'https://fake-unused.example.invalid', TASKFLOW_READER_EMAIL: 'reader@example.invalid', TASKFLOW_READER_PASSWORD: 'fake-password-for-test' };
const CLEAR = { TASKFLOW_FIREBASE_API_KEY: '', TASKFLOW_DATABASE_URL: '', TASKFLOW_READER_EMAIL: '', TASKFLOW_READER_PASSWORD: '' };

async function api(port, token, url) {
  const res = await fetch(`http://localhost:${port}${url}`, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  let json = {}; try { json = await res.json(); } catch (e) {} return { status: res.status, ...json };
}
async function mkUser(label, roles) {
  const hash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 4);
  const r = await pool.query('INSERT INTO users (username, password_hash, name, role, branch) VALUES ($1,$2,$3,$4,$5) RETURNING id', [`${TAG}_${label}`, hash, `Test ${label}`, primaryRole(roles), roles.includes('branch') ? 'Kannur' : null]);
  made.push(r.rows[0].id); for (const role of roles) await pool.query('INSERT INTO user_roles (user_id, role) VALUES ($1,$2)', [r.rows[0].id, role]);
  if (roles.includes('branch')) await pool.query("INSERT INTO user_scopes (user_id, role, scope_type, scope_value) VALUES ($1,'branch','branch','Kannur')", [r.rows[0].id]);
  return createSession(r.rows[0].id);
}
async function start(port, extra) {
  const s = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(port), NOTIFY_TEST_MODE: '1', ...extra }, stdio: 'ignore' }); servers.push(s);
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://localhost:${port}/api/health`)).ok) break; } catch (e) {} await new Promise(r => setTimeout(r, 250)); }
}
test.before(async () => {
  await runMigrations();
  await start(ON, FAKE); await start(OFF, CLEAR);
  tok.admin = await mkUser('admin', ['admin']); tok.manager = await mkUser('manager', ['manager']);
  for (const r of ['rd', 'branch', 'purchase', 'qc']) tok[r] = await mkUser(r, [r]);
});
test.after(async () => {
  try { await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.length ? made : [0]]); } finally { servers.forEach(s => s.kill()); await pool.end(); }
});

test('task summary: the permission is seeded for the Manager only', async () => {
  const r = await pool.query("SELECT role FROM role_permissions WHERE permission_key = 'tasks.summary_view'");
  assert.deepEqual(r.rows.map(x => x.role), ['manager']);
});
test('task summary: only people holding the permission may ask (the Manager and administrators)', async () => {
  for (const who of ['rd', 'branch', 'purchase', 'qc']) assert.equal((await api(ON, tok[who], '/api/workspace/task-summary')).status, 403, who);
  assert.equal((await api(ON, null, '/api/workspace/task-summary')).status, 401);
});
test('task summary: switched off (any setting missing) the Manager and administrator get "enabled: false" and no card', async () => {
  for (const who of ['manager', 'admin']) { const r = await api(OFF, tok[who], '/api/workspace/task-summary'); assert.equal(r.status, 200); assert.equal(r.enabled, false); assert.equal(r.overdue, undefined); }
  for (const [who, ws] of [['manager', 'manager'], ['admin', 'admin']]) assert.equal((await api(OFF, tok[who], `/api/workspace/${ws}/dashboard`)).task_summary_available, false);
});
test('task summary: when switched on, the dashboard says the card is available to the Manager and administrator only', async () => {
  assert.equal((await api(ON, tok.manager, '/api/workspace/manager/dashboard')).task_summary_available, true);
  assert.equal((await api(ON, tok.admin, '/api/workspace/admin/dashboard')).task_summary_available, true);
  assert.equal((await api(ON, tok.admin, '/api/workspace/manager/dashboard')).task_summary_available, true);
  for (const who of ['purchase', 'qc', 'rd', 'branch']) {
    const me = await api(ON, tok[who], '/api/workspace/me'); const ws = me.active || me.workspaces[0].id;
    const d = await api(ON, tok[who], `/api/workspace/${ws}/dashboard`);
    assert.equal(d.task_summary_available, false, who);
  }
});
test('task summary: the dashboard itself never waits for TaskFlow and carries no task numbers', async () => {
  const t0 = Date.now(); const d = await api(ON, tok.manager, '/api/workspace/manager/dashboard');
  assert.ok(Date.now() - t0 < 3000); assert.equal(d.success, true);
  assert.ok(!JSON.stringify(d).includes('top_overdue'));
});
