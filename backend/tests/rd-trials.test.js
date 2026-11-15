// Lab trial tests: a real server on its own port against the configured database. Everything created is removed afterwards.
//   node --test tests/rd-trials.test.js
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

const PORT = 3298, BASE = `http://localhost:${PORT}`;
const TAG = 'zzt' + crypto.randomBytes(3).toString('hex');
const SECRET = 'SECRETFORMULA-' + TAG;
const made = { users: [], projects: [] };
let server; const tok = {}, uid = {};
let counterBefore; const period = R.periodOf(R.todayIST());
const addedGrants = [];

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
const grant = async (role, key) => { const r = await pool.query('INSERT INTO role_permissions (role, permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1', [role, key]); if (r.rowCount) addedGrants.push([role, key]); };
const valid = () => ({
  title: `${TAG} project`, project_type: R.PROJECT_TYPES[0], department: 'R&D Internal', priority: 'High', product_category: R.PRODUCT_CATEGORIES[0],
  base_system: 'Solvent-based', description: 'A test coating', target_tbc: true, requirements: R.DEFAULT_PERFORMANCE_ROWS.map(p => ({ parameter: p })), submit: true
});
async function newProject() {
  const r = await api(tok.admin, 'POST', '/api/rd/projects', valid());
  assert.equal(r.success, true, JSON.stringify(r)); made.projects.push(r.id); return r.id;
}
const today = R.todayIST();
const trialBody = (reqs, over) => ({ trial_date: today, stage_no: 2, formula_ref: 'F-' + SECRET, changed_variables: 'solvent 40% to 35% ' + SECRET, batch_size_text: '500 g', observations: 'Viscosity 92 KU ' + SECRET, outcome: 'Needs another trial',
  results: reqs.map((q, i) => ({ requirement_id: q.id, result: i % 2 ? 'Fail' : 'Pass', measured_value: 'MV-' + SECRET })), ...(over || {}) });
const list = (token, pid) => api(token, 'GET', `/api/rd/projects/${pid}/trials`);

test.before(async () => {
  await runMigrations();
  await grant('rd_trainee', 'rd.trial_view');                  // lets a trainee who is NOT on the project try to open its trials
  await grant('rd', 'rd.create');
  const c = await pool.query('SELECT last_serial FROM rd_number_counters WHERE period = $1', [period]);
  counterBefore = c.rowCount ? c.rows[0].last_serial : null;
  server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), NOTIFY_TEST_MODE: '1' }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch (e) {} await new Promise(r => setTimeout(r, 250)); }
  tok.admin = await mkUser('admin', ['admin']);
  tok.lead = await mkUser('lead', ['rd']);
  tok.manager = await mkUser('manager', ['manager']);
  tok.qc = await mkUser('qc', ['qc']);
  tok.trainee = await mkUser('trainee', ['rd_trainee']);
});

test.after(async () => {
  try {
    for (const [role, key] of addedGrants) await pool.query('DELETE FROM role_permissions WHERE role = $1 AND permission_key = $2', [role, key]);
    await pool.query('DELETE FROM rd_projects WHERE id = ANY($1)', [made.projects.length ? made.projects : [0]]);        // trials, results and corrections cascade
    await pool.query('DELETE FROM rd_projects WHERE created_by = ANY($1)', [made.users.length ? made.users : [0]]);
    if (counterBefore === null) await pool.query('DELETE FROM rd_number_counters WHERE period = $1', [period]);
    else await pool.query('UPDATE rd_number_counters SET last_serial = $1 WHERE period = $2', [counterBefore, period]);
    await pool.query('DELETE FROM audit_log WHERE actor_id = ANY($1)', [made.users.length ? made.users : [0]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users.length ? made.users : [0]]);
  } finally { server && server.kill(); await pool.end(); }
});

test('trials: default grants (trial_edit to R&D only; trial_view to R&D and view_all holders)', async () => {
  const { DEFAULTS } = require('../permissions');
  const holders = (k) => Object.entries(DEFAULTS).filter(([, keys]) => keys.includes(k)).map(([r]) => r).sort();
  assert.deepEqual(holders('rd.trial_edit'), ['rd']);
  assert.deepEqual(holders('rd.trial_view'), ['manager', 'rd']);
  const db = await pool.query("SELECT role, permission_key FROM role_permissions WHERE permission_key IN ('rd.trial_edit','rd.trial_view') AND role = ANY($1)", [['rd', 'manager', 'qc', 'purchase']]);
  const has = (r, k) => db.rows.some(x => x.role === r && x.permission_key === k);
  assert.ok(has('rd', 'rd.trial_edit') && has('rd', 'rd.trial_view') && has('manager', 'rd.trial_view'));
  assert.ok(!has('manager', 'rd.trial_edit') && !has('qc', 'rd.trial_view') && !has('purchase', 'rd.trial_view'));
});

