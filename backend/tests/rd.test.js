// R&D module tests: a real server on its own port against the configured database.
//   npm run test:rd
// Everything created (users, projects, tasks, notes) is removed afterwards and the month's number counter is put back exactly as it
// was, so the tests never use up real project numbers. Users get random passwords that are never printed.

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
const TAG = 'zzr' + crypto.randomBytes(3).toString('hex');
const made = { users: [], projects: [] };
let server; const tok = {}, uid = {};
let counterBefore;                      // the month's number counter before the tests, restored afterwards
const period = R.periodOf(R.todayIST());

async function api(token, method, url, body) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = {}; try { json = await res.json(); } catch (e) {}
  return { status: res.status, ...json };
}
async function mkUser(label, roles, scopes = {}) {
  const username = `${TAG}_${label}`;
  const hash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 4);
  const primary = primaryRole(roles);
  const r = await pool.query('INSERT INTO users (username, password_hash, name, role, branch) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [username, hash, `Test ${label}`, primary, primary === 'branch' ? (scopes.branch || [])[0] : null]);
  made.users.push(r.rows[0].id); uid[label] = r.rows[0].id;
  for (const role of roles) await pool.query('INSERT INTO user_roles (user_id, role) VALUES ($1,$2)', [r.rows[0].id, role]);
  for (const [role, list] of Object.entries(scopes)) for (const b of list) await pool.query("INSERT INTO user_scopes (user_id, role, scope_type, scope_value) VALUES ($1,$2,'branch',$3)", [r.rows[0].id, role, b]);
  return createSession(r.rows[0].id);
}
const valid = (over) => ({
  title: `${TAG} project`, project_type: R.PROJECT_TYPES[0], department: 'R&D Internal', priority: 'High', product_category: R.PRODUCT_CATEGORIES[0],
  base_system: 'Solvent-based', description: 'A test coating for car underchassis', target_tbc: true,
  requirements: R.DEFAULT_PERFORMANCE_ROWS.map(p => ({ parameter: p })), submit: true, ...(over || {})
});
async function newProject(token, over) {
  const r = await api(token, 'POST', '/api/rd/projects', valid(over));
  assert.equal(r.success, true, JSON.stringify(r));
  made.projects.push(r.id);
  return r;
}
const get = (token, id) => api(token, 'GET', '/api/rd/projects/' + id);
/** Checks every item of a stage and completes it. Earlier completions are backdated a minute so the burst guard does not apply to routine setup. */
async function completeStage(token, id, no, date) {
  await pool.query("UPDATE rd_stages SET completed_at = completed_at - INTERVAL '1 minute' WHERE project_id = $1 AND completed_at IS NOT NULL", [id]);
  const d = await get(token, id);
  const st = d.stages.find(s => s.no === no);
  for (const c of st.checklist) await api(token, 'POST', `/api/rd/projects/${id}/stages/${no}/checklist/${c.id}`, { done: true, result: 'Test result' });
  return api(token, 'POST', `/api/rd/projects/${id}/stages/${no}/complete`, { date: date || R.todayIST(), confirm: true });
}

test.before(async () => {
  await runMigrations();
  // Production defaults let only managers raise requests. These tests exercise visibility and stage rules with branch and R&D
  // requesters, so grant them rd.create for the duration of the run (removed in test.after) before the server starts.
  for (const role of ['rd', 'branch']) await pool.query("INSERT INTO role_permissions (role, permission_key) VALUES ($1,'rd.create') ON CONFLICT DO NOTHING", [role]);
  const c = await pool.query('SELECT last_serial FROM rd_number_counters WHERE period = $1', [period]);
  counterBefore = c.rowCount ? c.rows[0].last_serial : null;
  server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch (e) {} await new Promise(r => setTimeout(r, 250)); }
  tok.admin = await mkUser('admin', ['admin']);
  tok.lead = await mkUser('lead', ['rd']);
  tok.rd2 = await mkUser('rd2', ['rd']);
  tok.manager = await mkUser('manager', ['manager']);
  tok.kannur = await mkUser('kannur', ['branch'], { branch: ['Kannur'] });
  tok.thrissur = await mkUser('thrissur', ['branch'], { branch: ['Thrissur'] });
  tok.purchase = await mkUser('purchase', ['purchase']);
  tok.qc = await mkUser('qc', ['qc']);
  tok.store = await mkUser('store', ['store']);
  tok.trainee = await mkUser('trainee', ['rd_trainee']);
});

test.after(async () => {
  try {
    await pool.query("DELETE FROM role_permissions WHERE permission_key = 'rd.create' AND role <> 'manager'");
    await pool.query('DELETE FROM rd_projects WHERE id = ANY($1)', [made.projects.length ? made.projects : [0]]); // everything else cascades
    await pool.query("DELETE FROM rd_projects WHERE created_by = ANY($1)", [made.users.length ? made.users : [0]]);
    if (counterBefore === null) await pool.query('DELETE FROM rd_number_counters WHERE period = $1', [period]);
    else await pool.query('UPDATE rd_number_counters SET last_serial = $1 WHERE period = $2', [counterBefore, period]);
    await pool.query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [made.users.length ? made.users : [0]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users.length ? made.users : [0]]);
  } finally { server && server.kill(); await pool.end(); }
});

// ---------------------------------------------------------------------------------------------------
test('only the Manager role is granted rd.create by default (R&D and Branch are not)', () => {
  const { DEFAULTS } = require('../permissions');
  const holders = Object.entries(DEFAULTS).filter(([, keys]) => keys.includes('rd.create')).map(([role]) => role);
  assert.deepEqual(holders, ['manager']);
});

test('only managers (and admins) can raise R&D requests: R&D and branch get 403 on create and submit, and no "New R&D Request" entry', async () => {
  // The run grants rd.create to R&D and Branch so other tests can use them as requesters; take it away here to check the real defaults.
  await pool.query("DELETE FROM role_permissions WHERE permission_key = 'rd.create' AND role <> 'manager'");
  try {
    for (const who of ['lead', 'kannur']) {
      assert.equal((await api(tok[who], 'POST', '/api/rd/projects', valid())).status, 403, who + ' cannot create a request');
      assert.equal((await api(tok[who], 'POST', '/api/rd/projects', valid({ submit: false }))).status, 403, who + ' cannot even save a draft');
    }
    const draft = await api(tok.manager, 'POST', '/api/rd/projects', valid({ submit: false }));
    assert.equal(draft.success, true, 'a manager can save a draft'); made.projects.push(draft.id);
    assert.equal((await api(tok.lead, 'POST', '/api/rd/projects/' + draft.id + '/submit', {})).status, 403, 'R&D cannot submit a request either');
    const sub = await api(tok.manager, 'POST', '/api/rd/projects/' + draft.id + '/submit', {});
    assert.equal(sub.success, true, 'the manager can submit');
    assert.equal((await api(tok.admin, 'POST', '/api/rd/projects', valid())).success, true, 'an administrator can still raise a request');
    const madeByAdmin = (await pool.query("SELECT id FROM rd_projects WHERE created_by = (SELECT id FROM users WHERE username = $1)", [TAG + '_admin'])).rows.map(r => r.id);
    made.projects.push(...madeByAdmin);
    assert.equal((await api(tok.lead, 'GET', '/api/rd/meta')).can.create, false, 'the page learns R&D may not start requests');
    assert.equal((await api(tok.manager, 'GET', '/api/rd/meta')).can.create, true);
    const dash = await api(tok.lead, 'GET', '/api/workspace/rd/dashboard');
    assert.ok(!dash.actions.some(a => a.href === 'project-new.html'), 'R&D home has no "New R&D Request" button');
    const me = await api(tok.lead, 'GET', '/api/workspace/me');
    assert.ok(!me.nav.some(g => g.items.some(i => i.href === 'project-new.html')), 'R&D menu has no "New R&D Request" entry');
    assert.equal((me.create_links || []).some(c => c.href === 'project-new.html'), false, 'no "New" shortcut for R&D either');
    // R&D can still work on a request a manager raised
    assert.equal((await api(tok.lead, 'GET', '/api/rd/projects/' + draft.id)).status, 200, 'R&D can still open and work on a submitted request');
  } finally {
    for (const role of ['rd', 'branch']) await pool.query("INSERT INTO role_permissions (role, permission_key) VALUES ($1,'rd.create') ON CONFLICT DO NOTHING", [role]);
  }
});

