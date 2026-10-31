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
  for (const c of st.checklist) await api(token, 'POST', `/api/rd/projects/${id}/stages/${no}/checklist/${c.id}`, { done: true });
  return api(token, 'POST', `/api/rd/projects/${id}/stages/${no}/complete`, { date: date || R.todayIST(), confirm: true });
}

test.before(async () => {
  await runMigrations();
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
});

test.after(async () => {
  try {
    await pool.query('DELETE FROM rd_projects WHERE id = ANY($1)', [made.projects.length ? made.projects : [0]]); // everything else cascades
    await pool.query("DELETE FROM rd_projects WHERE created_by = ANY($1)", [made.users.length ? made.users : [0]]);
    if (counterBefore === null) await pool.query('DELETE FROM rd_number_counters WHERE period = $1', [period]);
    else await pool.query('UPDATE rd_number_counters SET last_serial = $1 WHERE period = $2', [counterBefore, period]);
    await pool.query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [made.users.length ? made.users : [0]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users.length ? made.users : [0]]);
  } finally { server && server.kill(); await pool.end(); }
});

// ---------------------------------------------------------------------------------------------------
test('migrations add the R&D tables and roles without touching existing data; the sample project does not exist', async () => {
  const names = (await pool.query('SELECT name FROM app_migrations')).rows.map(r => r.name);
  assert.ok(names.includes('009_rd_projects') && names.includes('010_rd_permissions'));
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
  for (const c of d.stages[0].checklist) await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/stages/1/checklist/${c.id}`, { done: true });
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
  for (const no of [1, 2]) for (const c of d.stages[no - 1].checklist) await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/stages/${no}/checklist/${c.id}`, { done: true });
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
  const t = await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/tasks`, { title: 'Order samples', due_date: '2026-12-01' });
  assert.equal(t.status, 201);
  assert.equal((await api(tok.lead, 'PUT', `/api/rd/projects/${p.id}/stages/1`, { version: after.stages[0].version, remarks: 'in progress' })).success, true);
  assert.equal((await get(tok.lead, p.id)).tasks.length, 1);
  assert.equal((await api(tok.kannur, 'PATCH', `/api/rd/projects/${p.id}`, { version: v2 + 5, title: 'x' })).status, 403, 'a requester cannot edit a submitted project');
});

test('tasks: one accountable person, independent of stage completion, version-checked; status updates by the assignee', async () => {
  const p = await newProject(tok.kannur);
  const mk = await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/tasks`, { title: 'Test adhesion', assignee_id: uid.rd2, due_date: R.todayIST(), priority: 'High', stage_no: 4 });
  assert.equal(mk.status, 201);
  const team = await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/tasks`, { title: 'Quote for resin', team: 'Purchase' });
  assert.equal(team.status, 201);
  let d = await get(tok.lead, p.id);
  const task = d.tasks.find(t => t.title === 'Test adhesion'), unclaimed = d.tasks.find(t => t.title === 'Quote for resin');
  assert.equal(task.assignee_id, uid.rd2); assert.equal(unclaimed.assignee_id, null); assert.equal(unclaimed.team, 'Purchase', 'an unclaimed team task is explicit');
  assert.equal((await api(tok.kannur, 'PATCH', '/api/rd/tasks/' + task.id, { version: task.version, status: 'done' })).status, 403, 'someone else cannot');
  const mine = await api(tok.rd2, 'PATCH', '/api/rd/tasks/' + task.id, { version: task.version, status: 'in_progress' });
  assert.equal(mine.success, true, 'the assignee may update their own status');
  assert.equal((await api(tok.rd2, 'PATCH', '/api/rd/tasks/' + task.id, { version: task.version, status: 'done' })).status, 409, 'a stale version is refused');
  // a department member who is only an assignee may update status, nothing else
  await api(tok.lead, 'PUT', `/api/rd/projects/${p.id}/assessment`, { version: d.project.version, members: [uid.purchase] });
  const claim = await api(tok.lead, 'PATCH', '/api/rd/tasks/' + unclaimed.id, { version: unclaimed.version, assignee_id: uid.purchase });
  assert.equal(claim.success, true);
  assert.equal((await api(tok.purchase, 'PATCH', '/api/rd/tasks/' + unclaimed.id, { version: unclaimed.version + 1, title: 'renamed' })).status, 403, 'an assignee without edit rights cannot change anything but status');
  assert.equal((await api(tok.purchase, 'PATCH', '/api/rd/tasks/' + unclaimed.id, { version: unclaimed.version + 1, status: 'in_progress' })).success, true);
  d = await get(tok.lead, p.id);
  assert.equal(d.tasks.find(t => t.id === unclaimed.id).team, null, 'claiming removes the unclaimed marker');
  await api(tok.rd2, 'PATCH', '/api/rd/tasks/' + task.id, { version: task.version + 1, status: 'done' });
  assert.equal((await api(tok.rd2, 'PATCH', '/api/rd/tasks/' + task.id, { version: task.version + 2, title: 'renamed by R&D' })).success, true, 'R&D staff with edit rights can edit it');
  d = await get(tok.lead, p.id);
  assert.equal(d.tasks.find(t => t.id === task.id).status, 'done'); assert.ok(d.tasks.find(t => t.id === task.id).completed_at);
  assert.equal(d.stages[3].state, 'pending', 'finishing the stage-4 task does not complete stage 4 or bypass QC sign-off');
  assert.equal((await api(tok.lead, 'POST', `/api/rd/projects/${p.id}/tasks`, { title: 'x', due_date: '31-12-2026' })).status, 400);
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