test('trials: trial numbers are unique and sequential under simultaneous inserts', async () => {
  const pid = await newProject(); const { requirements } = await list(tok.lead, pid);
  const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => api(tok.lead, 'POST', `/api/rd/projects/${pid}/trials`, trialBody(requirements, { formula_ref: 'F' + i }))));
  assert.ok(rs.every(r => r.status === 201), JSON.stringify(rs.map(r => r.status + ' ' + (r.error || ''))));
  assert.deepEqual(rs.map(r => r.trial_no).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
  assert.equal(rs.find(r => r.trial_no === 3).label, 'T3');
  assert.equal(new Set(rs.map(r => r.id)).size, 6);
});

test('trials: every problem is listed; dates, stage, outcome, results and cost are checked', async () => {
  const pid = await newProject(); const { requirements } = await list(tok.lead, pid);
  const empty = await api(tok.lead, 'POST', `/api/rd/projects/${pid}/trials`, {});
  assert.equal(empty.status, 400);
  const fields = empty.errors.map(e => e.field);
  for (const f of ['trial_date', 'stage_no', 'formula_ref', 'outcome']) assert.ok(fields.includes(f), 'lists ' + f);
  const bad = async (over, field) => { const r = await api(tok.admin, 'POST', `/api/rd/projects/${pid}/trials`, trialBody(requirements, over)); assert.equal(r.status, 400, field); assert.ok(r.errors.some(e => e.field === field), field + ': ' + JSON.stringify(r.errors)); };
  await bad({ trial_date: R.addDays(today, 1) }, 'trial_date');
  await bad({ trial_date: '2026-02-30' }, 'trial_date');
  await bad({ stage_no: 4 }, 'stage_no');
  await bad({ outcome: 'Great' }, 'outcome');
  await bad({ rm_cost_per_kg: '12.345' }, 'rm_cost_per_kg');
  await bad({ rm_cost_per_kg: '-1' }, 'rm_cost_per_kg');
  await bad({ results: [{ requirement_id: 99999999, result: 'Pass' }] }, 'results');
  await bad({ results: [{ requirement_id: requirements[0].id, result: 'Maybe' }] }, 'results');
  await bad({ results: [{ requirement_id: requirements[0].id, result: 'Pass' }, { requirement_id: requirements[0].id, result: 'Fail' }] }, 'results');
});

test('trials: formula, what changed, observations and measured values need field.rd_technical; cost needs field.prices; the audit never stores them', async () => {
  const pid = await newProject(); const { requirements } = await list(tok.lead, pid);
  // R&D holds technical but not prices: may record, may not write a cost
  assert.equal((await api(tok.lead, 'POST', `/api/rd/projects/${pid}/trials`, trialBody(requirements, { rm_cost_per_kg: '123.45' }))).status, 403, 'no prices, no cost');
  const a = await api(tok.lead, 'POST', `/api/rd/projects/${pid}/trials`, trialBody(requirements)); assert.equal(a.status, 201, JSON.stringify(a));
  const withCost = await api(tok.admin, 'POST', `/api/rd/projects/${pid}/trials`, trialBody(requirements, { rm_cost_per_kg: '123.45', formula_ref: 'F2' })); assert.equal(withCost.status, 201);
  const asLead = await list(tok.lead, pid);
  const t1 = asLead.trials.find(t => t.id === a.id);
  assert.ok(t1.formula_ref.includes(SECRET) && t1.observations.includes(SECRET) && t1.changed_variables.includes(SECRET));
  assert.ok(t1.results.every(r => r.measured_value.includes(SECRET)));
  assert.ok(!('rm_cost_per_kg' in t1) && !JSON.stringify(asLead).includes('123.45'), 'cost is left out for R&D without prices');
  const asAdmin = await list(tok.admin, pid); assert.equal(asAdmin.trials.find(t => t.id === withCost.id).rm_cost_per_kg, 123.45);
  // a viewer without technical access: structure and results only, nothing confidential anywhere in the response
  const asMgr = await list(tok.manager, pid); assert.equal(asMgr.status, 200);
  assert.ok(!JSON.stringify(asMgr).includes(SECRET), 'no confidential text for a viewer without technical access');
  const m1 = asMgr.trials.find(t => t.id === a.id);
  assert.ok(!('formula_ref' in m1) && !('observations' in m1) && !('changed_variables' in m1) && m1.results.every(r => !('measured_value' in r)));
  assert.equal(m1.summary.total, requirements.length); assert.ok(m1.summary.pass > 0); assert.equal(asMgr.can.technical, false); assert.equal(asMgr.can.add, false);
  // and cannot write
  assert.equal((await api(tok.manager, 'POST', `/api/rd/projects/${pid}/trials`, trialBody(requirements))).status, 403, 'manager has no trial_edit');
  assert.equal((await api(tok.qc, 'GET', `/api/rd/projects/${pid}/trials`)).status, 403, 'qc has no trial_view');
  // the audit trail records that trials exist, never their text or cost
  const aud = await pool.query("SELECT * FROM audit_log WHERE entity = 'rd_trial' AND actor_id = ANY($1)", [[uid.lead, uid.admin]]);
  assert.ok(aud.rowCount >= 2); const dump = JSON.stringify(aud.rows);
  assert.ok(!dump.includes(SECRET) && !dump.includes('123.45') && !dump.includes('MV-'), 'audit never stores trial text, values or cost');
  assert.ok(aud.rows.some(r => r.action === 'rd.trial_add'));
  // the activity feed shows that a trial was recorded, without its content
  const feed = await pool.query("SELECT body FROM rd_updates WHERE project_id = $1 AND kind = 'system'", [pid]); assert.ok(feed.rows.some(r => /Lab trial T1 recorded/.test(r.body)) && !JSON.stringify(feed.rows).includes(SECRET));
});