test('checklist results: needed to tick, kept on untick, locked once the stage is complete, confidential, and never copied into the audit log', async () => {
  const SECRET = 'Formula FX-' + TAG + ': 42 percent resin, 3 percent additive';
  const p = await newProject(tok.lead);
  const item = async (who, no, i) => (await get(tok[who], p.id)).stages[no - 1].checklist[i];
  const tick = (who, no, c, body) => api(tok[who], 'POST', `/api/rd/projects/${p.id}/stages/${no}/checklist/${c.id}`, body);
  let c = await item('lead', 1, 0);
  assert.equal(c.needs_result, true); assert.equal(c.result, null);
  assert.equal((await tick('lead', 1, c, { done: true })).status, 400, 'an item that needs a result cannot be ticked without one');
  assert.equal((await tick('lead', 1, c, { done: true, result: '   ' })).status, 400, 'a blank result does not count');
  assert.equal((await tick('lead', 1, c, { done: true, result: 'x'.repeat(R.MAX_RESULT_LENGTH + 1) })).status, 400, 'an over-long result is refused');
  assert.equal((await item('lead', 1, 0)).done, false, 'a refused tick changes nothing');
  assert.equal((await tick('lead', 1, c, { done: true, result: SECRET })).success, true);
  c = await item('lead', 1, 0);
  assert.equal(c.done, true); assert.equal(c.result, SECRET); assert.ok(c.done_by_name && c.done_at && c.result_at, 'who, when and what are all recorded');
  // untick keeps the result so no work is lost; ticking again needs no retyping
  assert.equal((await tick('lead', 1, c, { done: false })).success, true);
  assert.equal((await item('lead', 1, 0)).result, SECRET, 'the result survives an untick');
  assert.equal((await tick('lead', 1, c, { done: true })).success, true, 'a stored result is enough to tick again');
  // confidentiality: a person who can open the project but lacks technical access never receives the text
  for (const who of ['manager', 'admin']) {
    const seen = await item(who, 1, 0);
    if (who === 'manager') { assert.equal(seen.result, null); assert.equal(seen.result_hidden, true, 'the page can say a result exists without showing it'); assert.ok(!JSON.stringify(await get(tok.manager, p.id)).includes(SECRET), 'the text is nowhere in the response'); }
    else assert.equal(seen.result, SECRET, 'an administrator holds every permission');
  }
  assert.equal((await tick('manager', 1, c, { done: false })).status, 403, 'view-only people cannot change the checklist');
  // the two sign-off items need no result: their record is the approval
  const qc = (await get(tok.lead, p.id)).stages[3].checklist[2];
  assert.equal(qc.label, 'Obtain QC sign-off'); assert.equal(qc.needs_result, false);
  // finish stage 1 and check it locks
  for (let i = 1; i < 3; i++) assert.equal((await tick('lead', 1, await item('lead', 1, i), { done: true, result: 'Done ' + i })).success, true);
  assert.equal((await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/stages/1/complete`, { date: R.todayIST(), confirm: true })).success, true);
  assert.equal((await tick('lead', 1, await item('lead', 1, 0), { done: true, result: 'Changed afterwards' })).status, 409, 'a completed stage keeps its record until it is reopened');
  assert.equal((await item('lead', 1, 0)).result, SECRET);
  // the audit trail says what happened but never what was found
  const log = (await pool.query("SELECT summary, before_data, after_data FROM audit_log WHERE entity = 'rd_project' AND entity_id = $1 AND action = 'rd.checklist'", [p.id])).rows;
  assert.ok(log.length >= 3, 'ticks are audited');
  assert.ok(!JSON.stringify(log).includes('FX-' + TAG), 'the result text is not in the audit log');
});

test('migrations add the R&D tables and roles without touching existing data; the sample project does not exist', async () => {
  const names = (await pool.query('SELECT name FROM app_migrations')).rows.map(r => r.name);
  assert.ok(names.includes('009_rd_projects') && names.includes('010_rd_permissions') && names.includes('012_rd_checklist_results'));
  const cols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'rd_checklist_items'")).rows.map(r => r.column_name);
  assert.ok(cols.includes('result') && cols.includes('result_at'), 'items can hold a result');
  const before = names.length; await runMigrations();
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM app_migrations')).rows[0].n, before);
  assert.equal((await pool.query("SELECT COUNT(*)::int n FROM rd_projects WHERE project_number = 'OXRD011026' AND created_by IS NULL AND imported_from IS NULL")).rows[0].n, 0, 'nothing was invented: the migrations never create the historical project; it comes only from the reviewable import script');
  const noApproval = (await pool.query("SELECT role FROM role_permissions WHERE permission_key IN ('rd.approve_head','rd.approve_mgmt','rd.qc_signoff','rd.handover_ack')")).rows;
  assert.equal(noApproval.length, 0, 'no role is given approval authority by default');
  const edit = (await pool.query("SELECT role FROM role_permissions WHERE permission_key = 'rd.edit'")).rows.map(r => r.role);
  assert.deepEqual(edit, ['rd'], 'only the R&D role edits projects by default');
});

test('a draft needs only a title and has no number; a submitted request gets one, eight stages and the requester\'s own identity', async () => {
  const d = await api(tok.kannur, 'POST', '/api/rd/projects', { title: `${TAG} draft`, requested_by_name: 'Somebody Else', requested_by_user: uid.admin });
  assert.equal(d.status, 201); assert.equal(d.is_draft, true); assert.equal(d.project_number, null); made.projects.push(d.id);
  const bad = await api(tok.kannur, 'POST', '/api/rd/projects', { title: 'x', submit: true });
  assert.equal(bad.status, 400); assert.ok(bad.errors.length >= 6, 'every missing required field is listed');
  assert.equal((await api(tok.kannur, 'POST', '/api/rd/projects', { title: '', submit: false })).status, 400);
  const p = await newProject(tok.kannur);
  assert.match(p.project_number, /^OXRD\d{2,}\d{4}$/);
  const det = await get(tok.kannur, p.id);
  assert.equal(det.project.requested_by_user, uid.kannur, 'the requester is the signed-in person');
  assert.equal(det.project.requested_by_name, 'Test kannur');
  assert.equal(det.stages.length, 8); assert.ok(det.stages.every(s => s.checklist.length === 3 && s.state !== 'done'));
  assert.equal(det.current_stage_no, 1);
  assert.equal(det.project.request_date, R.todayIST());
  assert.ok(det.approvals.some(a => a.kind === 'submission' && a.decision === 'submitted' && a.decided_by === uid.kannur), 'submission records who asked; it is not an authorisation');
  assert.ok(!det.approvals.some(a => ['management', 'rd_head'].includes(a.kind)));
  assert.equal(det.requirements.length, 8, 'the eight starting rows are kept: a row with its parameter named is not empty');
  const withRows = await newProject(tok.kannur, { requirements: [{ parameter: 'Viscosity', target: '60 KU' }, {}, { parameter: '  ' }, null] });
  assert.equal((await get(tok.kannur, withRows.id)).requirements.length, 1, 'completely empty rows are ignored when saving');
  const again = await api(tok.kannur, 'POST', `/api/rd/projects/${d.id}/submit`);
  assert.equal(again.status, 400, 'a draft that is missing fields cannot be submitted');
});

test('project numbers are unique and sequential under simultaneous submissions, and never truncate past 99 a month', async () => {
  const batch = await Promise.all(Array.from({ length: 12 }, (_, i) => api(i % 2 ? tok.kannur : tok.lead, 'POST', '/api/rd/projects', valid({ title: `${TAG} race ${i}` }))));
  batch.forEach(b => { assert.equal(b.status, 201, JSON.stringify(b)); made.projects.push(b.id); });
  const serials = batch.map(b => R.parseProjectNumber(b.project_number).serial).sort((a, b) => a - b);
  assert.equal(new Set(batch.map(b => b.project_number)).size, 12, 'no duplicates');
  for (let i = 1; i < serials.length; i++) assert.equal(serials[i], serials[i - 1] + 1, 'no gaps');

  // push the month to 98 and submit past 99
  await pool.query(`INSERT INTO rd_number_counters (period, last_serial) VALUES ($1, 98) ON CONFLICT (period) DO UPDATE SET last_serial = 98`, [period]);
  const over = [];
  for (let i = 0; i < 3; i++) { const r = await newProject(tok.lead, { title: `${TAG} over ${i}` }); over.push(r.project_number); }
  const yymm = R.numberFor(1, R.todayIST()).slice(6);
  assert.deepEqual(over, ['OXRD99' + yymm, 'OXRD100' + yymm, 'OXRD101' + yymm], 'a third digit is kept');
  const ids = (await pool.query('SELECT id FROM rd_projects WHERE project_number = ANY($1)', [over])).rows;
  assert.equal(ids.length, 3, 'the internal ids are distinct from the numbers');
});

test('visibility: drafts are private; projects are seen by involvement or by wide permission; counts equal lists', async () => {
  const draft = await api(tok.kannur, 'POST', '/api/rd/projects', { title: `${TAG} private draft` }); made.projects.push(draft.id);
  assert.equal((await get(tok.kannur, draft.id)).status, 200);
  for (const who of ['lead', 'manager', 'thrissur', 'purchase']) assert.equal((await get(tok[who], draft.id)).status, 404, who + ' cannot see another person\'s draft');
  assert.equal((await get(tok.admin, draft.id)).status, 200, 'administrators can');

  const p = await newProject(tok.kannur);
  assert.equal((await get(tok.kannur, p.id)).status, 200, 'the requester');
  assert.equal((await get(tok.lead, p.id)).status, 200, 'R&D sees every project');
  assert.equal((await get(tok.manager, p.id)).status, 200, 'management sees every project');
  assert.equal((await get(tok.thrissur, p.id)).status, 404, 'another requester does not');
  assert.equal((await get(tok.purchase, p.id)).status, 404, 'a department that is not involved does not');
  const asMember = await api(tok.lead, 'PUT', `/api/rd/projects/${p.id}/assessment`, { version: (await get(tok.lead, p.id)).project.version, members: [uid.purchase] });
  assert.equal(asMember.success, true);
  assert.equal((await get(tok.purchase, p.id)).status, 200, 'a member sees it');

  const list = await api(tok.purchase, 'GET', '/api/rd/projects?scope=all');
  assert.ok(list.projects.some(x => x.id === p.id) && !list.projects.some(x => x.id === draft.id));
  const kList = await api(tok.kannur, 'GET', '/api/rd/projects?scope=all');
  assert.equal(kList.counts.active + kList.counts.hold + kList.counts.closed + kList.counts.drafts, kList.count, 'the counts add up to the list');
  assert.ok(kList.projects.every(x => x.requested_by_name === 'Test kannur'), 'a requester only ever sees their own');
  assert.equal((await api(tok.store, 'GET', '/api/rd/projects')).projects.length, 0, 'someone with no involvement sees nothing');
});

test('confidential content stays with people who may see it, even for project members', async () => {
  const p = await newProject(tok.kannur);
  await api(tok.lead, 'PUT', `/api/rd/projects/${p.id}/assessment`, { version: (await get(tok.lead, p.id)).project.version, members: [uid.purchase, uid.qc], lead_user_id: uid.lead, technical_approach: 'SECRET-APPROACH', risks: 'SECRET-RISK' });
  assert.equal((await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/updates`, { kind: 'lab_note', body: 'SECRET-LAB-NOTE' })).status, 201);
  assert.equal((await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/updates`, { kind: 'comment', body: 'a normal comment' })).status, 201);
  const rd = await get(tok.lead, p.id);
  assert.equal(rd.project.technical_approach, 'SECRET-APPROACH');
  assert.ok(rd.updates.some(u => u.kind === 'lab_note'));
  for (const who of ['purchase', 'qc', 'kannur']) {
    const d = await get(tok[who], p.id);
    assert.equal(d.status, 200, who);
    assert.ok(!('technical_approach' in d.project) && !('risks' in d.project), who + ': technical fields are omitted from the response');
    assert.ok(!d.updates.some(u => u.kind === 'lab_note'), who + ': lab notes are omitted');
    assert.ok(!JSON.stringify(d).includes('SECRET'), who + ': nothing confidential anywhere in the payload');
    assert.ok(d.updates.some(u => u.kind === 'comment'), who + ' still sees discussion');
  }
  assert.equal((await api(tok.purchase, 'POST', `/api/rd/projects/${p.id}/updates`, { kind: 'lab_note', body: 'x' })).status, 403);
  assert.equal((await api(tok.purchase, 'PUT', `/api/rd/projects/${p.id}/assessment`, { version: rd.project.version, technical_approach: 'x' })).status, 403, 'and cannot write it either');
  assert.equal((await api(tok.purchase, 'POST', `/api/rd/projects/${p.id}/updates`, { kind: 'comment', body: 'from purchase' })).status, 201, 'members can discuss');
  const audit = await pool.query("SELECT before_data, after_data FROM audit_log WHERE action = 'rd.assess' AND entity_id = $1 AND actor_id = $2 ORDER BY id DESC LIMIT 1", [p.id, uid.lead]);
  assert.ok(!JSON.stringify(audit.rows[0]).includes('SECRET'), 'the audit trail does not copy confidential text');
});

test('stage owner defaults to the lead; an explicit owner survives a change of lead', async () => {
  const p = await newProject(tok.kannur);
  let d = await get(tok.lead, p.id);
  assert.equal(d.stages[0].owner, null, 'no lead yet, no owner');
  await api(tok.lead, 'PUT', `/api/rd/projects/${p.id}/assessment`, { version: d.project.version, lead_user_id: uid.lead });
  d = await get(tok.lead, p.id);
  assert.deepEqual(d.stages[0].owner, { id: uid.lead, name: 'Test lead', explicit: false });
  const set = await api(tok.lead, 'PUT', `/api/rd/projects/${p.id}/stages/2`, { version: d.stages[1].version, owner_user_id: uid.rd2 });
  assert.equal(set.success, true);
  d = await get(tok.lead, p.id);
  await api(tok.lead, 'PUT', `/api/rd/projects/${p.id}/assessment`, { version: d.project.version, lead_user_id: uid.manager });
  d = await get(tok.lead, p.id);
  assert.equal(d.stages[0].owner.id, uid.manager, 'the default follows the new lead');
  assert.deepEqual(d.stages[1].owner, { id: uid.rd2, name: 'Test rd2', explicit: true }, 'an explicit assignment is preserved');
  assert.equal((await api(tok.lead, 'PUT', `/api/rd/projects/${p.id}/stages/2`, { version: d.stages[1].version, owner_user_id: null })).success, true);
  assert.equal((await get(tok.lead, p.id)).stages[1].owner.explicit, false, 'clearing it falls back to the lead');
});

test('auto-plan fills only empty dates, previews first, and dates come back exactly as sent', async () => {
  const p = await newProject(tok.kannur, { target_tbc: false, target_launch_date: '2030-01-01' });
  let d = await get(tok.lead, p.id);
  const entered = await api(tok.lead, 'PUT', `/api/rd/projects/${p.id}/stages/1`, { version: d.stages[0].version, planned_date: '2026-12-31' });
  assert.equal(entered.success, true);
  d = await get(tok.lead, p.id);
  assert.equal(d.stages[0].planned, '2026-12-31', 'no time-zone shift on a date at the end of a year');
  const preview = await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/auto-plan`, {});
  assert.equal(preview.applied, false); assert.equal(preview.basis, 'calendar days');
  assert.deepEqual(preview.proposals.map(x => x.no), [2, 3, 4, 5, 6, 7, 8], 'stage 1 was entered and is not touched');
  assert.equal(preview.proposals[0].planned, R.addDays('2026-12-31', 5), 'stage 2 starts from the entered stage-1 date');
  assert.equal((await get(tok.lead, p.id)).stages[1].planned, null, 'a preview writes nothing');
  const applied = await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/auto-plan`, { apply: true });
  assert.equal(applied.applied, true);
  d = await get(tok.lead, p.id);
  assert.equal(d.stages[0].planned, '2026-12-31'); assert.ok(d.stages.every(s => s.planned));
  assert.deepEqual((await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/auto-plan`, { apply: true })).proposals, [], 'a second run changes nothing');
  assert.ok(d.conflicts.some(c => c.type === 'launch') === false);
  const tight = await newProject(tok.kannur, { target_tbc: false, target_launch_date: R.addDays(R.todayIST(), 10) });
  await api(tok.lead, 'POST', `/api/rd/projects/${tight.id}/auto-plan`, { apply: true });
  assert.ok((await get(tok.lead, tight.id)).conflicts.some(c => c.type === 'launch'), 'a schedule that ends after the target is flagged');
  const bad = await api(tok.lead, 'PUT', `/api/rd/projects/${p.id}/stages/3`, { version: (await get(tok.lead, p.id)).stages[2].version, planned_date: '2026-02-30' });
  assert.equal(bad.status, 400, 'an impossible date is refused');
});

