// Administrator "remove data" tests: a real server on its own port. Everything created is removed afterwards.
//   node --test tests/admin-data.test.js
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
const R = require('../rd-logic');

const PORT = 3297, BASE = `http://localhost:${PORT}`;
const TAG = 'zzd' + crypto.randomBytes(3).toString('hex');
const SECRET = 'SECRETFORMULA-' + TAG;
const made = { users: [], projects: [] };
let server; const tok = {}, uid = {};
const period = R.periodOf(R.todayIST()); let counterBefore;
const today = R.todayIST();

async function api(token, method, url, body) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = {}; try { json = await res.json(); } catch (e) {}
  return { status: res.status, ...json };
}
async function mkUser(label, roles) {
  const hash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 4);
  const r = await pool.query('INSERT INTO users (username, password_hash, name, role) VALUES ($1,$2,$3,$4) RETURNING id', [`${TAG}_${label}`, hash, `Test ${label}`, primaryRole(roles)]);
  made.users.push(r.rows[0].id); uid[label] = r.rows[0].id;
  for (const role of roles) await pool.query('INSERT INTO user_roles (user_id, role) VALUES ($1,$2)', [r.rows[0].id, role]);
  return createSession(r.rows[0].id);
}
const valid = () => ({ title: `${TAG} project`, project_type: R.PROJECT_TYPES[0], department: 'R&D Internal', priority: 'High', product_category: R.PRODUCT_CATEGORIES[0],
  base_system: 'Solvent-based', description: 'A test coating', target_tbc: true, requirements: R.DEFAULT_PERFORMANCE_ROWS.map(p => ({ parameter: p })), submit: true });
async function newProject() { const r = await api(tok.admin, 'POST', '/api/rd/projects', valid()); assert.equal(r.success, true, JSON.stringify(r)); made.projects.push(r.id); return r.id; }
async function fullProject() {
  const pid = await newProject();
  const reqs = (await api(tok.admin, 'GET', `/api/rd/projects/${pid}/trials`)).requirements;
  const t = await api(tok.admin, 'POST', `/api/rd/projects/${pid}/trials`, { trial_date: today, stage_no: 2, formula_ref: 'F-' + SECRET, changed_variables: 'x ' + SECRET, observations: 'o ' + SECRET, outcome: 'Needs another trial', results: reqs.map(q => ({ requirement_id: q.id, result: 'Pass', measured_value: SECRET })) });
  assert.equal(t.status, 201, JSON.stringify(t));
  const k = await api(tok.admin, 'POST', `/api/rd/projects/${pid}/tasks`, { title: 'Task ' + TAG, assignee_id: uid.lead, due_date: today });
  assert.ok(k.success, JSON.stringify(k));
  return { pid, trialId: t.id, taskId: k.id };
}
const rowsLeft = async (pid) => {
  const out = {};
  for (const [t, col] of [['rd_stages', 'project_id'], ['rd_tasks', 'project_id'], ['rd_trials', 'project_id'], ['rd_requirements', 'project_id'], ['rd_updates', 'project_id'], ['rd_project_members', 'project_id'], ['rd_approvals', 'project_id']])
    out[t] = (await pool.query(`SELECT COUNT(*)::int AS n FROM ${t} WHERE ${col} = $1`, [pid])).rows[0].n;
  return out;
};

test.before(async () => {
  await runMigrations();
  const c = await pool.query('SELECT last_serial FROM rd_number_counters WHERE period = $1', [period]);
  counterBefore = c.rowCount ? c.rows[0].last_serial : null;
  server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), NOTIFY_TEST_MODE: '1' }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch (e) {} await new Promise(r => setTimeout(r, 250)); }
  tok.admin = await mkUser('admin', ['admin']);
  tok.lead = await mkUser('lead', ['rd']);
  tok.manager = await mkUser('manager', ['manager']);
});
test.after(async () => {
  try {
    await pool.query('DELETE FROM rd_projects WHERE id = ANY($1)', [made.projects.length ? made.projects : [0]]);
    await pool.query('DELETE FROM rd_projects WHERE created_by = ANY($1)', [made.users.length ? made.users : [0]]);
    await pool.query('DELETE FROM rd_absences WHERE user_id = ANY($1)', [made.users.length ? made.users : [0]]);
    await pool.query("DELETE FROM notice_log WHERE subject LIKE $1", [TAG + '%']);
    if (counterBefore === null) await pool.query('DELETE FROM rd_number_counters WHERE period = $1', [period]);
    else await pool.query('UPDATE rd_number_counters SET last_serial = $1 WHERE period = $2', [counterBefore, period]);
    await pool.query('DELETE FROM audit_log WHERE actor_id = ANY($1)', [made.users.length ? made.users : [0]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users.length ? made.users : [0]]);
  } finally { server && server.kill(); await pool.end(); }
});