test('trials: a person who cannot open the project gets "not found"', async () => {
  const pid = await newProject();
  const r = await api(tok.trainee, 'GET', `/api/rd/projects/${pid}/trials`);       // holds trial_view but is not on the project
  assert.equal(r.status, 404, JSON.stringify(r));
  assert.equal((await api(tok.admin, 'GET', `/api/rd/projects/${pid + 100000}/trials`)).status, 404);
});

test('trials: none can be added or corrected on a closed, rejected or On Hold project', async () => {
  const pid = await newProject(); const { requirements } = await list(tok.lead, pid);
  const t = await api(tok.lead, 'POST', `/api/rd/projects/${pid}/trials`, trialBody(requirements)); assert.equal(t.status, 201);
  for (const status of ['On Hold', 'Rejected', 'Completed']) {
    await pool.query('UPDATE rd_projects SET status = $1 WHERE id = $2', [status, pid]);
    assert.equal((await api(tok.lead, 'POST', `/api/rd/projects/${pid}/trials`, trialBody(requirements))).status, 409, status);
    assert.equal((await api(tok.lead, 'PATCH', `/api/rd/projects/${pid}/trials/${t.id}`, { version: 1, reason: 'Fixing a typo', batch_size_text: '600 g' })).status, 409, status + ' correction');
    const l = await list(tok.lead, pid); assert.equal(l.status, 200); assert.equal(l.can.add, false); assert.equal(l.trials.length, 1, 'still readable');
  }
  await pool.query("UPDATE rd_projects SET status = 'Received' WHERE id = $1", [pid]);
});

test('trials: a correction needs a reason and the current version, keeps the old values, and is never a delete', async () => {
  const pid = await newProject(); const { requirements } = await list(tok.lead, pid);
  const t = await api(tok.lead, 'POST', `/api/rd/projects/${pid}/trials`, trialBody(requirements)); const url = `/api/rd/projects/${pid}/trials/${t.id}`;
  assert.equal((await api(tok.lead, 'PATCH', url, { version: 1, batch_size_text: '600 g' })).status, 400, 'reason required');
  assert.equal((await api(tok.lead, 'PATCH', url, { version: 1, reason: '   ', batch_size_text: '600 g' })).status, 400, 'blank reason');
  assert.equal((await api(tok.lead, 'PATCH', url, { version: 1, reason: 'No real change', batch_size_text: '500 g' })).status, 400, 'nothing changed');
  const ok = await api(tok.lead, 'PATCH', url, { version: 1, reason: 'Batch size was written down wrongly', batch_size_text: '600 g', observations: 'Viscosity 95 KU ' + SECRET });
  assert.equal(ok.status, 200, JSON.stringify(ok)); assert.equal(ok.version, 2);
  assert.equal((await api(tok.lead, 'PATCH', url, { version: 1, reason: 'Second correction from a stale page', batch_size_text: '700 g' })).status, 409, 'stale version refused');
  const l = (await list(tok.lead, pid)).trials.find(x => x.id === t.id);
  assert.equal(l.batch_size_text, '600 g'); assert.equal(l.version, 2); assert.equal(l.corrections.length, 1);
  assert.equal(l.corrections[0].reason, 'Batch size was written down wrongly'); assert.equal(l.corrections[0].old.batch_size_text, '500 g'); assert.equal(l.corrections[0].new.batch_size_text, '600 g');
  assert.ok(l.corrections[0].old.observations.includes('92 KU'), 'previous text is kept');
  // a results correction is recorded as one change and keeps the old results
  const flipped = requirements.map(q => ({ requirement_id: q.id, result: 'Pass', measured_value: 'ok' }));
  assert.equal((await api(tok.lead, 'PATCH', url, { version: 2, reason: 'Re-read the results', results: flipped })).status, 200);
  const l2 = (await list(tok.lead, pid)).trials.find(x => x.id === t.id); assert.equal(l2.summary.pass, requirements.length); assert.equal(l2.corrections.length, 2); assert.equal(l2.corrections[1].old.results.length, requirements.length);
  // someone without technical access sees that a correction happened and which fields, but not why or what
  const m = (await list(tok.manager, pid)).trials.find(x => x.id === t.id);
  assert.equal(m.corrections.length, 2); assert.ok(!('reason' in m.corrections[0]) && !('old' in m.corrections[0]) && !JSON.stringify(m).includes(SECRET));
  // there is no way to delete a trial, and the audit has the corrections without the text
  assert.ok([404, 405].includes((await api(tok.admin, 'DELETE', url)).status));
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM rd_trials WHERE id = $1', [t.id])).rows[0].n, 1);
  const aud = await pool.query("SELECT * FROM audit_log WHERE action = 'rd.trial_correct' AND entity_id = $1", [t.id]); assert.equal(aud.rowCount, 2);
  assert.ok(!JSON.stringify(aud.rows).includes(SECRET) && !JSON.stringify(aud.rows).includes('600 g'));
  // a trial of another project cannot be reached through this project's URL
  const other = await newProject(); assert.equal((await api(tok.lead, 'PATCH', `/api/rd/projects/${other}/trials/${t.id}`, { version: 2, reason: 'Wrong project', batch_size_text: 'x' })).status, 404);
});