test('a changed trial duration is previewed and only applied when confirmed', async () => {
  const p = await newProject(tok.kannur);
  await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/auto-plan`, { apply: true });
  const before = await get(tok.lead, p.id);
  const set = await api(tok.lead, 'PUT', `/api/rd/projects/${p.id}/assessment`, { version: before.project.version, est_trial_days: 40 });
  assert.equal(set.replan_suggested, true);
  const mid = await get(tok.lead, p.id);
  assert.equal(mid.stages[2].days, 40, 'stage 3 now uses the estimate');
  assert.deepEqual(mid.stages.map(s => s.planned), before.stages.map(s => s.planned), 'dates are NOT rewritten silently');
  const prev = await api(tok.lead, 'GET', `/api/rd/projects/${p.id}/replan-preview`);
  assert.ok(prev.preview.length && prev.preview.some(x => x.changed));
  const apply = await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/replan`, { dates: prev.preview.map(x => ({ no: x.no, planned: x.proposed })) });
  assert.equal(apply.success, true);
  assert.notEqual((await get(tok.lead, p.id)).stages[2].planned, before.stages[2].planned);
  assert.equal((await api(tok.lead, 'PUT', `/api/rd/projects/${p.id}/assessment`, { version: mid.project.version + 1, est_trial_days: 0 })).status, 400);
});

test('stage completion needs the current stage, its checklist and its approvals, and a deliberate confirmation', async () => {
  const p = await newProject(tok.kannur);
  await api(tok.lead, 'PUT', `/api/rd/projects/${p.id}/assessment`, { version: (await get(tok.lead, p.id)).project.version, lead_user_id: uid.lead });
  const today = R.todayIST();
  const skip = await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/stages/3/complete`, { date: today, confirm: true });
  assert.equal(skip.status, 409, 'a stage cannot be skipped to');
  const empty = await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/stages/1/complete`, { date: today, confirm: true });
  assert.equal(empty.status, 422); assert.deepEqual(empty.missing, ['3 checklist items not done'], 'the missing conditions are named');
  const d = await get(tok.lead, p.id);
  for (const c of d.stages[0].checklist) await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/stages/1/checklist/${c.id}`, { done: true, result: 'Test result' });
  assert.equal((await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/stages/1/complete`, { date: today })).status, 400, 'no confirmation, no completion');
  assert.equal((await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/stages/1/complete`, { date: R.addDays(today, 1), confirm: true })).status, 400, 'a future date is refused');
  assert.equal((await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/stages/1/complete`, { confirm: true })).status, 400, 'a date is required');
  assert.equal((await api(tok.manager, 'POST', `/api/rd/projects/${p.id}/stages/1/complete`, { date: today, confirm: true })).status, 403, 'only people with the stage permission');
  const ok = await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/stages/1/complete`, { date: today, confirm: true });
  assert.equal(ok.success, true); assert.equal(ok.next_stage, 2);
  const burst = await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/stages/2/complete`, { date: today, confirm: true });
  assert.equal(burst.status, 422, 'the missing checklist is reported before anything else');
  const after = await get(tok.lead, p.id);
  assert.equal(after.stages[0].state, 'done'); assert.equal(after.stages[0].actual, today); assert.equal(after.stages[0].completed_by_name, 'Test lead'); assert.ok(after.stages[0].completed_at);
  assert.equal(after.stages[1].state, 'current'); assert.equal(after.next_step.stage, 2);
  assert.equal((await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/stages/2/complete`, { date: R.addDays(today, -3), confirm: true })).status, 400, 'not before the previous stage was completed');

  // stage 4 also needs QC sign-off, which the R&D role cannot give
  await completeStage(tok.lead, p.id, 2); await completeStage(tok.lead, p.id, 3);
  const noQc = await completeStage(tok.lead, p.id, 4);
  assert.equal(noQc.status, 422); assert.ok(noQc.missing.some(m => /QC sign-off/.test(m)));
  assert.equal((await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/approvals`, { kind: 'qc_signoff', decision: 'approved' })).status, 403, 'R&D cannot sign off for QC');
  assert.equal((await api(tok.admin, 'POST', `/api/rd/projects/${p.id}/approvals`, { kind: 'qc_signoff', decision: 'approved' })).status, 201);
  assert.equal((await completeStage(tok.lead, p.id, 4)).success, true, 'complete once the sign-off exists');
});

test('rapid or simultaneous clicks complete a stage once and never several stages', async () => {
  const p = await newProject(tok.kannur);
  await api(tok.lead, 'PUT', `/api/rd/projects/${p.id}/assessment`, { version: (await get(tok.lead, p.id)).project.version, lead_user_id: uid.lead });
  const d = await get(tok.lead, p.id);
  for (const no of [1, 2]) for (const c of d.stages[no - 1].checklist) await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/stages/${no}/checklist/${c.id}`, { done: true, result: 'Test result' });
  const today = R.todayIST();
  const shots = await Promise.all([
    ...Array.from({ length: 6 }, () => api(tok.lead, 'POST', `/api/rd/projects/${p.id}/stages/1/complete`, { date: today, confirm: true })),
    ...Array.from({ length: 3 }, () => api(tok.rd2, 'POST', `/api/rd/projects/${p.id}/stages/2/complete`, { date: today, confirm: true }))]);
  assert.equal(shots.filter(s => s.success).length, 1, 'exactly one request wins: ' + JSON.stringify(shots.map(s => s.status)));
  const after = await get(tok.lead, p.id);
  assert.equal(after.stages.filter(s => s.state === 'done').length, 1, 'one stage completed, not several');
  const next = await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/stages/2/complete`, { date: today, confirm: true });
  assert.equal(next.status, 409); assert.equal(next.cooldown, true, 'the next stage has to wait a few seconds even though it is ready');
  assert.ok(next.retry_after > 0 && next.retry_after <= R.STAGE_COOLDOWN_SECONDS);
  await pool.query("UPDATE rd_stages SET completed_at = completed_at - INTERVAL '1 minute' WHERE project_id = $1", [p.id]);
  assert.equal((await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/stages/2/complete`, { date: today, confirm: true })).success, true, 'and succeeds afterwards');
  const history = (await pool.query('SELECT COUNT(*)::int n FROM rd_stage_history h JOIN rd_stages s ON s.id = h.stage_id WHERE s.project_id = $1 AND s.stage_no = 1 AND h.action = $2', [p.id, 'completed'])).rows[0].n;
  assert.equal(history, 1, 'stage 1 has a single completion record');
  const again = await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/stages/1/complete`, { date: today, confirm: true });
  assert.equal(again.status, 409); assert.equal(again.already, true);
});