test('remove data: only an administrator may use any of it', async () => {
  const pid = await newProject();
  for (const token of [tok.lead, tok.manager, null]) {
    const want = token ? 403 : 401;
    assert.equal((await api(token, 'GET', '/api/admin/data/projects')).status, want);
    assert.equal((await api(token, 'GET', `/api/admin/data/projects/${pid}/preview`)).status, want);
    assert.equal((await api(token, 'POST', '/api/admin/data/projects/delete', { ids: [pid], confirm: 'DELETE', reason: 'testing it' })).status, want);
    assert.equal((await api(token, 'POST', '/api/admin/data/tasks/1/delete', { reason: 'testing it' })).status, want);
    assert.equal((await api(token, 'POST', '/api/admin/data/trials/1/delete', { reason: 'testing it' })).status, want);
    assert.equal((await api(token, 'POST', '/api/admin/data/absences/1/delete', { reason: 'testing it' })).status, want);
    assert.equal((await api(token, 'POST', '/api/admin/data/notice-log/clear', { older_than_days: 90 })).status, want);
  }
  assert.equal((await pool.query('SELECT 1 FROM rd_projects WHERE id = $1', [pid])).rowCount, 1, 'nothing was removed');
  const d = await api(tok.lead, 'GET', `/api/rd/projects/${pid}`); assert.ok(!d.can || d.can.delete_data === false, 'the project page does not offer removal to others');
  assert.equal((await api(tok.admin, 'GET', `/api/rd/projects/${pid}`)).can.delete_data, true);
});

test('remove data: list and preview show what hangs under a project', async () => {
  const { pid } = await fullProject();
  const l = await api(tok.admin, 'GET', '/api/admin/data/projects?q=' + TAG);
  const row = l.projects.find(p => p.id === pid); assert.ok(row);
  assert.ok(row.counts.stages > 0 && row.counts.tasks >= 1 && row.counts.trials === 1, JSON.stringify(row.counts));
  const pv = await api(tok.admin, 'GET', `/api/admin/data/projects/${pid}/preview`);
  assert.equal(pv.confirm_text, pv.project.project_number); assert.equal(pv.counts.trials, 1);
  assert.equal((await api(tok.admin, 'GET', '/api/admin/data/projects/99999999/preview')).status, 404);
});

test('remove data: a wrong confirmation, no reason or a bad list is refused and nothing is removed', async () => {
  const pid = await newProject(); const num = (await api(tok.admin, 'GET', `/api/admin/data/projects/${pid}/preview`)).confirm_text;
  const bad = async (body, msg) => { const r = await api(tok.admin, 'POST', '/api/admin/data/projects/delete', body); assert.equal(r.status, 400, msg); };
  await bad({ ids: [pid], confirm: 'nope', reason: 'cleaning up' }, 'wrong confirm');
  await bad({ ids: [pid], confirm: '', reason: 'cleaning up' }, 'empty confirm');
  await bad({ ids: [pid], confirm: num, reason: '' }, 'no reason');
  await bad({ ids: [pid], confirm: num, reason: 'abc' }, 'short reason');
  await bad({ ids: [], confirm: num, reason: 'cleaning up' }, 'no ids');
  await bad({ ids: Array.from({ length: 51 }, (_, i) => i + 1), confirm: 'x', reason: 'cleaning up' }, 'too many');
  assert.equal((await api(tok.admin, 'POST', '/api/admin/data/projects/delete', { ids: [pid, 99999999], confirm: 'DELETE 2 PROJECTS', reason: 'cleaning up' })).status, 404);
  assert.equal((await pool.query('SELECT 1 FROM rd_projects WHERE id = $1', [pid])).rowCount, 1);
});

test('remove data: removing a project removes everything under it, audits it without confidential text, and does not roll back the number', async () => {
  const { pid, trialId } = await fullProject();
  const pv = await api(tok.admin, 'GET', `/api/admin/data/projects/${pid}/preview`);
  const before = (await pool.query('SELECT last_serial FROM rd_number_counters WHERE period = $1', [period])).rows[0].last_serial;
  const r = await api(tok.admin, 'POST', '/api/admin/data/projects/delete', { ids: [pid], confirm: pv.confirm_text, reason: 'test project made by mistake' });
  assert.equal(r.status, 200, JSON.stringify(r)); assert.equal(r.removed, 1);
  assert.equal((await pool.query('SELECT 1 FROM rd_projects WHERE id = $1', [pid])).rowCount, 0);
  assert.ok(Object.values(await rowsLeft(pid)).every(n => n === 0), JSON.stringify(await rowsLeft(pid)));
  assert.equal((await pool.query('SELECT 1 FROM rd_trial_results WHERE trial_id = $1', [trialId])).rowCount, 0);
  assert.equal((await api(tok.admin, 'GET', `/api/rd/projects/${pid}`)).status, 404);
  const a = (await pool.query("SELECT * FROM audit_log WHERE action = 'admin.rd_project_delete' AND entity_id = $1", [pid])).rows;
  assert.equal(a.length, 1); assert.equal(a[0].reason, 'test project made by mistake'); assert.equal(a[0].actor_id, uid.admin);
  assert.equal(a[0].before_data.counts.trials, 1); assert.equal(a[0].before_data.project_number, pv.confirm_text);
  assert.ok(!JSON.stringify(a[0]).includes(SECRET), 'no confidential text in the audit entry');
  const after = (await pool.query('SELECT last_serial FROM rd_number_counters WHERE period = $1', [period])).rows[0].last_serial;
  assert.equal(after, before, 'the project number is never given out again');
});