test('trials: at most one Preferred formula per project, cleared through a correction row; it completes nothing', async () => {
  const pid = await newProject(); const { requirements } = await list(tok.lead, pid);
  const before = await get(pid);
  const a = await api(tok.lead, 'POST', `/api/rd/projects/${pid}/trials`, trialBody(requirements, { outcome: 'Preferred formula' })); assert.equal(a.status, 201);
  const b = await api(tok.lead, 'POST', `/api/rd/projects/${pid}/trials`, trialBody(requirements, { outcome: 'Preferred formula', formula_ref: 'F-B' })); assert.equal(b.status, 201);
  let l = (await list(tok.lead, pid)).trials;
  assert.equal(l.find(t => t.id === a.id).outcome, 'Needs another trial'); assert.equal(l.find(t => t.id === b.id).outcome, 'Preferred formula');
  const ca = l.find(t => t.id === a.id).corrections; assert.equal(ca.length, 1); assert.match(ca[0].reason, /T2 was marked as the preferred formula/); assert.equal(ca[0].old.outcome, 'Preferred formula');
  // correcting an older trial to Preferred clears the newer one
  assert.equal((await api(tok.lead, 'PATCH', `/api/rd/projects/${pid}/trials/${a.id}`, { version: l.find(t => t.id === a.id).version, reason: 'After the repeat, T1 is the better formula', outcome: 'Preferred formula' })).status, 200);
  l = (await list(tok.lead, pid)).trials; assert.equal(l.filter(t => t.outcome === 'Preferred formula').length, 1); assert.equal(l.find(t => t.id === a.id).outcome, 'Preferred formula');
  assert.equal(l.find(t => t.id === b.id).corrections.length, 1);
  const dbPreferred = await pool.query("SELECT COUNT(*)::int AS n FROM rd_trials WHERE project_id = $1 AND outcome = 'Preferred formula'", [pid]); assert.equal(dbPreferred.rows[0].n, 1);
  // a preferred formula changes no stage, ticks no checklist item and records no approval
  const after = await get(pid);
  assert.deepEqual(after.stages.map(s => [s.no, s.state, s.completed_at || null]), before.stages.map(s => [s.no, s.state, s.completed_at || null]));
  assert.equal(JSON.stringify(after.stages.map(s => s.checklist.map(c => c.done))), JSON.stringify(before.stages.map(s => s.checklist.map(c => c.done))));
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM rd_approvals WHERE project_id = $1', [pid])).rows[0].n, 1, 'only the submission record exists');
  assert.equal(after.project.status, before.project.status);
});
const get = (pid) => api(tok.admin, 'GET', '/api/rd/projects/' + pid);

test('trials: the project page learns what the person may do', async () => {
  const pid = await newProject();
  const lead = await get(pid); assert.equal(lead.can.trial_view, true);
  assert.equal((await api(tok.lead, 'GET', '/api/rd/projects/' + pid)).can.trial_edit, true);
  const m = await api(tok.manager, 'GET', '/api/rd/projects/' + pid); assert.equal(m.can.trial_view, true); assert.equal(m.can.trial_edit, false);
});