test('reopening keeps the history, flags later stages instead of clearing them, and blocks completion until reviewed', async () => {
  const p = await newProject(tok.kannur);
  await api(tok.lead, 'PUT', `/api/rd/projects/${p.id}/assessment`, { version: (await get(tok.lead, p.id)).project.version, lead_user_id: uid.lead });
  for (const no of [1, 2, 3]) assert.equal((await completeStage(tok.lead, p.id, no)).success, true);
  assert.equal((await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/stages/2/reopen`, {})).status, 400, 'a reason is required');
  assert.equal((await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/stages/4/reopen`, { reason: 'x' })).status, 409, 'only a completed stage can be reopened');
  const r = await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/stages/2/reopen`, { reason: 'Viscosity result was entered wrongly' });
  assert.equal(r.success, true); assert.deepEqual(r.affected_later_stages, [3], 'the effect on later work is stated');
  const d = await get(tok.lead, p.id);
  assert.equal(d.stages[1].state, 'current', 'the reopened stage is current again');
  assert.equal(d.stages[2].state, 'done', 'the later stage was NOT cleared');
  assert.match(d.stages[2].review_flag, /Stage 2 was reopened/);
  const hist = (await pool.query("SELECT h.action, h.reason FROM rd_stage_history h JOIN rd_stages s ON s.id = h.stage_id WHERE s.project_id = $1 AND s.stage_no = 2 ORDER BY h.id", [p.id])).rows;
  assert.deepEqual(hist.map(h => h.action), ['completed', 'reopened']); assert.match(hist[1].reason, /Viscosity/);
  assert.ok(d.updates.some(u => /reopened/.test(u.body)), 'the activity history records it');
  assert.equal((await completeStage(tok.lead, p.id, 2)).success, true, 'it can be completed again');
  const hist2 = (await pool.query("SELECT COUNT(*)::int n FROM rd_stage_history h JOIN rd_stages s ON s.id = h.stage_id WHERE s.project_id = $1 AND s.stage_no = 2", [p.id])).rows[0].n;
  assert.equal(hist2, 3, 'completed, reopened, completed: nothing was overwritten');
  assert.equal((await get(tok.lead, p.id)).stages[2].review_flag !== null, true, 'the flag stays until somebody reviews stage 3');
  assert.equal((await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/complete`, { confirm: true })).status, 422);
});

test('approvals: a project is completed only after every stage; the person recorded is always the signed-in one', async () => {
  const p = await newProject(tok.kannur);
  await api(tok.lead, 'PUT', `/api/rd/projects/${p.id}/assessment`, { version: (await get(tok.lead, p.id)).project.version, lead_user_id: uid.lead });
  assert.equal((await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/approvals`, { kind: 'management', decision: 'approved' })).status, 403, 'nobody holds management approval by default');
  assert.equal((await api(tok.admin, 'POST', `/api/rd/projects/${p.id}/approvals`, { kind: 'management', decision: 'approved', decided_by: uid.lead })).status, 201);
  assert.equal((await api(tok.admin, 'POST', `/api/rd/projects/${p.id}/approvals`, { kind: 'rd_head', decision: 'rejected' })).status, 400, 'a rejection needs remarks');
  assert.equal((await api(tok.admin, 'POST', `/api/rd/projects/${p.id}/approvals`, { kind: 'submission', decision: 'approved' })).status, 400, 'submission is recorded by the system only');
  let d = await get(tok.admin, p.id);
  assert.equal(d.approvals.find(a => a.kind === 'management').decided_by, uid.admin, 'a typed approver is ignored');
  const noRep = await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/approvals`, { kind: 'customer', decision: 'approved' });
  assert.equal(noRep.status, 400, 'customer approval needs the representative and the evidence');
  const cust = await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/approvals`, { kind: 'customer', decision: 'approved', external_rep: 'A. Customer', evidence: 'E-mail 12-11-2026', decision_date: R.todayIST() });
  assert.equal(cust.status, 201);
  d = await get(tok.lead, p.id);
  const c = d.approvals.find(a => a.kind === 'customer');
  assert.equal(c.external_rep, 'A. Customer'); assert.equal(c.decided_by, uid.lead, 'the internal person who recorded it'); assert.equal(c.stage_no, 6);
  assert.equal((await api(tok.admin, 'POST', `/api/rd/projects/${p.id}/approvals`, { kind: 'qc_signoff', decision: 'approved' })).status, 201);
  assert.equal((await api(tok.admin, 'POST', `/api/rd/projects/${p.id}/approvals`, { kind: 'handover_ack', decision: 'approved' })).status, 201);
  assert.equal((await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/complete`, { confirm: true })).status, 422, 'not before every stage');
  for (let no = 1; no <= 8; no++) assert.equal((await completeStage(tok.lead, p.id, no)).success, true, 'stage ' + no);
  const dd = await get(tok.lead, p.id);
  assert.equal(dd.progress.done, 8); assert.equal(dd.next_step, null);
  assert.equal((await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/complete`, {})).status, 400, 'confirmation required');
  const done = await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/complete`, { confirm: true, version: dd.project.version });
  assert.equal(done.success, true); assert.equal(done.completed_on, R.todayIST());
  const fin = await get(tok.lead, p.id);
  assert.equal(fin.project.status, 'Completed'); assert.equal(fin.project.completed_on, R.todayIST());
  assert.equal((await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/stages/8/reopen`, { reason: 'x' })).status, 409, 'a completed project must change status first');
});

test('statuses: On Hold is paused, completion has its own path, and "active" is one definition everywhere', async () => {
  const p = await newProject(tok.kannur);
  let d = await get(tok.lead, p.id);
  assert.equal((await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/status`, { status: 'Completed', version: d.project.version })).status, 400);
  assert.equal((await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/status`, { status: 'On Hold', version: d.project.version })).status, 400, 'pausing needs a reason');
  assert.equal((await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/status`, { status: 'In Lab Trials', version: d.project.version })).success, true);
  d = await get(tok.lead, p.id);
  assert.equal((await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/status`, { status: 'On Hold', reason: 'Waiting for samples', version: d.project.version })).success, true);
  const act = await api(tok.lead, 'GET', '/api/rd/projects?scope=active'); const hold = await api(tok.lead, 'GET', '/api/rd/projects?scope=hold');
  assert.ok(!act.projects.some(x => x.id === p.id) && hold.projects.some(x => x.id === p.id), 'on hold is not active');
  assert.ok(act.projects.every(x => R.ACTIVE_STATUSES.includes(x.status)));
  d = await get(tok.lead, p.id);
  assert.equal((await completeStage(tok.lead, p.id, 1)).status, 409, 'a project on hold cannot have stages completed');
  assert.equal(d.project.status_before_hold, 'In Lab Trials');
});

test('concurrent edits are version-checked and unrelated work is preserved', async () => {
  const p = await newProject(tok.kannur);
  const d = await get(tok.lead, p.id);
  const v = d.project.version;
  const a = await api(tok.lead, 'PATCH', `/api/rd/projects/${p.id}`, { version: v, brand_product: 'HERAKLEON' });
  const b = await api(tok.rd2, 'PATCH', `/api/rd/projects/${p.id}`, { version: v, benchmark: '3M' });
  assert.equal(a.success, true); assert.equal(b.status, 409, 'the second editor is told, not silently overwritten');
  assert.equal(b.current_version, v + 1);
  const retry = await api(tok.rd2, 'PATCH', `/api/rd/projects/${p.id}`, { version: v + 1, benchmark: '3M' });
  assert.equal(retry.success, true);
  const after = await get(tok.lead, p.id);
  assert.equal(after.project.brand_product, 'HERAKLEON'); assert.equal(after.project.benchmark, '3M', 'both changes survive');
  // simultaneous: only one of two edits made against the same version can win
  const v2 = after.project.version;
  const race = await Promise.all([api(tok.lead, 'PATCH', `/api/rd/projects/${p.id}`, { version: v2, substrate: 'bare metal' }), api(tok.rd2, 'PATCH', `/api/rd/projects/${p.id}`, { version: v2, end_user_market: 'detailing shops' })]);
  assert.equal(race.filter(r => r.success).length, 1, JSON.stringify(race.map(r => r.status)));
  // a stage edit and a task edit do not touch the project version or each other
  const t = await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/tasks`, { title: 'Order samples', assignee_id: uid.lead, due_date: '2026-12-01' });
  assert.equal(t.status, 201);
  assert.equal((await api(tok.lead, 'PUT', `/api/rd/projects/${p.id}/stages/1`, { version: after.stages[0].version, remarks: 'in progress' })).success, true);
  assert.equal((await get(tok.lead, p.id)).tasks.length, 1);
  assert.equal((await api(tok.kannur, 'PATCH', `/api/rd/projects/${p.id}`, { version: v2 + 5, title: 'x' })).status, 403, 'a requester cannot edit a submitted project');
});