test('remove data: several projects at once need the "DELETE n PROJECTS" confirmation', async () => {
  const a = await newProject(), b = await newProject();
  assert.equal((await api(tok.admin, 'POST', '/api/admin/data/projects/delete', { ids: [a, b], confirm: 'DELETE', reason: 'cleaning up' })).status, 400);
  const r = await api(tok.admin, 'POST', '/api/admin/data/projects/delete', { ids: [a, b], confirm: 'DELETE 2 PROJECTS', reason: 'cleaning up' });
  assert.equal(r.removed, 2);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'admin.rd_project_delete' AND entity_id = ANY($1)", [[a, b]])).rows[0].n, 2);
});

test('remove data: one task or one trial can be removed; the rest of the project stays', async () => {
  const { pid, trialId, taskId } = await fullProject();
  await pool.query('UPDATE rd_trials SET task_id = $1 WHERE id = $2', [taskId, trialId]);
  assert.equal((await api(tok.admin, 'POST', `/api/admin/data/tasks/${taskId}/delete`, { reason: 'x' })).status, 400, 'reason needed');
  assert.equal((await api(tok.admin, 'POST', `/api/admin/data/tasks/${taskId}/delete`, { reason: 'duplicate task' })).status, 200);
  const t = (await pool.query('SELECT task_id FROM rd_trials WHERE id = $1', [trialId])).rows[0]; assert.equal(t.task_id, null, 'the trial stays, only its link is cleared');
  assert.equal((await api(tok.admin, 'POST', `/api/admin/data/tasks/${taskId}/delete`, { reason: 'duplicate task' })).status, 404);
  assert.equal((await api(tok.admin, 'POST', `/api/admin/data/trials/${trialId}/delete`, { reason: 'wrong project' })).status, 200);
  assert.equal((await pool.query('SELECT 1 FROM rd_trials WHERE id = $1', [trialId])).rowCount, 0);
  assert.equal((await pool.query('SELECT 1 FROM rd_projects WHERE id = $1', [pid])).rowCount, 1);
  const log = (await pool.query("SELECT action, reason, before_data FROM audit_log WHERE entity_id = ANY($1) AND action LIKE 'admin.rd_%_delete'", [[taskId, trialId]])).rows;
  assert.deepEqual(log.map(x => x.action).sort(), ['admin.rd_task_delete', 'admin.rd_trial_delete']);
  assert.ok(!JSON.stringify(log).includes(SECRET));
});

test('remove data: an absence record can be removed with a reason', async () => {
  const ab = (await pool.query("INSERT INTO rd_absences (user_id, from_date, to_date, created_by) VALUES ($1,$2,$2,$1) RETURNING id", [uid.lead, today])).rows[0].id;
  assert.equal((await api(tok.admin, 'POST', `/api/admin/data/absences/${ab}/delete`, {})).status, 400);
  assert.equal((await api(tok.admin, 'POST', `/api/admin/data/absences/${ab}/delete`, { reason: 'entered by mistake' })).status, 200);
  assert.equal((await pool.query('SELECT 1 FROM rd_absences WHERE id = $1', [ab])).rowCount, 0);
  assert.equal((await pool.query("SELECT 1 FROM audit_log WHERE action = 'admin.rd_absence_delete' AND entity_id = $1", [ab])).rowCount, 1);
});

test('remove data: old sent-notice records can be cleared; recent ones and the audit history stay', async () => {
  await pool.query("INSERT INTO notice_log (channel, kind, subject, status, at) VALUES ('email','morning',$1,'sent', NOW() - INTERVAL '400 days'), ('email','morning',$2,'sent', NOW())", [TAG + ' old', TAG + ' new']);
  assert.equal((await api(tok.admin, 'POST', '/api/admin/data/notice-log/clear', { older_than_days: 1 })).status, 400, 'too short');
  const auditBefore = (await pool.query('SELECT COUNT(*)::int AS n FROM audit_log')).rows[0].n;
  const r = await api(tok.admin, 'POST', '/api/admin/data/notice-log/clear', { older_than_days: 365 });
  assert.equal(r.status, 200); assert.ok(r.removed >= 1);
  const left = (await pool.query("SELECT subject FROM notice_log WHERE subject LIKE $1", [TAG + '%'])).rows.map(x => x.subject);
  assert.deepEqual(left, [TAG + ' new']);
  assert.ok((await pool.query('SELECT COUNT(*)::int AS n FROM audit_log')).rows[0].n >= auditBefore, 'audit history only grows');
});
