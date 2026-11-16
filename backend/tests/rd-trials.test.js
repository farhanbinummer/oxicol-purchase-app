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

// ---------------------------------------------------------------- extra fields, attachments, overview summary and stage warning
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]), crypto.randomBytes(200)]);
const upload = (token, pid, tid, body, type, name) => fetch(`${BASE}/api/rd/projects/${pid}/trials/${tid}/attachments`, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': type || 'image/jpeg', 'X-File-Name': encodeURIComponent(name || 'plate 1.jpg') }, body }).then(async r => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
const download = (token, pid, tid, aid) => fetch(`${BASE}/api/rd/projects/${pid}/trials/${tid}/attachments/${aid}`, { headers: { Authorization: 'Bearer ' + token } });

test('trials: "Add a field" - extra fields are saved, confidential, corrected with history, and checked', async () => {
  const pid = await newProject(); const { requirements } = await list(tok.lead, pid);
  const t = await api(tok.lead, 'POST', `/api/rd/projects/${pid}/trials`, trialBody(requirements, { extra_fields: [{ label: 'Pot life', value: '4 h ' + SECRET }, { label: 'Colour match', value: 'good' }, { label: '', value: '' }] }));
  assert.equal(t.status, 201, JSON.stringify(t));
  const l = (await list(tok.lead, pid)).trials[0]; assert.deepEqual(l.extra_fields, [{ label: 'Pot life', value: '4 h ' + SECRET }, { label: 'Colour match', value: 'good' }], 'the empty row was dropped');
  const m = await list(tok.manager, pid); assert.ok(!JSON.stringify(m).includes('Pot life') && !JSON.stringify(m).includes(SECRET) && !('extra_fields' in m.trials[0]), 'confidential: left out for a viewer without technical access');
  const url = `/api/rd/projects/${pid}/trials/${t.id}`;
  const c = await api(tok.lead, 'PATCH', url, { version: 1, reason: 'Added a field and removed another', extra_fields: [{ label: 'Pot life', value: '4 h' }, { label: 'Gloss at 60 deg', value: '82' }] });
  assert.equal(c.status, 200, JSON.stringify(c)); assert.deepEqual(c.fields, ['extra_fields']);
  const after = (await list(tok.lead, pid)).trials[0]; assert.equal(after.extra_fields.length, 2); assert.equal(after.corrections[0].old.extra_fields[1].label, 'Colour match', 'the removed field is kept in the history');
  assert.equal((await api(tok.lead, 'PATCH', url, { version: 2, reason: 'Same fields again', extra_fields: [{ label: 'Pot life', value: '4 h' }, { label: 'Gloss at 60 deg', value: '82' }] })).status, 400, 'nothing changed');
  for (const bad of [[{ label: 'A', value: '1' }, { label: 'a', value: '2' }], [{ label: '', value: 'x' }], Array.from({ length: 16 }, (_, i) => ({ label: 'F' + i, value: '' })), 'nope']) {
    const r = await api(tok.lead, 'POST', `/api/rd/projects/${pid}/trials`, trialBody(requirements, { extra_fields: bad })); assert.equal(r.status, 400); assert.ok(r.errors.some(e => e.field === 'extra_fields'));
  }
  const aud = await pool.query("SELECT * FROM audit_log WHERE entity = 'rd_trial' AND entity_id = $1", [t.id]); assert.ok(!JSON.stringify(aud.rows).includes('Pot life') && !JSON.stringify(aud.rows).includes(SECRET), 'the audit never stores extra field names or values');
});

test('trials: photographs and PDFs - checked by their bytes, confidential, capped, removed only with a reason, kept in the history', async () => {
  const pid = await newProject(); const { requirements } = await list(tok.lead, pid);
  const t = await api(tok.lead, 'POST', `/api/rd/projects/${pid}/trials`, trialBody(requirements));
  const ok = await upload(tok.lead, pid, t.id, JPEG, 'image/jpeg', '../../My Plate<1>.jpg'); assert.equal(ok.status, 201, JSON.stringify(ok)); assert.equal(ok.file_name, 'My Plate1.jpg'); assert.equal(ok.mime, 'image/jpeg');
  // the file itself comes back unchanged, with safe headers
  const dl = await download(tok.lead, pid, t.id, ok.id); assert.equal(dl.status, 200); assert.equal(dl.headers.get('content-type'), 'image/jpeg'); assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(Buffer.from(await dl.arrayBuffer()).equals(JPEG));
  // listing shows details to R&D, only a count to a viewer without technical access, who also cannot download
  const l = (await list(tok.lead, pid)).trials[0]; assert.equal(l.attachments.length, 1); assert.equal(l.attachments[0].file_name, 'My Plate1.jpg'); assert.ok(!('data' in l.attachments[0]));
  const mg = (await list(tok.manager, pid)).trials[0]; assert.equal(mg.attachment_count, 1); assert.ok(!('attachments' in mg));
  assert.equal((await download(tok.manager, pid, t.id, ok.id)).status, 403); assert.equal((await upload(tok.manager, pid, t.id, JPEG)).status, 403);
  assert.equal((await download(tok.qc, pid, t.id, ok.id)).status, 403, 'no trial_view');
  // a person who cannot open the project, and a file reached through the wrong trial
  assert.equal((await download(tok.trainee, pid, t.id, ok.id)).status, 403, 'no technical access (and the project is not theirs to open)');
  const other = await newProject(); const ot = await api(tok.lead, 'POST', `/api/rd/projects/${other}/trials`, trialBody((await list(tok.lead, other)).requirements));
  assert.equal((await download(tok.lead, other, ot.id, ok.id)).status, 404, 'a file of another project trial');
  // what is accepted is decided by the bytes
  assert.equal((await upload(tok.lead, pid, t.id, Buffer.from('<html><script>alert(1)</script></html>'), 'image/jpeg')).status, 400, 'HTML sent as an image');
  assert.equal((await upload(tok.lead, pid, t.id, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/png')).status, 400, 'SVG');
  assert.equal((await upload(tok.lead, pid, t.id, JPEG, 'text/plain')).status, 400, 'other content types are not read at all');
  assert.equal((await upload(tok.lead, pid, t.id, Buffer.alloc(0), 'image/jpeg')).status, 400, 'empty');
  const pdf = await upload(tok.lead, pid, t.id, Buffer.from('%PDF-1.7\n' + 'x'.repeat(500)), 'application/pdf', 'report.pdf'); assert.equal(pdf.status, 201);
  assert.match((await download(tok.lead, pid, t.id, pdf.id)).headers.get('content-disposition'), /^attachment/, 'PDFs are downloaded, never rendered in the page');
  const big = await upload(tok.lead, pid, t.id, Buffer.concat([JPEG, Buffer.alloc(R.ATTACH_MAX_BYTES + 4096)]), 'image/jpeg'); assert.ok([400, 413].includes(big.status), 'over 5 MB: ' + big.status);
  // removing needs a reason; the file is hidden but kept
  const rurl = `/api/rd/projects/${pid}/trials/${t.id}/attachments/${ok.id}/remove`;
  assert.equal((await api(tok.lead, 'POST', rurl, {})).status, 400); assert.equal((await api(tok.manager, 'POST', rurl, { reason: 'Not mine to remove' })).status, 403);
  assert.equal((await api(tok.lead, 'POST', rurl, { reason: 'Wrong plate photographed' })).status, 200);
  assert.equal((await download(tok.lead, pid, t.id, ok.id)).status, 404); assert.equal((await list(tok.lead, pid)).trials[0].attachments.length, 1);
  const kept = await pool.query('SELECT removed_reason, removed_by_name, size_bytes FROM rd_trial_attachments WHERE id = $1', [ok.id]); assert.equal(kept.rows[0].removed_reason, 'Wrong plate photographed'); assert.equal(kept.rows[0].size_bytes, JPEG.length);
  // the audit and feed record that a file was added or removed, never its name
  const aud = await pool.query("SELECT * FROM audit_log WHERE action IN ('rd.trial_attach','rd.trial_attach_remove') AND entity_id = $1", [t.id]); assert.equal(aud.rowCount, 3); assert.ok(!JSON.stringify(aud.rows).includes('Plate') && !JSON.stringify(aud.rows).includes('report.pdf'));
  // ten files per trial
  const t2 = await api(tok.lead, 'POST', `/api/rd/projects/${pid}/trials`, trialBody(requirements));
  for (let i = 0; i < R.ATTACH_MAX_PER_TRIAL; i++) assert.equal((await upload(tok.lead, pid, t2.id, Buffer.concat([JPEG, Buffer.from([i])]))).status, 201);
  assert.equal((await upload(tok.lead, pid, t2.id, JPEG)).status, 409, 'the eleventh');
  // none on a closed or paused project
  await pool.query("UPDATE rd_projects SET status = 'On Hold' WHERE id = $1", [pid]);
  assert.equal((await upload(tok.lead, pid, t.id, JPEG)).status, 409); assert.equal((await api(tok.lead, 'POST', `/api/rd/projects/${pid}/trials/${t.id}/attachments/${pdf.id}/remove`, { reason: 'Project is on hold' })).status, 409);
  assert.equal((await download(tok.lead, pid, t.id, pdf.id)).status, 200, 'still readable');
  await pool.query("UPDATE rd_projects SET status = 'Received' WHERE id = $1", [pid]);
});

test('trials: the Overview summary and the soft stage warning', async () => {
  const pid = await newProject(); const { requirements } = await list(tok.lead, pid);
  let d = await api(tok.lead, 'GET', '/api/rd/projects/' + pid);
  assert.equal(d.trials_summary.count, 0); assert.equal(d.stages[1].no_trial_warning, true); assert.equal(d.stages[2].no_trial_warning, true); assert.equal(d.stages[0].no_trial_warning, false, 'only the lab stages');
  assert.equal(d.stages[0].trial_count, null);
  await api(tok.lead, 'POST', `/api/rd/projects/${pid}/trials`, trialBody(requirements.map(q => q), { stage_no: 2, results: requirements.map((q, i) => ({ requirement_id: q.id, result: i < 2 ? 'Pass' : 'Fail' })) }));
  await api(tok.lead, 'POST', `/api/rd/projects/${pid}/trials`, trialBody(requirements, { stage_no: 3, outcome: 'Preferred formula', results: requirements.map(q => ({ requirement_id: q.id, result: 'Pass' })) }));
  d = await api(tok.lead, 'GET', '/api/rd/projects/' + pid);
  const sm = d.trials_summary; assert.equal(sm.count, 2); assert.equal(sm.total, requirements.length); assert.equal(sm.latest.pass, requirements.length); assert.equal(sm.previous.pass, 2); assert.equal(sm.preferred.label, 'T2'); assert.ok(sm.preferred.formula_ref.includes(SECRET)); assert.equal(sm.days_since, 0);
  assert.equal(d.stages[1].trial_count, 1); assert.equal(d.stages[1].no_trial_warning, false); assert.equal(d.stages[2].no_trial_warning, false);
  // someone without technical access gets the numbers but not the formula; someone without trial_view gets nothing
  const m = await api(tok.manager, 'GET', '/api/rd/projects/' + pid); assert.equal(m.trials_summary.count, 2); assert.ok(!JSON.stringify(m.trials_summary).includes(SECRET)); assert.ok(!('formula_ref' in m.trials_summary.preferred));
  // the warning is only a warning: completing the stage is not blocked by it (checked at the rule level: the route has no trial condition)
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'routes', 'rd.js'), 'utf8'); assert.ok(/no lab trial was recorded/.test(src) && !/missing\.push\([^)]*trial/i.test(src));
});

// ---------------------------------------------------------------- task link, notices
const mkTask = (token, pid, over) => api(token, 'POST', `/api/rd/projects/${pid}/tasks`, { title: 'Run trial', assignee_id: uid.lead, due_date: R.addDays(today, 3), stage_no: 3, ...(over || {}) });
const getTask = async (pid, id) => (await api(tok.admin, 'GET', '/api/rd/projects/' + pid)).tasks.find(t => t.id === id);

test('trials: a task that "produces a lab trial" is linked to the trial and completed by the usual rules', async () => {
  const pid = await newProject(); const { requirements } = await list(tok.lead, pid);
  const flagged = await mkTask(tok.admin, pid, { title: 'Run trial 1', expects_trial: true }); assert.equal(flagged.status, 201, JSON.stringify(flagged));
  const plain = await mkTask(tok.admin, pid, { title: 'Not a trial task' }); const others = await mkTask(tok.admin, pid, { title: 'Someone else\'s', expects_trial: true, assignee_id: uid.admin });
  assert.equal((await getTask(pid, flagged.id)).expects_trial, true); assert.equal((await getTask(pid, plain.id)).expects_trial, false);
  // the dialog's list holds only the person's own open trial tasks
  const l = await list(tok.lead, pid); assert.deepEqual(l.open_trial_tasks.map(t => t.id), [flagged.id]);
  // wrong choices are refused
  const body = (task_id) => trialBody(requirements, { task_id });
  assert.equal((await api(tok.lead, 'POST', `/api/rd/projects/${pid}/trials`, body(plain.id))).status, 400, 'not a trial task');
  assert.equal((await api(tok.lead, 'POST', `/api/rd/projects/${pid}/trials`, body(others.id))).status, 403, 'assigned to someone else');
  assert.equal((await api(tok.lead, 'POST', `/api/rd/projects/${pid}/trials`, body(99999999))).status, 400, 'unknown');
  assert.equal((await list(tok.lead, pid)).trials.length, 0, 'a refused trial leaves nothing behind');
  // recording the trial completes the task, with a plain non-confidential result, and links the two
  const ok = await api(tok.lead, 'POST', `/api/rd/projects/${pid}/trials`, body(flagged.id)); assert.equal(ok.status, 201, JSON.stringify(ok)); assert.deepEqual(ok.task, { id: flagged.id, status: 'done' });
  const t = await getTask(pid, flagged.id); assert.equal(t.status, 'done'); assert.match(t.result, /^Lab trial T1 recorded: Needs another trial, \d+ of \d+ requirements pass\.$/); assert.ok(!t.result.includes(SECRET)); assert.equal(t.completed_by, uid.lead);
  assert.equal((await list(tok.lead, pid)).trials[0].task.title, 'Run trial 1');
  assert.equal((await api(tok.lead, 'POST', `/api/rd/projects/${pid}/trials`, body(flagged.id))).status, 409, 'a finished task cannot be used again');
  // a task that must be reviewed is handed in, not closed
  const rv = await mkTask(tok.admin, pid, { title: 'Checked trial', expects_trial: true, requires_review: true });
  const r2 = await api(tok.lead, 'POST', `/api/rd/projects/${pid}/trials`, body(rv.id)); assert.deepEqual(r2.task, { id: rv.id, status: 'in_review' }); assert.equal((await getTask(pid, rv.id)).status, 'in_review');
  // a task that asks for its own result form is only linked: it stays open
  const fm = await mkTask(tok.admin, pid, { title: 'Form trial', expects_trial: true, result_schema: { kind: 'form', name: 'Viscosity', fields: [{ label: 'Viscosity', type: 'number', required: true }] } });
  assert.equal(fm.status, 201, JSON.stringify(fm)); const r3 = await api(tok.lead, 'POST', `/api/rd/projects/${pid}/trials`, body(fm.id)); assert.deepEqual(r3.task, { id: fm.id, status: 'open' }); assert.equal((await getTask(pid, fm.id)).status, 'todo');
  // the flag is set when the task is created; it cannot be switched on later by an edit
  assert.equal((await api(tok.admin, 'PATCH', '/api/rd/tasks/' + plain.id, { version: (await getTask(pid, plain.id)).version, expects_trial: true })).status < 500, true);
  assert.equal((await getTask(pid, plain.id)).expects_trial, false);
});

test('trials: the project\'s people are told about a trial or a preferred formula, without any confidential text', async () => {
  const pid = await newProject(); const { requirements } = await list(tok.lead, pid);
  await pool.query('UPDATE rd_projects SET lead_user_id = $1 WHERE id = $2', [uid.lead, pid]);
  await pool.query('UPDATE users SET email = $1 WHERE id = $2', [`${TAG}_lead@example.invalid`, uid.lead]);
  await pool.query('DELETE FROM notice_log WHERE user_id = $1', [uid.lead]);
  const a = await api(tok.admin, 'POST', `/api/rd/projects/${pid}/trials`, trialBody(requirements)); assert.equal(a.status, 201);
  const b = await api(tok.admin, 'POST', `/api/rd/projects/${pid}/trials`, trialBody(requirements, { outcome: 'Preferred formula' })); assert.equal(b.status, 201);
  let rows = []; for (let i = 0; i < 20 && rows.length < 2; i++) { await new Promise(r => setTimeout(r, 150)); rows = (await pool.query("SELECT kind, subject, body FROM notice_log WHERE user_id = $1 ORDER BY id", [uid.lead])).rows; }
  assert.deepEqual(rows.map(r => r.kind), ['trial_added', 'trial_preferred']);
  assert.match(rows[0].body, /recorded lab trial T1/); assert.match(rows[1].body, /preferred formula/); assert.match(rows[1].body, /does not complete a stage/);
  assert.ok(!JSON.stringify(rows).includes(SECRET), 'a notice never carries the formula, observations or values');
  // the person who recorded it is not told about their own action
  const own = await pool.query('SELECT 1 FROM notice_log WHERE user_id = $1', [uid.admin]); assert.equal(own.rowCount, 0);
  await pool.query('UPDATE users SET email = NULL WHERE id = $1', [uid.lead]);
});