test('tasks: one accountable person, independent of stage completion, version-checked; status updates by the assignee', async () => {
  const p = await newProject(tok.kannur);
  const mk = await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/tasks`, { title: 'Test adhesion', assignee_id: uid.rd2, due_date: R.todayIST(), priority: 'High', stage_no: 4 });
  assert.equal(mk.status, 201);
  assert.equal((await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/tasks`, { title: 'Quote for resin', team: 'Purchase' })).status, 400, 'a new task needs an owner and a due date');
  assert.equal((await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/tasks`, { title: 'No date', assignee_id: uid.rd2 })).status, 400, 'a due date is required too');
  // a task created before owners were required can still be an unclaimed team task
  await pool.query("INSERT INTO rd_tasks (project_id, title, team, created_by) VALUES ($1, 'Quote for resin', 'Purchase', $2)", [p.id, uid.lead]);
  let d = await get(tok.lead, p.id);
  const task = d.tasks.find(t => t.title === 'Test adhesion'), unclaimed = d.tasks.find(t => t.title === 'Quote for resin');
  assert.equal(task.assignee_id, uid.rd2); assert.equal(unclaimed.assignee_id, null); assert.equal(unclaimed.team, 'Purchase', 'an unclaimed team task is explicit');
  assert.equal((await api(tok.kannur, 'PATCH', '/api/rd/tasks/' + task.id, { version: task.version, status: 'done' })).status, 403, 'someone else cannot');
  const mine = await api(tok.rd2, 'PATCH', '/api/rd/tasks/' + task.id, { version: task.version, status: 'in_progress' });
  assert.equal(mine.success, true, 'the assignee may update their own status');
  assert.equal((await api(tok.rd2, 'POST', '/api/rd/tasks/' + task.id + '/complete', { version: task.version, result: 'Adhesion tested at 5 N.' })).status, 409, 'a stale version is refused');
  // a department member who is only an assignee may update status, nothing else
  await api(tok.lead, 'PUT', `/api/rd/projects/${p.id}/assessment`, { version: d.project.version, members: [uid.purchase] });
  const claim = await api(tok.lead, 'PATCH', '/api/rd/tasks/' + unclaimed.id, { version: unclaimed.version, assignee_id: uid.purchase });
  assert.equal(claim.success, true);
  assert.equal((await api(tok.purchase, 'PATCH', '/api/rd/tasks/' + unclaimed.id, { version: unclaimed.version + 1, title: 'renamed' })).status, 403, 'an assignee without edit rights cannot change anything but status');
  assert.equal((await api(tok.purchase, 'PATCH', '/api/rd/tasks/' + unclaimed.id, { version: unclaimed.version + 1, status: 'in_progress' })).success, true);
  d = await get(tok.lead, p.id);
  assert.equal(d.tasks.find(t => t.id === unclaimed.id).team, null, 'claiming removes the unclaimed marker');
  assert.equal((await api(tok.rd2, 'PATCH', '/api/rd/tasks/' + task.id, { version: task.version + 1, title: 'renamed by R&D' })).success, true, 'R&D staff with edit rights can edit it');
  assert.equal((await api(tok.rd2, 'POST', '/api/rd/tasks/' + task.id + '/complete', { version: task.version + 2, result: 'Adhesion passed at 5 N on three panels.' })).success, true);
  d = await get(tok.lead, p.id);
  const fin = d.tasks.find(t => t.id === task.id);
  assert.equal(fin.status, 'done'); assert.ok(fin.completed_at); assert.equal(fin.result, 'Adhesion passed at 5 N on three panels.'); assert.ok(fin.completed_by_name);
  assert.equal(d.stages[3].state, 'pending', 'finishing the stage-4 task does not complete stage 4 or bypass QC sign-off');
  assert.equal((await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/tasks`, { title: 'x', due_date: '31-12-2026' })).status, 400);
});

test('task results: a task is completed only with a result, by the right person, locked afterwards, and reopened only with a reason', async () => {
  const p = await newProject(tok.kannur);
  const mkTask = async (title, who, due) => (await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/tasks`, { title, assignee_id: uid[who], due_date: due || R.todayIST() })).id;
  const id = await mkTask('Send samples to customer', 'rd2');
  const one = async () => (await get(tok.lead, p.id)).tasks.find(t => t.id === id);
  const complete = (who, body) => api(tok[who], 'POST', `/api/rd/tasks/${id}/complete`, body);
  // the status route can no longer close a task
  assert.equal((await api(tok.rd2, 'PATCH', '/api/rd/tasks/' + id, { version: (await one()).version, status: 'done' })).status, 400, 'a task cannot be marked done without a result');
  assert.equal((await one()).status, 'todo');
  // a result is required, and long enough to say something
  assert.equal((await complete('rd2', { version: (await one()).version })).status, 400, 'no result');
  assert.equal((await complete('rd2', { result: 'ok' })).status, 400, 'too short to count');
  assert.equal((await complete('rd2', { result: 'x'.repeat(R.MAX_RESULT_LENGTH + 1) })).status, 400, 'too long');
  // only the person responsible, or R&D with edit rights
  assert.equal((await complete('manager', { result: 'I finished this one today.' })).status, 403, 'a view-only manager cannot complete it');
  assert.equal((await complete('kannur', { result: 'I finished this one today.' })).status, 403, 'the requester cannot either');
  assert.equal((await one()).status, 'todo', 'refused attempts change nothing');
  const ok = await complete('rd2', { version: (await one()).version, result: 'Samples dispatched by courier, tracking ABC123.' });
  assert.equal(ok.success, true);
  let t = await one();
  assert.equal(t.status, 'done'); assert.equal(t.result, 'Samples dispatched by courier, tracking ABC123.'); assert.ok(t.completed_at && t.completed_by_name);
  // anyone who can open the project sees the result (it is not lab content)
  assert.equal((await get(tok.manager, p.id)).tasks.find(x => x.id === id).result, t.result, 'project viewers see the result');
  // locked once complete
  assert.equal((await api(tok.lead, 'PATCH', '/api/rd/tasks/' + id, { version: t.version, title: 'sneaky rename' })).status, 409, 'a completed task cannot be edited');
  assert.equal((await complete('rd2', { result: 'Completing it a second time.' })).status, 409, 'nor completed twice');
  // reopening: edit rights and a reason, and the old result stays in the history
  assert.equal((await api(tok.rd2, 'POST', `/api/rd/tasks/${id}/reopen`, { reason: 'Wrong address' })).status, 200, 'R&D with edit rights can reopen');
  assert.equal(((await one()).status), 'in_progress'); assert.equal((await one()).result, null);
  assert.equal((await complete('rd2', { result: 'Re-sent to the right address.' })).success, true);
  assert.equal((await api(tok.lead, 'POST', `/api/rd/tasks/${id}/reopen`, {})).status, 400, 'a reason is required');
  assert.equal((await api(tok.manager, 'POST', `/api/rd/tasks/${id}/reopen`, { reason: 'because' })).status, 403, 'a view-only manager cannot reopen');
  const hist = (await pool.query('SELECT action, result, reason FROM rd_task_history WHERE task_id = $1 ORDER BY id', [id])).rows;
  assert.deepEqual(hist.map(h => h.action), ['completed', 'reopened', 'completed']);
  assert.equal(hist[1].result, 'Samples dispatched by courier, tracking ABC123.', 'the first result is kept when the task is reopened');
  assert.equal(hist[1].reason, 'Wrong address');
  // the audit trail says what happened, not what was written
  const log = JSON.stringify((await pool.query("SELECT summary, before_data, after_data FROM audit_log WHERE entity = 'rd_task' AND entity_id = $1", [id])).rows);
  assert.ok(log.includes('completed') && !log.includes('tracking ABC123'), 'the result text is not copied into the audit log');
});

test('splitting a stage: a task is tied to a checklist item, a trainee\'s work is reviewed by someone else, and the stage cannot close over open work', async () => {
  const p = await newProject(tok.kannur);
  await api(tok.lead, 'PUT', `/api/rd/projects/${p.id}/assessment`, { version: (await get(tok.lead, p.id)).project.version, lead_user_id: uid.lead });
  const today = R.todayIST();
  const detail = async (who) => get(tok[who || 'lead'], p.id);
  const stage1 = async () => (await detail()).stages[0];
  const item0 = (await stage1()).checklist[0], item2 = (await detail()).stages[1].checklist[0];
  const mk = (body, who) => api(tok[who || 'lead'], 'POST', `/api/rd/projects/${p.id}/tasks`, { due_date: today, ...body });
  // a task can be tied to a checklist item, but only of its own stage
  assert.equal((await mk({ title: 'bad link', assignee_id: uid.trainee, stage_no: 1, checklist_item_id: item2.id })).status, 400, 'an item of another stage is refused');
  assert.equal((await mk({ title: 'no stage', assignee_id: uid.trainee, checklist_item_id: item0.id })).status, 400, 'an item needs its stage');
  const a = await mk({ title: 'Measure viscosity of batch 1', assignee_id: uid.trainee, stage_no: 1, checklist_item_id: item0.id, description: 'Use the Brookfield, 25C' });
  assert.equal(a.status, 201);
  const A = async () => (await detail()).tasks.find(t => t.id === a.id);
  assert.equal((await A()).requires_review, true, 'a trainee\'s work is always reviewed');
  assert.equal((await A()).checklist_label, item0.label);
  const withPeer = await mk({ title: 'Peer task', assignee_id: uid.rd2, stage_no: 1 }); assert.equal((await detail()).tasks.find(t => t.id === withPeer.id).requires_review, false, 'for others, review is the assigner\'s choice');
  const asked = await mk({ title: 'Checked peer task', assignee_id: uid.rd2, stage_no: 1, requires_review: true }); assert.equal((await detail()).tasks.find(t => t.id === asked.id).requires_review, true);
  // the person doing the work joins the team, so they can open the project; they get no edit rights
  assert.equal((await detail('trainee')).project.id, p.id, 'the trainee can open the project they were given work on');
  const lead = await detail('lead'); assert.equal(lead.stages[0].work.total, 3); assert.deepEqual(lead.stages[0].work.people.sort(), ['Test rd2', 'Test trainee'].sort());
  const tr = await detail('trainee');
  assert.equal(tr.can.edit, false); assert.equal(tr.can.stage, false); assert.equal(tr.can.technical, false);
  assert.equal((await api(tok.trainee, 'POST', `/api/rd/projects/${p.id}/tasks`, { title: 'x', assignee_id: uid.trainee, due_date: today })).status, 403, 'a trainee cannot assign work');
  assert.equal((await api(tok.trainee, 'POST', `/api/rd/projects/${p.id}/stages/1/checklist/${item0.id}`, { done: true, result: 'tick' })).status, 403, 'a trainee cannot tick the checklist');
  assert.equal((await api(tok.trainee, 'POST', '/api/rd/projects', valid())).status, 403, 'nor raise a request');
  assert.equal((await api(tok.trainee, 'POST', `/api/rd/projects/${p.id}/stages/1/complete`, { date: today, confirm: true })).status, 403, 'nor complete a stage');
  // confidential lab results are not shown to a trainee
  await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/stages/1/checklist/${item0.id}`, { done: true, result: 'SECRETFORMULA-' + TAG });
  assert.ok(!JSON.stringify(await detail('trainee')).includes('SECRETFORMULA'), 'the confidential result is not in the trainee\'s response');
  await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/stages/1/checklist/${item0.id}`, { done: false });
  // submit: the trainee's completion waits for review instead of closing the task
  const sub = await api(tok.trainee, 'POST', `/api/rd/tasks/${a.id}/complete`, { version: (await A()).version, result: 'Viscosity 92 KU at 25C, two readings.' });
  assert.equal(sub.success, true); assert.equal(sub.task_status, 'in_review');
  assert.equal((await A()).status, 'in_review');
  assert.equal((await api(tok.trainee, 'PATCH', '/api/rd/tasks/' + a.id, { version: (await A()).version, status: 'in_progress' })).status, 409, 'work in review is locked');
  assert.equal((await api(tok.trainee, 'POST', `/api/rd/tasks/${a.id}/accept`, {})).status, 403, 'nobody accepts their own work');
  assert.equal((await api(tok.trainee, 'POST', `/api/rd/tasks/${a.id}/send-back`, { note: 'x' })).status, 403);
  assert.equal((await api(tok.manager, 'POST', `/api/rd/tasks/${a.id}/accept`, {})).status, 403, 'a view-only person cannot review');
  // the owner sees it to review, the trainee sees it as submitted, and it is not "late" or "open work" while waiting
  const myDay = await api(tok.lead, 'GET', '/api/rd/my-day'); assert.ok(myDay.to_review.some(x => x.id === a.id && x.result && x.checklist_label), 'owner: to review, with the result and the item it belongs to');
  assert.ok(!myDay.assigned.some(x => x.id === a.id), 'not double-listed as waiting on others');
  const tDay = await api(tok.trainee, 'GET', '/api/rd/my-day'); assert.ok(tDay.submitted.some(x => x.id === a.id) && !tDay.mine.some(x => x.id === a.id), 'trainee: submitted, not open');
  // send back with a comment: the trainee does it again
  assert.equal((await api(tok.lead, 'POST', `/api/rd/tasks/${a.id}/send-back`, {})).status, 400, 'a comment is required');
  assert.equal((await api(tok.lead, 'POST', `/api/rd/tasks/${a.id}/send-back`, { note: 'Please repeat at 20C too.' })).success, true);
  let t = await A(); assert.equal(t.status, 'in_progress'); assert.equal(t.review_note, 'Please repeat at 20C too.'); assert.equal(t.result, null);
  assert.equal((await api(tok.trainee, 'POST', `/api/rd/tasks/${a.id}/complete`, { result: 'Viscosity 92 KU at 25C and 95 KU at 20C.' })).status, 200);
  // the stage cannot close while assigned work is open
  for (const c of (await stage1()).checklist) await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/stages/1/checklist/${c.id}`, { done: true, result: 'Done as written.' });
  assert.ok((await stage1()).missing.some(m => /assigned task/.test(m)), 'the page says what is still open');
  const blocked = await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/stages/1/complete`, { date: today, confirm: true });
  assert.equal(blocked.status, 422); assert.ok(blocked.missing.some(m => /3 assigned tasks not finished/.test(m)), 'review, peer and checked-peer tasks all count: ' + JSON.stringify(blocked.missing));
  // accept, cancel (a reason is needed, and only R&D with edit rights), then the stage closes
  assert.equal((await api(tok.lead, 'POST', `/api/rd/tasks/${a.id}/accept`, { note: 'Good.' })).success, true);
  t = await A(); assert.equal(t.status, 'done'); assert.equal(t.reviewed_by_name, 'Test lead'); assert.equal(t.completed_by_name, 'Test trainee', 'the record names who did the work and who checked it');
  assert.equal((await api(tok.trainee, 'POST', `/api/rd/tasks/${withPeer.id}/cancel`, { reason: 'x' })).status, 403);
  assert.equal((await api(tok.lead, 'POST', `/api/rd/tasks/${withPeer.id}/cancel`, {})).status, 400, 'a reason is required');
  assert.equal((await api(tok.lead, 'POST', `/api/rd/tasks/${withPeer.id}/cancel`, { reason: 'No longer needed' })).success, true);
  assert.equal((await api(tok.rd2, 'POST', `/api/rd/tasks/${asked.id}/complete`, { result: 'Checked the peer sample.' })).status, 200, 'an R&D peer\'s reviewed task is also submitted');
  assert.equal((await api(tok.lead, 'POST', `/api/rd/tasks/${asked.id}/accept`, {})).success, true);
  const work = (await stage1()).work; assert.equal(work.total, 2, 'a cancelled task leaves the totals'); assert.equal(work.done, 2);
  assert.equal((await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/stages/1/complete`, { date: today, confirm: true })).success, true, 'with the work finished the stage can close');
  const hist = (await pool.query('SELECT action FROM rd_task_history WHERE task_id = $1 ORDER BY id', [a.id])).rows.map(r => r.action);
  assert.deepEqual(hist, ['submitted', 'sent_back', 'submitted', 'accepted'], 'the whole review conversation is kept');
  // a cancelled task can be reopened by R&D with a reason
  assert.equal((await api(tok.lead, 'POST', `/api/rd/tasks/${withPeer.id}/reopen`, { reason: 'It is needed after all' })).success, true);
  assert.equal((await detail()).tasks.find(x => x.id === withPeer.id).status, 'todo');
});

test('result forms: the owner chooses what comes back, the assignee fills exactly that, answers are checked, and out of range is flagged not blocked', async () => {
  const p = await newProject(tok.kannur);
  await api(tok.lead, 'PUT', `/api/rd/projects/${p.id}/assessment`, { version: (await get(tok.lead, p.id)).project.version, lead_user_id: uid.lead });
  const today = R.todayIST(), SAMPLE = 'SAMPLE-' + TAG;
  const meta = await api(tok.lead, 'GET', '/api/rd/meta');
  const tpl = meta.form_templates.find(t => t.id === 'viscosity'); assert.ok(meta.form_templates.length >= 7, 'the starter forms are offered');
  const schema = { ...tpl, fields: tpl.fields.map(f => f.key === 'viscosity' ? { ...f, min: 90, max: 95 } : f) };     // the owner sets the expected range
  const mk = (body) => api(tok.lead, 'POST', `/api/rd/projects/${p.id}/tasks`, { due_date: today, stage_no: 2, ...body });
  assert.equal((await mk({ title: 'bad', assignee_id: uid.trainee, result_schema: { kind: 'form', fields: [] } })).status, 400, 'an empty form is refused');
  assert.equal((await mk({ title: 'bad', assignee_id: uid.trainee, result_schema: { fields: [{ label: 'x', type: 'banana' }] } })).status, 400, 'an unknown field type is refused');
  const a = await mk({ title: 'Measure viscosity of batch 7', assignee_id: uid.trainee, result_schema: schema }); assert.equal(a.status, 201);
  const A = async (who) => (await get(tok[who || 'lead'], p.id)).tasks.find(t => t.id === a.id);
  assert.equal((await A()).result_schema.name, 'Viscosity check'); assert.equal((await A('trainee')).result_schema.fields.length, 5, 'the assignee sees the same form');
  // the form travels with the task: it cannot be swapped afterwards
  await api(tok.lead, 'PATCH', '/api/rd/tasks/' + a.id, { version: (await A()).version, title: 'Measure viscosity of batch 7', result_schema: { kind: 'form', fields: [{ label: 'Anything', type: 'text' }] } });
  assert.equal((await A()).result_schema.name, 'Viscosity check', 'the form is fixed when the task is assigned');
  const done = (body) => api(tok.trainee, 'POST', `/api/rd/tasks/${a.id}/complete`, body);
  const good = { viscosity: 98, viscosity_unit: 'KU', temperature: 25, spindle: '64', sample: SAMPLE };
  assert.equal((await done({ result: 'Free text is not accepted when a form was asked for.' })).status, 400, 'free text does not replace the form');
  assert.match((await done({ data: { ...good, sample: '' } })).error, /Sample or batch no\. is required/);
  assert.match((await done({ data: { ...good, viscosity: 'lots' } })).error, /Viscosity must be a number/);
  assert.match((await done({ data: { ...good, viscosity_unit: 'bar' } })).error, /choose one of KU, cP, s/);
  assert.equal((await A()).status, 'todo', 'a refused hand-in changes nothing');
  // out of range is allowed and flagged
  const sub = await done({ data: good, version: (await A()).version }); assert.equal(sub.success, true); assert.equal(sub.task_status, 'in_review');
  let t = await A();
  assert.equal(t.result_data.viscosity, 98); assert.equal(t.range_flags.viscosity, 'above'); assert.match(t.result, /Viscosity: 98 KU \(outside the expected 90 to 95\)/); assert.match(t.result, new RegExp(SAMPLE));
  const day = await api(tok.lead, 'GET', '/api/rd/my-day'); const rv = day.to_review.find(x => x.id === a.id);
  assert.ok(rv && rv.result_schema && rv.range_flags.viscosity === 'above', 'the reviewer is shown the form, the answers and the flag');
  assert.ok(rv.description !== undefined, 'My Day carries the instructions');
  // send back clears the answers; a corrected hand-in is within range; accept keeps the structured answers
  assert.equal((await api(tok.lead, 'POST', `/api/rd/tasks/${a.id}/send-back`, { note: 'Repeat the reading.' })).success, true);
  assert.equal((await A()).result_data, null);
  assert.equal((await done({ data: { ...good, viscosity: 92 } })).success, true);
  assert.equal((await api(tok.lead, 'POST', `/api/rd/tasks/${a.id}/accept`, {})).success, true);
  t = await A(); assert.equal(t.status, 'done'); assert.equal(t.range_flags.viscosity, 'within'); assert.equal(t.result_data.sample, SAMPLE);
  // a checklist: every required step must be ticked
  const cl = await mk({ title: 'Prepare the batch', assignee_id: uid.rd2, result_schema: { kind: 'checklist', name: 'Batch prep', items: ['Weigh resin', 'Mix for 10 minutes', { label: 'Photograph the batch', required: false }] } });
  assert.equal(cl.status, 201);
  const cdone = (data) => api(tok.rd2, 'POST', `/api/rd/tasks/${cl.id}/complete`, { data });
  assert.match((await cdone({ items: { weigh_resin: true } })).error, /Tick "Mix for 10 minutes"/);
  assert.equal((await cdone({ items: { weigh_resin: true, mix_for_10_minutes: true }, note: 'Batch looked normal.' })).success, true);
  const ct = (await get(tok.lead, p.id)).tasks.find(x => x.id === cl.id);
  assert.equal(ct.status, 'done'); assert.match(ct.result, /\[x\] Weigh resin/); assert.match(ct.result, /\[ \] Photograph the batch/); assert.match(ct.result, /Note: Batch looked normal\./);
  // a task with no form still takes free text
  const free = await mk({ title: 'Quick check', assignee_id: uid.rd2 }); assert.equal((await get(tok.lead, p.id)).tasks.find(x => x.id === free.id).result_schema, null);
  assert.equal((await api(tok.rd2, 'POST', `/api/rd/tasks/${free.id}/complete`, { result: 'Done and it looked fine to me.' })).success, true);
  // the answers are not copied into the audit log
  const log = JSON.stringify((await pool.query("SELECT summary, before_data, after_data FROM audit_log WHERE entity = 'rd_task' AND entity_id = $1", [a.id])).rows);
  assert.ok(!log.includes(SAMPLE), 'the answers are not in the audit log');
});

test('notices: people are told about new tasks, work to review and work sent back, and each notice goes away once the step is taken', async () => {
  const p = await newProject(tok.kannur);
  await api(tok.lead, 'PUT', `/api/rd/projects/${p.id}/assessment`, { version: (await get(tok.lead, p.id)).project.version, lead_user_id: uid.lead });
  const tomorrow = R.addDays(R.todayIST(), 2), TITLE = 'Notice task ' + TAG;
  const notes = async (who) => (await api(tok[who], 'GET', '/api/workspace/notifications')).notifications || [];
  const has = async (who, type) => (await notes(who)).some(n => n.type === type && n.text.includes(TITLE));
  const mk = await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/tasks`, { title: TITLE, assignee_id: uid.trainee, due_date: tomorrow, stage_no: 1 });
  assert.equal(mk.status, 201);
  assert.equal(await has('trainee', 'New task'), true, 'the person given a task is told, even before it is due');
  assert.equal(await has('lead', 'New task'), false, 'the person who assigned it is not told about their own task');
  assert.equal(await has('purchase', 'New task'), false, 'and nobody else is');
  // handing it in tells the owner, and clears the trainee\'s notice
  assert.equal((await api(tok.trainee, 'POST', `/api/rd/tasks/${mk.id}/complete`, { result: 'Done and written up in full detail.' })).task_status, 'in_review');
  assert.equal(await has('lead', 'Work to review'), true, 'the owner is told there is work to check');
  assert.equal(await has('trainee', 'Work to review'), false, 'the person who did the work is not asked to review it');
  assert.equal(await has('trainee', 'New task'), false, 'a task that has been handed in is no longer "new"');
  // sending it back tells the trainee, with the reason
  assert.equal((await api(tok.lead, 'POST', `/api/rd/tasks/${mk.id}/send-back`, { note: 'Add the batch number.' })).success, true);
  assert.equal(await has('lead', 'Work to review'), false, 'the review notice is gone once it is sent back');
  const back = (await notes('trainee')).find(n => n.type === 'Sent back' && n.text.includes(TITLE));
  assert.ok(back && /Add the batch number/.test(back.text), 'the trainee is told what to change');
  // resubmit and accept: every notice disappears
  assert.equal((await api(tok.trainee, 'POST', `/api/rd/tasks/${mk.id}/complete`, { result: 'Added the batch number B-22.' })).success, true);
  assert.equal(await has('trainee', 'Sent back'), false);
  assert.equal((await api(tok.lead, 'POST', `/api/rd/tasks/${mk.id}/accept`, {})).success, true);
  assert.equal(await has('lead', 'Work to review'), false, 'nothing is left waiting once the work is accepted');
});

test('team performance: numbers come from the records, bands follow the targets, nobody is ranked, and who may see what is enforced', async () => {
  tok.kpi1 = await mkUser('kpi1', ['rd']); tok.kpi2 = await mkUser('kpi2', ['rd_trainee']); tok.kpi3 = await mkUser('kpi3', ['rd']);
  const p = await newProject(tok.kannur);
  await api(tok.lead, 'PUT', `/api/rd/projects/${p.id}/assessment`, { version: (await get(tok.lead, p.id)).project.version, lead_user_id: uid.kpi3 });
  const today = R.todayIST(), plus = (n) => R.addDays(today, n), range = `from=${plus(-30)}&to=${today}`;
  const mk = async (title, who, due) => (await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/tasks`, { title, assignee_id: uid[who], due_date: due })).id;
  // kpi1: two finished (one on time, one a day late) and two still open (one of them overdue)
  const t1 = await mk('KPI on time', 'kpi1', plus(2)), t2 = await mk('KPI late', 'kpi1', plus(-1)); await mk('KPI open later', 'kpi1', plus(5)); await mk('KPI open overdue', 'kpi1', plus(-3));
  for (const t of [t1, t2]) assert.equal((await api(tok.kpi1, 'POST', `/api/rd/tasks/${t}/complete`, { result: 'Finished and written up properly.' })).success, true);
  // kpi2 is a trainee, so everything is reviewed (by kpi3): one task is sent back once, the other is right first time
  const a = await mk('KPI reviewed A', 'kpi2', plus(1)), b = await mk('KPI reviewed B', 'kpi2', plus(1));
  const submit = (id) => api(tok.kpi2, 'POST', `/api/rd/tasks/${id}/complete`, { result: 'Handed in with the full details.' });
  await submit(a); await api(tok.kpi3, 'POST', `/api/rd/tasks/${a}/send-back`, { note: 'Add the batch number.' }); await submit(a); await api(tok.kpi3, 'POST', `/api/rd/tasks/${a}/accept`, {});
  await submit(b); await api(tok.kpi3, 'POST', `/api/rd/tasks/${b}/accept`, {});
  // a stage kpi3 owns, planned for yesterday and finished today
  await pool.query('UPDATE rd_stages SET planned_date = $1 WHERE project_id = $2 AND stage_no = 1', [plus(-1), p.id]);
  assert.equal((await completeStage(tok.lead, p.id, 1)).success, true);

  const list = await api(tok.manager, 'GET', `/api/kpi/rd?${range}`);
  assert.equal(list.success, true); const P = (n) => list.people.find(x => x.id === uid[n]);
  const k1 = P('kpi1');
  assert.deepEqual([k1.tasks.completed, k1.tasks.with_due, k1.tasks.on_time, k1.tasks.on_time_rate, k1.tasks.avg_days_late, k1.tasks.open_now, k1.tasks.overdue_now], [2, 2, 1, 50, 1, 2, 1], 'completed, on time, late, and what is still open');
  assert.equal(k1.bands.on_time, 'red', '50% on time is below the amber line'); assert.equal(k1.bands.overdue, 'amber', 'one overdue task is amber'); assert.equal(k1.few.on_time, true, 'two items is too few to mean much');
  const k2 = P('kpi2'); assert.deepEqual([k2.review.accepted, k2.review.first_time, k2.review.first_time_rate], [2, 1, 50], 'one of two accepted without a send-back');
  const k3 = P('kpi3'); assert.equal(k3.review.reviews_done, 3, 'a send-back and two accepts'); assert.ok(k3.review.avg_review_days >= 0 && k3.review.avg_review_days < 1);
  assert.deepEqual([k3.stages.done, k3.stages.with_plan, k3.stages.on_time, k3.stages.on_time_rate, k3.stages.avg_delay_days], [1, 1, 0, 0, 1], 'the stage was finished a day late');
  assert.equal(k3.bands.stage_on_time, 'red');
  // work somebody else closed is not counted as theirs, and nobody is ranked or scored
  const k2tasks = await api(tok.manager, 'GET', `/api/kpi/rd/person/${uid.kpi1}?${range}`); assert.equal(k2tasks.success, true);
  assert.ok(list.people.every((x, i, arr) => i === 0 || arr[i - 1].name.localeCompare(x.name) <= 0), 'people are listed alphabetically');
  assert.ok(!JSON.stringify(list).match(/"(score|rank|ranking|position)"/), 'there is no score or rank');
  // who may see what
  for (const who of ['kpi1', 'kpi2', 'kannur']) assert.equal((await api(tok[who], 'GET', `/api/kpi/rd?${range}`)).status, 403, who + ' cannot see everyone\'s numbers');
  assert.equal((await api(tok.admin, 'GET', `/api/kpi/rd?${range}`)).success, true, 'an administrator can');
  const me = await api(tok.kpi1, 'GET', `/api/kpi/rd/me?${range}`); assert.equal(me.person.id, uid.kpi1); assert.equal(me.person.tasks.completed, 2, 'each person sees their own numbers');
  assert.equal((await api(tok.kpi1, 'GET', `/api/kpi/rd/person/${uid.kpi2}?${range}`)).status, 403, 'but not a colleague\'s');
  const own = await api(tok.kpi1, 'GET', `/api/kpi/rd/person/${uid.kpi1}?${range}`); assert.equal(own.success, true);
  assert.equal(own.trend.length, 6); assert.equal(own.trend[5].completed, 2); assert.ok(own.tasks.some(t => t.title === 'KPI open overdue') && own.tasks.some(t => t.title === 'KPI late' && t.days_late === 1), 'the person\'s tasks are listed with how late');
  assert.ok(own.tasks.find(t => t.title === 'KPI reviewed A') === undefined, 'tasks of other people are not mixed in');
  // the period is checked
  assert.equal((await api(tok.manager, 'GET', `/api/kpi/rd?from=${today}&to=${plus(-5)}`)).status, 400, 'start after end');
  assert.equal((await api(tok.manager, 'GET', '/api/kpi/rd?from=2026-02-31&to=2026-03-01')).status, 400, 'not a real date');
  assert.equal((await api(tok.manager, 'GET', `/api/kpi/rd?from=${plus(-400)}&to=${today}`)).status, 400, 'more than a year');
  // a spreadsheet file of the same table
  const csv = await fetch(BASE + `/api/kpi/rd/export?${range}`, { headers: { Authorization: 'Bearer ' + tok.manager } });
  assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type'), /text\/csv/); const text = await csv.text();
  assert.match(text, /Person,Username,Roles/); assert.match(text, /Test kpi1/);
  assert.equal((await fetch(BASE + `/api/kpi/rd/export?${range}`, { headers: { Authorization: 'Bearer ' + tok.kpi1 } })).status, 403);
  // the targets: anyone may read them, only an administrator changes them, and the bands follow
  assert.deepEqual((await api(tok.kpi1, 'GET', '/api/kpi/targets')).targets, { green_min: 90, amber_min: 70, overdue_amber_max: 2 });
  assert.equal((await api(tok.manager, 'PUT', '/api/kpi/targets', { green_min: 80, amber_min: 50, overdue_amber_max: 1 })).status, 403, 'only an administrator');
  assert.equal((await api(tok.admin, 'PUT', '/api/kpi/targets', { green_min: 50, amber_min: 60, overdue_amber_max: 1 })).status, 400, 'amber must be below green');
  try {
    assert.equal((await api(tok.admin, 'PUT', '/api/kpi/targets', { green_min: 40, amber_min: 30, overdue_amber_max: 0 })).success, true);
    const again = await api(tok.manager, 'GET', `/api/kpi/rd?${range}`); const r1 = again.people.find(x => x.id === uid.kpi1);
    assert.equal(r1.bands.on_time, 'green', '50% is green when green starts at 40%'); assert.equal(r1.bands.overdue, 'red', 'one overdue is red when amber allows none');
  } finally { await api(tok.admin, 'PUT', '/api/kpi/targets', { green_min: 90, amber_min: 70, overdue_amber_max: 2 }); }
  assert.ok((await pool.query("SELECT COUNT(*)::int n FROM audit_log WHERE action = 'kpi.targets'")).rows[0].n >= 1, 'a change of targets is audited');
});

test('my day: a person sees their open tasks, the tasks they handed out, the stages they own and what was just finished', async () => {
  const p = await newProject(tok.kannur);
  const d0 = await get(tok.lead, p.id);
  await api(tok.lead, 'PUT', `/api/rd/projects/${p.id}/assessment`, { version: d0.project.version, lead_user_id: uid.lead });
  const mk = (title, who, due) => api(tok.lead, 'POST', `/api/rd/projects/${p.id}/tasks`, { title, assignee_id: uid[who], due_date: due });
  const today = R.todayIST(), tomorrow = R.addDays(today, 1), yesterday = R.addDays(today, -1);
  const a = await mk('Mine today', 'rd2', today), b = await mk('Mine overdue', 'rd2', yesterday), c = await mk('For lead tomorrow', 'lead', tomorrow), e = await mk('Finish me', 'rd2', tomorrow);
  await api(tok.rd2, 'POST', `/api/rd/tasks/${e.id}/complete`, { result: 'Finished and written up properly.' });
  const day = await api(tok.rd2, 'GET', '/api/rd/my-day');
  assert.equal(day.success, true); assert.equal(day.today, today);
  const mineIds = day.mine.map(x => x.id);
  assert.ok(mineIds.includes(a.id) && mineIds.includes(b.id) && !mineIds.includes(c.id) && !mineIds.includes(e.id), 'my open tasks only: not other people\'s, not finished ones');
  assert.ok(day.done_by_me.some(x => x.id === e.id && x.result), 'what I finished this week, with its result');
  assert.equal(day.mine.find(x => x.id === b.id).due_date, yesterday); assert.ok(day.mine.every(x => x.project_number && x.assigned_by_name), 'each task names its project and who assigned it');
  // the person who handed tasks out sees what is waiting on others, and the results as they arrive
  const lead = await api(tok.lead, 'GET', '/api/rd/my-day');
  assert.ok(lead.assigned.some(x => x.id === a.id && x.assignee_name) && lead.assigned.some(x => x.id === b.id), 'tasks I assigned to others');
  assert.ok(!lead.assigned.some(x => x.id === c.id), 'a task I gave myself is not "waiting on others"');
  assert.ok(lead.assigned_done.some(x => x.id === e.id && x.result), 'a finished task and its result appear for the person who assigned it');
  assert.ok(lead.mine.some(x => x.id === c.id));
  assert.ok(lead.stages.some(s => s.project_id === p.id && s.stage_no === 1 && s.items_left === 3 && s.stage_name), 'the stage I lead is on my list with its checklist left');
  assert.ok(!day.stages.some(s => s.project_id === p.id), 'someone who does not own the stage does not see it');
  // visibility: nothing from a project the person may not open
  const other = await api(tok.purchase, 'GET', '/api/rd/my-day');
  assert.equal(other.success, true); assert.ok(!other.mine.some(x => x.project_id === p.id) && !other.assigned.some(x => x.project_id === p.id));
  assert.equal((await api(null, 'GET', '/api/rd/my-day')).status, 401);
});

test('dashboards: the R&D workspace and the management band count the same projects the directory lists', async () => {
  const lead = await api(tok.lead, 'GET', '/api/workspace/me');
  assert.equal(lead.active, 'rd');
  assert.ok(lead.nav.flatMap(g => g.items).some(i => i.href === 'projects.html'));
  const dash = await api(tok.lead, 'GET', '/api/workspace/rd/dashboard');
  assert.equal(dash.success, true); assert.ok(dash.cards.length <= 4);
  const recv = dash.cards.find(c => c.key === 'received').value;
  assert.equal(recv, (await api(tok.lead, 'GET', '/api/rd/projects?scope=active&status=Received')).count);
  const m = await api(tok.manager, 'GET', '/api/workspace/manager/dashboard');
  assert.equal(m.success, true); assert.equal(m.extra_cards.length, 4);
  const mAct = m.extra_cards.find(c => c.key === 'rd_active').value;
  assert.equal(mAct, (await api(tok.manager, 'GET', '/api/rd/projects?scope=active')).count, 'management count = directory list');
  const mOver = m.extra_cards.find(c => c.key === 'rd_overdue').value;
  assert.equal(mOver, (await api(tok.manager, 'GET', '/api/rd/projects?scope=active&overdue=1')).count);
  const kan = await api(tok.kannur, 'GET', '/api/workspace/me');
  assert.ok(kan.nav.flatMap(g => g.items).some(i => i.href === 'projects.html'), 'requesters reach their own requests');
  const strict = await api(tok.store, 'GET', '/api/workspace/stores/dashboard');
  assert.ok(!JSON.stringify(strict).includes(TAG), 'unrelated workspaces carry no R&D content');
  const purchase = await api(tok.purchase, 'GET', '/api/workspace/purchase/dashboard');
  assert.equal(purchase.success, true);
});

test('permissions: unauthenticated and unrelated people are refused; existing purchasing screens still work', async () => {
  assert.equal((await api(null, 'GET', '/api/rd/projects')).status, 401);
  assert.equal((await api(tok.store, 'POST', '/api/rd/projects', valid())).status, 403, 'store has no request permission by default');
  assert.equal((await api(tok.purchase, 'POST', '/api/rd/projects', valid())).status, 403);
  assert.equal((await api(tok.kannur, 'GET', '/api/rd/people')).status, 403, 'the people list is for editors only');
  assert.equal((await api(tok.lead, 'GET', '/api/rd/people')).success, true);
  assert.equal((await api(tok.kannur, 'PUT', '/api/rd/projects/1/assessment', { version: 1 })).status, 403);
  assert.equal((await api(tok.purchase, 'GET', '/api/po')).success, true);
  assert.equal((await api(tok.kannur, 'GET', '/api/branch-request')).success, true);
});

test('the reviewable import: dry run changes nothing, apply creates the project once, no stage completions without confirmation', async (t) => {
  // projects made by these tests may hold the month's first number; move them aside (they are deleted afterwards anyway)
  await pool.query("UPDATE rd_projects SET project_number = project_number || '-t' WHERE project_number = 'OXRD011026' AND created_by = ANY($1)", [made.users]);
  if ((await pool.query("SELECT 1 FROM rd_projects WHERE project_number = 'OXRD011026'")).rowCount) return t.skip('OXRD011026 already exists in this database (not made by these tests)');
  const { spawnSync } = require('child_process');
  const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'import-oxrd011026.js'), ...args], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  const exists = async () => (await pool.query("SELECT id FROM rd_projects WHERE project_number = 'OXRD011026'")).rows;
  const dry = run();
  assert.equal(dry.status, 0, dry.stdout + dry.stderr); assert.match(dry.stdout, /DRY RUN/); assert.equal((await exists()).length, 0, 'a dry run creates nothing');
  assert.notEqual(run('--apply', '--stages-completed-on=2026-10-31').status, 0, 'completions need the owner confirmation flag as well');
  assert.equal((await exists()).length, 0);
  const applied = run('--apply');
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  const rows = await exists(); assert.equal(rows.length, 1); made.projects.push(rows[0].id);
  assert.match(run('--apply').stdout, /Already imported/, 'a second run does not duplicate');
  assert.equal((await exists()).length, 1);
  const p = (await pool.query('SELECT * FROM rd_projects WHERE id = $1', [rows[0].id])).rows[0];
  assert.equal(p.title, 'Under chassis coating'); assert.equal(p.target_tbc, true); assert.equal(p.target_launch_date, null, 'the old 01-11-2020 date is not used');
  assert.equal(p.status, 'Received'); assert.equal(p.brand_product, 'HERAKLEON'); assert.equal(p.requested_by_name, 'Saifudheen');
  const st = (await pool.query('SELECT COUNT(*)::int n, COUNT(completed_at)::int done FROM rd_stages WHERE project_id = $1', [p.id])).rows[0];
  assert.equal(st.n, 8); assert.equal(st.done, 0, 'the reported same-day completions are not imported without confirmation');
  assert.equal((await pool.query("SELECT COUNT(*)::int n FROM rd_approvals WHERE project_id = $1 AND kind <> 'submission'", [p.id])).rows[0].n, 0, 'no approvals are invented');
});
