// routes/rd.js - R&D projects. All paths are under /api/rd and need a signed-in person.
//
// Who may see a project: a draft only its creator (and administrators); a submitted project everyone holding rd.view_all, or
// someone holding rd.view who is involved in it (requester, lead or member). Seeing a project does NOT show its confidential
// technical content (technical approach, risks, lab notes): that needs field.rd_technical.
//
// Rules that matter and are enforced here, not on the page:
//   - a project number is allocated in the same transaction that submits the request, from a counter row that serialises concurrent
//     submissions, so numbers are unique and sequential per month
//   - a stage can only be completed when it is the current (first incomplete) stage, its checklist is done and its required
//     approval exists; the project row is locked and the update is conditional, so a repeated or simultaneous click completes it once
//   - reopening a stage keeps the history and flags later completed stages for review; it never clears them
//   - every change to a project, stage or task checks a version, so two people cannot silently overwrite each other

const express = require('express');
const { pool } = require('../database');
const { fail } = require('../utils');
const { audit } = require('../audit');
const { KEYS } = require('../permissions');
const { can } = require('../access');
const R = require('../rd-logic');
const { visibleClause } = require('../rd-visibility');
const router = express.Router();

// ---------------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------------
/** DATE columns arrive as local-midnight Date objects; format them with LOCAL getters so no time-zone shift is possible. */
function ymd(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  return v.getFullYear() + '-' + String(v.getMonth() + 1).padStart(2, '0') + '-' + String(v.getDate()).padStart(2, '0');
}
const DATE_COLS = ['request_date', 'target_launch_date', 'completed_on', 'planned_date', 'actual_date', 'due_date', 'decision_date', 'action_date'];
function norm(row) { if (row) DATE_COLS.forEach(c => { if (c in row) row[c] = ymd(row[c]); }); return row; }
const idOf = (x) => { const n = Number(x); return Number.isInteger(n) && n > 0 ? n : null; };
const today = () => R.todayIST();
const str = (v) => { if (v == null) return null; const s = String(v).trim(); return s === '' ? null : s; };
const bool = (v) => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : null);
const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : NaN; };

function conflict(res, message, extra) { return res.status(409).json({ success: false, error: message, ...(extra || {}) }); }

// request fields a person may supply, with how each is read
const REQUEST_FIELDS = {
  title: str, project_type: str, priority: str, department: str, target_launch_date: str, target_tbc: (v) => v === true || v === 'true',
  customer_oem: str, brand_product: str, product_category: str, base_system: str, description: str, application_method: str,
  substrate: str, end_user_market: str, benchmark: str, appearance_notes: str, target_cost: num, cost_basis: str, labelling_claims: str,
  monthly_volume: num, volume_unit: str, pack_sizes: str, packaging_type: str, voc_limit_required: bool, voc_target_gl: num,
  sds_ghs_required: bool, restricted_substances: str, standards: str
};
function readRequest(body, only) {
  const out = {};
  for (const [k, read] of Object.entries(REQUEST_FIELDS)) {
    if (!(k in (body || {}))) continue;
    if (only && !only.includes(k)) continue;
    out[k] = read(body[k]);
  }
  return out;
}
function checkRequestValues(p) {
  const errs = [];
  ['target_cost', 'monthly_volume', 'voc_target_gl'].forEach(k => { if (k in p && Number.isNaN(p[k])) errs.push({ field: k, message: `${k.replace(/_/g, ' ')} must be a number` }); });
  if (p.target_launch_date && !R.isValidDate(p.target_launch_date)) errs.push({ field: 'target_launch_date', message: 'Target launch date is not a valid date' });
  if (p.cost_basis && !R.COST_BASES.includes(p.cost_basis)) errs.push({ field: 'cost_basis', message: 'Cost basis must be ₹/kg or ₹/L' });
  if (p.target_tbc) p.target_launch_date = null; // "To be confirmed" and a date are mutually exclusive
  return errs;
}

async function memberIds(db, projectId) {
  return (await db.query('SELECT user_id FROM rd_project_members WHERE project_id = $1', [projectId])).rows.map(r => r.user_id);
}
async function getProject(db, id, lock) {
  const r = await db.query(`SELECT * FROM rd_projects WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  return norm(r.rows[0]);
}

/** What this person may do with this project. */
function abilities(req, p, members) {
  const uid = req.user.id, admin = req.access.isAdmin;
  const involved = p.requested_by_user === uid || p.lead_user_id === uid || members.includes(uid);
  const viewAll = can(req.access, KEYS.RD_VIEW_ALL);
  const visible = p.is_draft ? (p.created_by === uid || admin) : (viewAll || (can(req.access, KEYS.RD_VIEW) && involved));
  const edit = p.is_draft ? (p.created_by === uid || admin) : (can(req.access, KEYS.RD_EDIT) && (viewAll || involved));
  return {
    visible, edit, involved,
    stage: !p.is_draft && edit && can(req.access, KEYS.RD_STAGE),
    technical: can(req.access, KEYS.FIELD_RD_TECHNICAL),
    approve: {
      rd_head: can(req.access, KEYS.RD_APPROVE_HEAD), management: can(req.access, KEYS.RD_APPROVE_MGMT),
      qc_signoff: can(req.access, KEYS.RD_QC_SIGNOFF), handover_ack: can(req.access, KEYS.RD_HANDOVER_ACK),
      customer: !p.is_draft && edit
    }
  };
}

/** Loads a project the person may see (otherwise answers 404, so an invisible project looks like a missing one). */
async function open(req, res, opts) {
  const id = idOf(req.params.id);
  if (!id) { fail(res, 400, 'Invalid project id'); return null; }
  const p = await getProject(opts && opts.db || pool, id, opts && opts.lock);
  if (!p) { fail(res, 404, 'Project not found'); return null; }
  const members = await memberIds(opts && opts.db || pool, id);
  const acc = abilities(req, p, members);
  if (!acc.visible) { fail(res, 404, 'Project not found'); return null; }
  return { p, members, acc };
}

async function addUpdate(db, projectId, kind, req, body, taskId) {
  await db.query('INSERT INTO rd_updates (project_id, task_id, kind, author_id, author_name, body) VALUES ($1,$2,$3,$4,$5,$6)',
    [projectId, taskId || null, kind, req && req.user ? req.user.id : null, req && req.user ? req.user.name : 'System', body]);
}

/** Allocates the next project number for a month. The counter row serialises concurrent callers. */
async function allocateNumber(client, isoDate) {
  const r = await client.query(
    `INSERT INTO rd_number_counters (period, last_serial) VALUES ($1, 1)
     ON CONFLICT (period) DO UPDATE SET last_serial = rd_number_counters.last_serial + 1 RETURNING last_serial`, [R.periodOf(isoDate)]);
  return R.numberFor(r.rows[0].last_serial, isoDate);
}

async function saveRequirements(client, projectId, rows) {
  await client.query('DELETE FROM rd_requirements WHERE project_id = $1', [projectId]);
  const clean = R.cleanRequirementRows(rows);
  for (let i = 0; i < clean.length; i++) {
    const r = clean[i];
    await client.query(
      'INSERT INTO rd_requirements (project_id, position, parameter, target, acceptable_range, test_method, benchmark_value, remarks) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [projectId, i, r.parameter, r.target, r.acceptable_range, r.test_method, r.benchmark_value, r.remarks]);
  }
  return clean.length;
}

/** Turns a draft into a submitted request: number, eight stages with their checklists, and the submission record. */
async function submitInside(client, req, p) {
  const date = today();
  const number = await allocateNumber(client, date);
  await client.query(
    `UPDATE rd_projects SET project_number = $1, is_draft = FALSE, status = 'Received', request_date = $2, submitted_at = NOW(),
            version = version + 1, updated_at = NOW() WHERE id = $3`, [number, date, p.id]);
  for (const st of R.STAGES) {
    const s = await client.query('INSERT INTO rd_stages (project_id, stage_no) VALUES ($1,$2) RETURNING id', [p.id, st.no]);
    for (let i = 0; i < st.checklist.length; i++) {
      await client.query('INSERT INTO rd_checklist_items (stage_id, position, label) VALUES ($1,$2,$3)', [s.rows[0].id, i, st.checklist[i]]);
    }
  }
  // Submission records WHO asked. It is not an authorisation by management.
  await client.query(
    `INSERT INTO rd_approvals (project_id, kind, decision, decision_date, remarks, decided_by) VALUES ($1,'submission','submitted',$2,'Request submitted',$3)`,
    [p.id, date, req.user.id]);
  await addUpdate(client, p.id, 'system', req, `Request submitted as ${number}`);
  await audit(client, req, { action: 'rd.submit', entity: 'rd_project', id: p.id, summary: `${number} submitted: ${p.title}`, after: { number } });
  return number;
}

// ---------------------------------------------------------------------------------------------------------------
// reference data and people
// ---------------------------------------------------------------------------------------------------------------
router.get('/meta', requirePermissionAny([KEYS.RD_VIEW, KEYS.RD_CREATE]), (req, res) => {
  res.json({
    success: true, today: today(),
    lists: { project_types: R.PROJECT_TYPES, product_categories: R.PRODUCT_CATEGORIES, base_systems: R.BASE_SYSTEMS, priorities: R.PRIORITIES,
      departments: R.DEPARTMENTS, statuses: R.STATUSES, feasibility: R.FEASIBILITY, cost_bases: R.COST_BASES },
    active_statuses: R.ACTIVE_STATUSES, hold_status: R.HOLD_STATUS, closed_statuses: R.CLOSED_STATUSES,
    default_requirement_rows: R.DEFAULT_PERFORMANCE_ROWS,
    stages: R.STAGES.map(s => ({ no: s.no, name: s.name, days: s.days, needs: s.needs || null, checklist: s.checklist })),
    approval_labels: R.APPROVAL_LABELS,
    can: {
      create: can(req.access, KEYS.RD_CREATE), view_all: can(req.access, KEYS.RD_VIEW_ALL), edit: can(req.access, KEYS.RD_EDIT),
      technical: can(req.access, KEYS.FIELD_RD_TECHNICAL)
    }
  });
});

function requirePermissionAny(keys) {
  return (req, res, next) => (keys.some(k => can(req.access, k)) ? next() : fail(res, 403, `Your role ("${req.user.role}") is not allowed to do this`));
}
const needPerm = (key) => (req, res, next) => (can(req.access, key) ? next() : fail(res, 403, `Your role ("${req.user.role}") is not allowed to do this`));

// People who can be named as lead, member, stage owner or task assignee. Only people who edit projects get the list.
router.get('/people', needPerm(KEYS.RD_EDIT), async (req, res) => {
  try {
    const r = await pool.query(`SELECT u.id, u.name, array_agg(DISTINCT ur.role) AS roles FROM users u JOIN user_roles ur ON ur.user_id = u.id WHERE u.active GROUP BY u.id, u.name ORDER BY u.name`);
    res.json({ success: true, people: r.rows });
  } catch (err) { console.error(err); fail(res, 500, 'Could not load people'); }
});

// ---------------------------------------------------------------------------------------------------------------
// directory
// ---------------------------------------------------------------------------------------------------------------
router.get('/projects', requirePermissionAny([KEYS.RD_VIEW, KEYS.RD_CREATE]), async (req, res) => {
  try {
    const uid = req.user.id;
    // visibility is part of the query, so counts and lists can never include a project the person may not open
    const vis = visibleClause(req.access, uid, 'p', 0);
    const params = [...vis.params];
    const where = [vis.clause];
    const q = req.query;
    const scope = ['active', 'hold', 'closed', 'drafts', 'all'].includes(q.scope) ? q.scope : 'active';
    if (scope === 'active') { params.push(R.ACTIVE_STATUSES); where.push(`p.is_draft = FALSE AND p.status = ANY($${params.length})`); }
    else if (scope === 'hold') { params.push(R.HOLD_STATUS); where.push(`p.is_draft = FALSE AND p.status = $${params.length}`); }
    else if (scope === 'closed') { params.push(R.CLOSED_STATUSES); where.push(`p.is_draft = FALSE AND p.status = ANY($${params.length})`); }
    else if (scope === 'drafts') where.push('p.is_draft = TRUE');
    if (q.status && R.STATUSES.includes(q.status)) { params.push(q.status); where.push(`p.status = $${params.length}`); }
    if (q.priority && R.PRIORITIES.includes(q.priority)) { params.push(q.priority); where.push(`p.priority = $${params.length}`); }
    if (q.department && R.DEPARTMENTS.includes(q.department)) { params.push(q.department); where.push(`p.department = $${params.length}`); }
    if (idOf(q.lead)) { params.push(idOf(q.lead)); where.push(`p.lead_user_id = $${params.length}`); }
    if (q.overdue === '1') where.push(`EXISTS (SELECT 1 FROM rd_stages s WHERE s.project_id = p.id AND s.completed_at IS NULL AND s.planned_date < (now() AT TIME ZONE 'Asia/Kolkata')::date)`);
    if (/^\d{4}$/.test(String(q.year || ''))) { params.push(Number(q.year)); where.push(`EXTRACT(YEAR FROM p.completed_on) = $${params.length}`); }
    if (q.mine === '1') where.push(`(p.requested_by_user = $1 OR p.lead_user_id = $1 OR EXISTS (SELECT 1 FROM rd_project_members m WHERE m.project_id = p.id AND m.user_id = $1))`);
    if (q.q && String(q.q).trim()) { params.push('%' + String(q.q).trim() + '%'); where.push(`(p.project_number ILIKE $${params.length} OR p.title ILIKE $${params.length} OR p.brand_product ILIKE $${params.length} OR p.customer_oem ILIKE $${params.length})`); }
    const order = { target: 'p.target_launch_date NULLS LAST, p.id', number: 'p.project_number NULLS LAST', priority: "CASE p.priority WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END, p.id",
      updated: 'p.updated_at DESC' }[q.sort] || 'p.updated_at DESC';
    const r = await pool.query(
      `SELECT p.id, p.project_number, p.is_draft, p.title, p.status, p.priority, p.department, p.project_type, p.target_launch_date, p.target_tbc, p.request_date,
              p.requested_by_name, p.lead_user_id, lu.name AS lead_name,
              (SELECT COUNT(*)::int FROM rd_stages s WHERE s.project_id = p.id AND s.completed_at IS NOT NULL) AS stages_done,
              (SELECT COUNT(*)::int FROM rd_stages s WHERE s.project_id = p.id AND s.completed_at IS NULL AND s.planned_date < (now() AT TIME ZONE 'Asia/Kolkata')::date) AS overdue_stages,
              (SELECT MIN(s.stage_no) FROM rd_stages s WHERE s.project_id = p.id AND s.completed_at IS NULL) AS current_stage_no,
              (SELECT COUNT(*)::int FROM rd_tasks t WHERE t.project_id = p.id AND t.status <> 'done') AS open_tasks,
              (SELECT COUNT(*)::int FROM rd_tasks t WHERE t.project_id = p.id AND t.status <> 'done' AND t.due_date < (now() AT TIME ZONE 'Asia/Kolkata')::date) AS overdue_tasks,
              COALESCE((SELECT up.favourite FROM rd_user_projects up WHERE up.user_id = $1 AND up.project_id = p.id), FALSE) AS favourite
         FROM rd_projects p LEFT JOIN users lu ON lu.id = p.lead_user_id
        WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 500`, params);
    const rows = r.rows.map(x => { norm(x); x.current_stage = x.current_stage_no ? R.STAGES[x.current_stage_no - 1].name : null; x.progress_percent = Math.round(x.stages_done / 8 * 100); return x; });
    const counts = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE p.is_draft = FALSE AND p.status = ANY($5))::int AS active, COUNT(*) FILTER (WHERE p.is_draft = FALSE AND p.status = $6)::int AS hold,
              COUNT(*) FILTER (WHERE p.is_draft = FALSE AND p.status = ANY($7))::int AS closed, COUNT(*) FILTER (WHERE p.is_draft = TRUE)::int AS drafts
         FROM rd_projects p WHERE ${where[0]}`, [...params.slice(0, 4), R.ACTIVE_STATUSES, R.HOLD_STATUS, R.CLOSED_STATUSES]);
    res.json({ success: true, scope, count: rows.length, counts: counts.rows[0], projects: rows, active_definition: R.ACTIVE_STATUSES });
  } catch (err) { console.error('rd list failed:', err); fail(res, 500, 'Could not load projects'); }
});

// ---------------------------------------------------------------------------------------------------------------
// create (draft or submit), read, edit
// ---------------------------------------------------------------------------------------------------------------
router.post('/projects', needPerm(KEYS.RD_CREATE), async (req, res) => {
  const body = req.body || {};
  const submitting = body.submit === true;
  const fields = readRequest(body);
  const errs = [...checkRequestValues(fields), ...R.validateRequest(fields, submitting)];
  if (errs.length) return res.status(400).json({ success: false, error: errs[0].message, errors: errs });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const keys = Object.keys(fields);
    const cols = ['is_draft', 'requested_by_user', 'requested_by_name', 'created_by', ...keys];
    const vals = [true, req.user.id, req.user.name, req.user.id, ...keys.map(k => fields[k])];
    const ins = await client.query(`INSERT INTO rd_projects (${cols.join(',')}) VALUES (${vals.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id, title`, vals);
    const id = ins.rows[0].id;
    await saveRequirements(client, id, body.requirements);
    let number = null;
    if (submitting) number = await submitInside(client, req, { id, title: ins.rows[0].title });
    else await audit(client, req, { action: 'rd.draft', entity: 'rd_project', id, summary: `Draft saved: ${ins.rows[0].title}` });
    await client.query('COMMIT');
    res.status(201).json({ success: true, id, project_number: number, is_draft: !submitting });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('rd create failed:', err); fail(res, 500, 'Could not save the request');
  } finally { client.release(); }
});

router.post('/projects/:id/submit', needPerm(KEYS.RD_CREATE), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = await open(req, res, { db: client, lock: true });
    if (!o) { await client.query('ROLLBACK'); return; }
    if (!o.p.is_draft) { await client.query('ROLLBACK'); return conflict(res, 'This request has already been submitted', { project_number: o.p.project_number }); }
    if (!o.acc.edit) { await client.query('ROLLBACK'); return fail(res, 403, 'Only the person who started this draft can submit it'); }
    const errs = R.validateRequest(o.p, true);
    if (errs.length) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, error: errs[0].message, errors: errs }); }
    const number = await submitInside(client, req, o.p);
    await client.query('COMMIT');
    res.json({ success: true, id: o.p.id, project_number: number });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('rd submit failed:', err); fail(res, 500, 'Could not submit the request');
  } finally { client.release(); }
});

/** Everything one project screen needs, with confidential content removed for people without access to it. */
async function detail(req, p, members, acc) {
  const t = today();
  const [reqs, stageRows, items, tasks, updates, approvals, mem, fav, people] = await Promise.all([
    pool.query('SELECT * FROM rd_requirements WHERE project_id = $1 ORDER BY position', [p.id]),
    pool.query('SELECT s.*, ou.name AS owner_name, cu.name AS completed_by_name FROM rd_stages s LEFT JOIN users ou ON ou.id = s.owner_user_id LEFT JOIN users cu ON cu.id = s.completed_by WHERE s.project_id = $1 ORDER BY s.stage_no', [p.id]),
    pool.query('SELECT c.* FROM rd_checklist_items c JOIN rd_stages s ON s.id = c.stage_id WHERE s.project_id = $1 ORDER BY c.stage_id, c.position', [p.id]),
    pool.query('SELECT t.*, au.name AS assignee_name FROM rd_tasks t LEFT JOIN users au ON au.id = t.assignee_id WHERE t.project_id = $1 ORDER BY (t.status = \'done\'), t.due_date NULLS LAST, t.id', [p.id]),
    pool.query(`SELECT id, task_id, kind, author_name, body, at FROM rd_updates WHERE project_id = $1 AND ($2 OR kind <> 'lab_note') ORDER BY at DESC, id DESC LIMIT 100`, [p.id, acc.technical]),
    pool.query('SELECT a.*, u.name AS decided_by_name FROM rd_approvals a LEFT JOIN users u ON u.id = a.decided_by WHERE a.project_id = $1 ORDER BY a.at, a.id', [p.id]),
    pool.query('SELECT u.id, u.name FROM rd_project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = $1 ORDER BY u.name', [p.id]),
    pool.query('SELECT favourite FROM rd_user_projects WHERE user_id = $1 AND project_id = $2', [req.user.id, p.id]),
    p.lead_user_id ? pool.query('SELECT id, name FROM users WHERE id = $1', [p.lead_user_id]) : { rows: [] }
  ]);
  const lead = people.rows[0] || null;
  const latest = (kind) => approvals.rows.filter(a => a.kind === kind).pop() || null;
  const by = new Map(); items.rows.forEach(c => { if (!by.has(c.stage_id)) by.set(c.stage_id, []); by.get(c.stage_id).push({ id: c.id, label: c.label, done: c.done }); });

  const lite = stageRows.rows.map(s => ({ no: s.stage_no, days: R.stageDays(R.STAGES[s.stage_no - 1], p.est_trial_days), planned: ymd(s.planned_date), actual: s.completed_at ? ymd(s.actual_date) : null }));
  const currentNo = R.currentStageNo(lite);
  const stages = stageRows.rows.map((s, i) => {
    const tpl = R.STAGES[s.stage_no - 1], done = !!s.completed_at, l = lite[i];
    const checklist = by.get(s.id) || [];
    const missing = [];
    if (!done) {
      const open = checklist.filter(c => !c.done).length;
      if (open) missing.push(`${open} checklist item${open === 1 ? '' : 's'} not done`);
      if (tpl.needs) {
        const a = latest(tpl.needs);
        if (!a || a.decision !== 'approved') missing.push(`${R.APPROVAL_LABELS[tpl.needs]} not recorded as approved`);
      }
    }
    return {
      no: s.stage_no, name: tpl.name, days: l.days, planned: l.planned, actual: l.actual, remarks: s.remarks, version: s.version,
      owner: s.owner_user_id ? { id: s.owner_user_id, name: s.owner_name, explicit: true } : (lead ? { id: lead.id, name: lead.name, explicit: false } : null),
      completed_at: s.completed_at, completed_by_name: s.completed_by_name, review_flag: s.review_flag,
      state: done ? 'done' : s.stage_no === currentNo ? 'current' : 'pending',
      delay: R.delayDays({ planned: l.planned, actual: l.actual }, t),
      overdue: !done && !!l.planned && t > l.planned,
      needs: tpl.needs || null, checklist, missing
    };
  });
  const cur = stages.find(s => s.state === 'current') || null;
  const out = {
    project: { ...p }, requirements: reqs.rows, stages, today: t, current_stage_no: currentNo,
    progress: { done: stages.filter(s => s.state === 'done').length, total: 8 },
    conflicts: R.findConflicts(lite, p.target_launch_date),
    next_step: cur && { stage: cur.no, name: cur.name, owner: cur.owner, due: cur.planned, overdue: cur.overdue, checklist: cur.checklist, missing: cur.missing },
    tasks: tasks.rows.map(norm), updates: updates.rows, approvals: approvals.rows.map(norm),
    members: mem.rows, lead, favourite: fav.rows[0] ? fav.rows[0].favourite : false,
    can: { ...acc, create_task: acc.edit && !p.is_draft }
  };
  out.project.lead_name = lead ? lead.name : null;
  if (!acc.technical) { delete out.project.technical_approach; delete out.project.risks; out.confidential_hidden = true; }
  return out;
}

router.get('/projects/:id', requirePermissionAny([KEYS.RD_VIEW, KEYS.RD_CREATE]), async (req, res) => {
  try {
    const o = await open(req, res);
    if (!o) return;
    pool.query(`INSERT INTO rd_user_projects (user_id, project_id, last_opened) VALUES ($1,$2,NOW()) ON CONFLICT (user_id, project_id) DO UPDATE SET last_opened = NOW()`, [req.user.id, o.p.id]).catch(() => {});
    res.json({ success: true, ...(await detail(req, o.p, o.members, o.acc)) });
  } catch (err) { console.error('rd detail failed:', err); fail(res, 500, 'Could not load the project'); }
});

router.put('/projects/:id/favourite', requirePermissionAny([KEYS.RD_VIEW, KEYS.RD_CREATE]), async (req, res) => {
  try {
    const o = await open(req, res); if (!o) return;
    const f = req.body && req.body.favourite === true;
    await pool.query(`INSERT INTO rd_user_projects (user_id, project_id, favourite) VALUES ($1,$2,$3) ON CONFLICT (user_id, project_id) DO UPDATE SET favourite = $3`, [req.user.id, o.p.id, f]);
    res.json({ success: true, favourite: f });
  } catch (err) { console.error(err); fail(res, 500, 'Could not save'); }
});

/** Applies a version-checked change to the project row. `sets` is { column: value }. */
async function changeProject(client, req, res, o, version, sets, audit_) {
  if (!Number.isInteger(Number(version))) { fail(res, 400, 'Send the version you are editing'); return false; }
  if (Number(version) !== o.p.version) {
    conflict(res, 'Someone else changed this project since you opened it. Reload to see their changes, then apply yours again.', { current_version: o.p.version });
    return false;
  }
  const keys = Object.keys(sets);
  const q = `UPDATE rd_projects SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}${keys.length ? ', ' : ''}version = version + 1, updated_at = NOW() WHERE id = $${keys.length + 1} AND version = $${keys.length + 2}`;
  const r = await client.query(q, [...keys.map(k => sets[k]), o.p.id, o.p.version]);
  if (r.rowCount === 0) { conflict(res, 'Someone else changed this project at the same moment. Reload and try again.'); return false; }
  const before = {}, after = {};
  keys.forEach(k => { before[k] = o.p[k]; after[k] = sets[k]; });
  if (audit_) await audit(client, req, { entity: 'rd_project', id: o.p.id, before, after, ...audit_ });
  return true;
}

router.patch('/projects/:id', requirePermissionAny([KEYS.RD_VIEW, KEYS.RD_CREATE]), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = await open(req, res, { db: client, lock: true });
    if (!o) { await client.query('ROLLBACK'); return; }
    if (!o.acc.edit) { await client.query('ROLLBACK'); return fail(res, 403, 'You may not edit this project'); }
    const sets = readRequest(req.body);
    const merged = { ...o.p, ...sets };
    const errs = [...checkRequestValues(sets), ...R.validateRequest(merged, !o.p.is_draft)];
    if (errs.length) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, error: errs[0].message, errors: errs }); }
    if (sets.target_tbc) sets.target_launch_date = null;
    const changed = Object.keys(sets).filter(k => String(sets[k] == null ? '' : sets[k]) !== String(o.p[k] == null ? '' : o.p[k]));
    const only = Object.fromEntries(changed.map(k => [k, sets[k]]));
    if (!(await changeProject(client, req, res, o, (req.body || {}).version, only, { action: 'rd.edit', summary: `${o.p.project_number || 'Draft'} edited (${changed.join(', ') || 'no field changes'})` }))) { await client.query('ROLLBACK'); return; }
    if (Array.isArray(req.body.requirements)) await saveRequirements(client, o.p.id, req.body.requirements);
    if (changed.length && !o.p.is_draft) await addUpdate(client, o.p.id, 'system', req, `Request details edited: ${changed.join(', ')}`);
    await client.query('COMMIT');
    res.json({ success: true, version: o.p.version + 1, changed });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('rd edit failed:', err); fail(res, 500, 'Could not save the changes');
  } finally { client.release(); }
});

// ---------------------------------------------------------------------------------------------------------------
// assessment, status
// ---------------------------------------------------------------------------------------------------------------
router.put('/projects/:id/assessment', needPerm(KEYS.RD_EDIT), async (req, res) => {
  const b = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = await open(req, res, { db: client, lock: true });
    if (!o) { await client.query('ROLLBACK'); return; }
    if (!o.acc.edit || o.p.is_draft) { await client.query('ROLLBACK'); return fail(res, 403, 'You may not assess this project'); }
    const sets = {};
    if ('lead_user_id' in b) {
      const lead = b.lead_user_id == null || b.lead_user_id === '' ? null : idOf(b.lead_user_id);
      if (lead) { const u = await client.query('SELECT 1 FROM users WHERE id = $1 AND active', [lead]); if (!u.rowCount) { await client.query('ROLLBACK'); return fail(res, 400, 'That person is not an active user'); } }
      sets.lead_user_id = lead;
    }
    if ('est_trial_days' in b) {
      const d = b.est_trial_days == null || b.est_trial_days === '' ? null : Number(b.est_trial_days);
      if (d !== null && (!Number.isInteger(d) || d < 1 || d > 365)) { await client.query('ROLLBACK'); return fail(res, 400, 'Trial duration must be a whole number of days between 1 and 365'); }
      sets.est_trial_days = d;
    }
    if ('feasibility' in b) {
      if (b.feasibility && !R.FEASIBILITY.includes(b.feasibility)) { await client.query('ROLLBACK'); return fail(res, 400, 'Feasibility must be one of: ' + R.FEASIBILITY.join(', ')); }
      sets.feasibility = b.feasibility || null;
    }
    for (const k of ['technical_approach', 'risks']) {
      if (!(k in b)) continue;
      if (!o.acc.technical) { await client.query('ROLLBACK'); return fail(res, 403, 'Confidential R&D content can only be edited by people who may see it'); }
      sets[k] = str(b[k]);
    }
    const changed = Object.keys(sets).filter(k => String(sets[k] == null ? '' : sets[k]) !== String(o.p[k] == null ? '' : o.p[k]));
    const only = Object.fromEntries(changed.map(k => [k, sets[k]]));
    // confidential values are written to the audit trail as "changed", never as their text
    const redact = changed.some(k => k === 'technical_approach' || k === 'risks');
    if (!(await changeProject(client, req, res, o, b.version, only, { action: 'rd.assess', summary: `${o.p.project_number} assessment updated (${changed.join(', ') || 'no change'})` }))) { await client.query('ROLLBACK'); return; }
    if (redact) await client.query(`UPDATE audit_log SET before_data = NULL, after_data = NULL WHERE id = (SELECT MAX(id) FROM audit_log WHERE entity = 'rd_project' AND entity_id = $1 AND action = 'rd.assess')`, [o.p.id]);
    if (Array.isArray(b.members)) {
      const ids = [...new Set(b.members.map(idOf).filter(Boolean))];
      await client.query('DELETE FROM rd_project_members WHERE project_id = $1 AND NOT (user_id = ANY($2))', [o.p.id, ids]);
      for (const uid of ids) await client.query('INSERT INTO rd_project_members (project_id, user_id, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [o.p.id, uid, req.user.id]);
      await addUpdate(client, o.p.id, 'system', req, 'Project team updated');
    }
    if (changed.length) await addUpdate(client, o.p.id, 'system', req, `Assessment updated: ${changed.map(k => k.replace(/_/g, ' ')).join(', ')}`);
    await client.query('COMMIT');
    res.json({ success: true, version: o.p.version + 1, changed, replan_suggested: changed.includes('est_trial_days') });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('rd assess failed:', err); fail(res, 500, 'Could not save the assessment');
  } finally { client.release(); }
});

router.post('/projects/:id/status', needPerm(KEYS.RD_EDIT), async (req, res) => {
  const b = req.body || {};
  if (!R.STATUSES.includes(b.status)) return fail(res, 400, 'Status must be one of: ' + R.STATUSES.join(', '));
  if (b.status === 'Completed') return fail(res, 400, 'A project is completed with "Mark Project Completed", once every stage is done');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = await open(req, res, { db: client, lock: true });
    if (!o) { await client.query('ROLLBACK'); return; }
    if (!o.acc.edit || o.p.is_draft) { await client.query('ROLLBACK'); return fail(res, 403, 'You may not change the status of this project'); }
    if (o.p.status === b.status) { await client.query('ROLLBACK'); return conflict(res, 'The project already has that status'); }
    const reason = str(b.reason);
    if ((b.status === 'Rejected' || b.status === R.HOLD_STATUS || R.CLOSED_STATUSES.includes(o.p.status)) && !reason) {
      await client.query('ROLLBACK'); return fail(res, 400, 'Give a reason for this status change');
    }
    const sets = { status: b.status, status_before_hold: b.status === R.HOLD_STATUS ? o.p.status : null };
    if (o.p.status === 'Completed') sets.completed_on = null; // leaving Completed clears the completion date; history stays in the audit log
    if (!(await changeProject(client, req, res, o, b.version, sets, { action: 'rd.status', summary: `${o.p.project_number}: ${o.p.status} -> ${b.status}`, reason }))) { await client.query('ROLLBACK'); return; }
    await addUpdate(client, o.p.id, 'system', req, `Status changed from ${o.p.status} to ${b.status}${reason ? ' - ' + reason : ''}`);
    await client.query('COMMIT');
    res.json({ success: true, status: b.status, version: o.p.version + 1 });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('rd status failed:', err); fail(res, 500, 'Could not change the status');
  } finally { client.release(); }
});

// ---------------------------------------------------------------------------------------------------------------
// stages: schedule, checklist, completion, reopening
// ---------------------------------------------------------------------------------------------------------------
async function loadStages(db, projectId) {
  const r = await db.query('SELECT * FROM rd_stages WHERE project_id = $1 ORDER BY stage_no', [projectId]);
  return r.rows.map(norm);
}
const toLite = (rows, trialDays) => rows.map(s => ({ no: s.stage_no, days: R.stageDays(R.STAGES[s.stage_no - 1], trialDays), planned: s.planned_date, actual: s.completed_at ? s.actual_date : null }));

/** Opens a stage for editing: the project must be open for work and the person must hold the stage permission. */
async function openStage(req, res, client) {
  const o = await open(req, res, { db: client, lock: true });
  if (!o) return null;
  const no = idOf(req.params.no);
  if (!no || no > 8) { fail(res, 400, 'Stage must be 1 to 8'); return null; }
  if (o.p.is_draft) { fail(res, 409, 'The request has not been submitted yet'); return null; }
  const stages = await loadStages(client, o.p.id);
  return { ...o, stages, stage: stages.find(s => s.stage_no === no), no };
}

router.put('/projects/:id/stages/:no', needPerm(KEYS.RD_EDIT), async (req, res) => {
  const b = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = await openStage(req, res, client);
    if (!o) { await client.query('ROLLBACK'); return; }
    if (!o.acc.edit) { await client.query('ROLLBACK'); return fail(res, 403, 'You may not edit this project'); }
    if (Number(b.version) !== o.stage.version) { await client.query('ROLLBACK'); return conflict(res, 'This stage was changed by someone else. Reload and try again.', { current_version: o.stage.version }); }
    const sets = {};
    if ('planned_date' in b) {
      if (o.stage.completed_at) { await client.query('ROLLBACK'); return conflict(res, 'A completed stage keeps its planned date. Reopen it first to change it.'); }
      if (b.planned_date && !R.isValidDate(b.planned_date)) { await client.query('ROLLBACK'); return fail(res, 400, 'Planned date is not a valid date'); }
      sets.planned_date = b.planned_date || null;
    }
    if ('owner_user_id' in b) {
      const ow = b.owner_user_id == null || b.owner_user_id === '' ? null : idOf(b.owner_user_id);
      if (ow) { const u = await client.query('SELECT 1 FROM users WHERE id = $1 AND active', [ow]); if (!u.rowCount) { await client.query('ROLLBACK'); return fail(res, 400, 'That person is not an active user'); } }
      sets.owner_user_id = ow;
    }
    if ('remarks' in b) sets.remarks = String(b.remarks || '').trim().slice(0, 2000);
    const keys = Object.keys(sets);
    if (!keys.length) { await client.query('ROLLBACK'); return fail(res, 400, 'Nothing to change'); }
    await client.query(`UPDATE rd_stages SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}, version = version + 1 WHERE id = $${keys.length + 1}`, [...keys.map(k => sets[k]), o.stage.id]);
    await client.query('UPDATE rd_projects SET updated_at = NOW() WHERE id = $1', [o.p.id]);
    await audit(client, req, { action: 'rd.stage_edit', entity: 'rd_stage', id: o.stage.id, summary: `${o.p.project_number} stage ${o.no} updated (${keys.join(', ')})`, before: Object.fromEntries(keys.map(k => [k, o.stage[k]])), after: sets });
    await client.query('COMMIT');
    res.json({ success: true, version: o.stage.version + 1 });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('rd stage edit failed:', err); fail(res, 500, 'Could not save the stage');
  } finally { client.release(); }
});

router.post('/projects/:id/stages/:no/checklist/:item', needPerm(KEYS.RD_EDIT), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = await openStage(req, res, client);
    if (!o) { await client.query('ROLLBACK'); return; }
    if (!o.acc.edit) { await client.query('ROLLBACK'); return fail(res, 403, 'You may not edit this project'); }
    if (o.stage.completed_at) { await client.query('ROLLBACK'); return conflict(res, 'This stage is completed. Reopen it to change its checklist.'); }
    const done = !!(req.body && req.body.done);
    const r = await client.query(
      `UPDATE rd_checklist_items SET done = $1, done_by = $2, done_at = $3 WHERE id = $4 AND stage_id = $5 RETURNING id`,
      [done, done ? req.user.id : null, done ? new Date() : null, idOf(req.params.item), o.stage.id]);
    if (!r.rowCount) { await client.query('ROLLBACK'); return fail(res, 404, 'Checklist item not found'); }
    await client.query('UPDATE rd_projects SET updated_at = NOW() WHERE id = $1', [o.p.id]);
    await client.query('COMMIT');
    res.json({ success: true, done });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err); fail(res, 500, 'Could not save');
  } finally { client.release(); }
});

/** Auto-plan: previews or applies planned dates for stages that have none. Entered dates are never changed. */
router.post('/projects/:id/auto-plan', needPerm(KEYS.RD_EDIT), async (req, res) => {
  const apply = !!(req.body && req.body.apply);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = await open(req, res, { db: client, lock: true });
    if (!o) { await client.query('ROLLBACK'); return; }
    if (!o.acc.edit || o.p.is_draft) { await client.query('ROLLBACK'); return fail(res, 403, 'You may not plan this project'); }
    const stages = await loadStages(client, o.p.id);
    const lite = toLite(stages, o.p.est_trial_days);
    const proposals = R.autoPlan(lite, today());
    const merged = lite.map(s => { const p = proposals.find(x => x.no === s.no); return p ? { ...s, planned: p.planned } : s; });
    const conflicts = R.findConflicts(merged, o.p.target_launch_date);
    if (apply) {
      for (const p of proposals) {
        await client.query('UPDATE rd_stages SET planned_date = $1, version = version + 1 WHERE project_id = $2 AND stage_no = $3 AND planned_date IS NULL AND completed_at IS NULL', [p.planned, o.p.id, p.no]);
      }
      if (proposals.length) {
        await addUpdate(client, o.p.id, 'system', req, `Planned dates filled for stages ${proposals.map(p => p.no).join(', ')} (calendar days; dates already entered were kept)`);
        await audit(client, req, { action: 'rd.autoplan', entity: 'rd_project', id: o.p.id, summary: `${o.p.project_number} auto-planned ${proposals.length} stage(s)`, after: proposals });
        await client.query('UPDATE rd_projects SET updated_at = NOW() WHERE id = $1', [o.p.id]);
      }
    }
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    res.json({ success: true, applied: apply, proposals, conflicts, basis: 'calendar days' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err); fail(res, 500, 'Could not plan the stages');
  } finally { client.release(); }
});

/** A changed trial duration offers this preview; nothing is rewritten until the person confirms the listed dates. */
router.get('/projects/:id/replan-preview', needPerm(KEYS.RD_EDIT), async (req, res) => {
  try {
    const o = await open(req, res); if (!o) return;
    const days = req.query.trial_days === undefined ? o.p.est_trial_days : Number(req.query.trial_days);
    if (days != null && (!Number.isInteger(days) || days < 1 || days > 365)) return fail(res, 400, 'Trial duration must be a whole number of days between 1 and 365');
    const lite = toLite(await loadStages(pool, o.p.id), days || null);
    res.json({ success: true, trial_days: days, basis: 'calendar days', preview: R.replanPreview(lite, today(), R.LAB_STAGE_NO) });
  } catch (err) { console.error(err); fail(res, 500, 'Could not prepare the preview'); }
});

router.post('/projects/:id/replan', needPerm(KEYS.RD_EDIT), async (req, res) => {
  const dates = Array.isArray(req.body && req.body.dates) ? req.body.dates : [];
  if (!dates.length) return fail(res, 400, 'Choose the dates to apply');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = await open(req, res, { db: client, lock: true });
    if (!o) { await client.query('ROLLBACK'); return; }
    if (!o.acc.edit || o.p.is_draft) { await client.query('ROLLBACK'); return fail(res, 403, 'You may not plan this project'); }
    const applied = [];
    for (const d of dates) {
      if (!idOf(d.no) || d.no > 8 || !R.isValidDate(d.planned)) { await client.query('ROLLBACK'); return fail(res, 400, 'Each date needs a stage number and a valid date'); }
      const r = await client.query('UPDATE rd_stages SET planned_date = $1, version = version + 1 WHERE project_id = $2 AND stage_no = $3 AND completed_at IS NULL RETURNING stage_no', [d.planned, o.p.id, d.no]);
      if (r.rowCount) applied.push(d.no);
    }
    await addUpdate(client, o.p.id, 'system', req, `Schedule re-planned for stages ${applied.join(', ')} after a change in the trial duration`);
    await audit(client, req, { action: 'rd.replan', entity: 'rd_project', id: o.p.id, summary: `${o.p.project_number} re-planned stages ${applied.join(', ')}`, after: dates });
    await client.query('UPDATE rd_projects SET updated_at = NOW() WHERE id = $1', [o.p.id]);
    await client.query('COMMIT');
    res.json({ success: true, applied });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err); fail(res, 500, 'Could not re-plan');
  } finally { client.release(); }
});

router.post('/projects/:id/stages/:no/complete', needPerm(KEYS.RD_STAGE), async (req, res) => {
  const b = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = await openStage(req, res, client);
    if (!o) { await client.query('ROLLBACK'); return; }
    if (!o.acc.stage) { await client.query('ROLLBACK'); return fail(res, 403, 'You may not complete stages of this project'); }
    if (!o.stage) { await client.query('ROLLBACK'); return fail(res, 404, 'Stage not found'); }
    if (['On Hold', 'Rejected', 'Completed'].includes(o.p.status)) { await client.query('ROLLBACK'); return conflict(res, `The project is ${o.p.status}. Change its status before completing stages.`); }
    if (o.stage.completed_at) { await client.query('ROLLBACK'); return conflict(res, `Stage ${o.no} is already completed (${R.dmy(o.stage.actual_date)}).`, { already: true }); }
    const lite = toLite(o.stages, o.p.est_trial_days);
    const current = R.currentStageNo(lite);
    if (current !== o.no) { await client.query('ROLLBACK'); return conflict(res, `Stage ${current} is the current stage. Complete it first.`, { current_stage: current }); }
    if (b.stage_version !== undefined && Number(b.stage_version) !== o.stage.version) { await client.query('ROLLBACK'); return conflict(res, 'This stage changed while you were looking at it. Reload and check it again.', { current_version: o.stage.version }); }
    const date = b.date;
    if (!R.isValidDate(date)) { await client.query('ROLLBACK'); return fail(res, 400, 'Give the completion date'); }
    const t = today();
    if (date > t) { await client.query('ROLLBACK'); return fail(res, 400, `The completion date cannot be in the future (today is ${R.dmy(t)}).`); }
    const prev = o.no > 1 ? lite[o.no - 2].actual : null;
    if (prev && date < prev) { await client.query('ROLLBACK'); return fail(res, 400, `Stage ${o.no} cannot be completed before stage ${o.no - 1} (${R.dmy(prev)}).`); }

    // the conditions that must be true
    const missing = [];
    const open_ = await client.query('SELECT COUNT(*)::int n FROM rd_checklist_items WHERE stage_id = $1 AND NOT done', [o.stage.id]);
    if (open_.rows[0].n) missing.push(`${open_.rows[0].n} checklist item${open_.rows[0].n === 1 ? '' : 's'} not done`);
    const tpl = R.STAGES[o.no - 1];
    if (tpl.needs) {
      const a = await client.query('SELECT decision FROM rd_approvals WHERE project_id = $1 AND kind = $2 ORDER BY at DESC, id DESC LIMIT 1', [o.p.id, tpl.needs]);
      if (!a.rowCount || a.rows[0].decision !== 'approved') missing.push(`${R.APPROVAL_LABELS[tpl.needs]} not recorded as approved`);
    }
    if (missing.length) { await client.query('ROLLBACK'); return res.status(422).json({ success: false, error: 'This stage cannot be completed yet', missing }); }
    if (b.confirm !== true) { await client.query('ROLLBACK'); return fail(res, 400, 'Confirm that you want to complete this stage'); }

    // duplicate-action guard: not straight after another completion on this project
    const recent = await client.query(`SELECT EXTRACT(EPOCH FROM (NOW() - MAX(completed_at)))::int AS ago FROM rd_stages WHERE project_id = $1 AND completed_at IS NOT NULL`, [o.p.id]);
    const ago = recent.rows[0].ago;
    if (ago !== null && ago < R.STAGE_COOLDOWN_SECONDS) {
      await client.query('ROLLBACK');
      return conflict(res, `Another stage of this project was completed ${ago} second${ago === 1 ? '' : 's'} ago. Check this stage carefully and try again in ${R.STAGE_COOLDOWN_SECONDS - ago} seconds.`, { retry_after: R.STAGE_COOLDOWN_SECONDS - ago, cooldown: true });
    }

    // conditional update: only one of several simultaneous requests can match
    const upd = await client.query(
      `UPDATE rd_stages SET actual_date = $1, completed_at = NOW(), completed_by = $2, review_flag = NULL, version = version + 1
        WHERE id = $3 AND completed_at IS NULL RETURNING id`, [date, req.user.id, o.stage.id]);
    if (!upd.rowCount) { await client.query('ROLLBACK'); return conflict(res, `Stage ${o.no} was completed by someone else a moment ago.`, { already: true }); }
    await client.query(`INSERT INTO rd_stage_history (stage_id, action, action_date, actor_id) VALUES ($1,'completed',$2,$3)`, [o.stage.id, date, req.user.id]);
    await client.query('UPDATE rd_projects SET updated_at = NOW() WHERE id = $1', [o.p.id]);
    await addUpdate(client, o.p.id, 'system', req, `Stage ${o.no} "${tpl.name}" completed on ${R.dmy(date)}`);
    await audit(client, req, { action: 'rd.stage_complete', entity: 'rd_stage', id: o.stage.id, summary: `${o.p.project_number} stage ${o.no} completed on ${R.dmy(date)}`, after: { date } });
    await client.query('COMMIT');
    res.json({ success: true, stage: o.no, date, next_stage: o.no < 8 ? o.no + 1 : null, all_complete: o.no === 8 });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('rd stage complete failed:', err); fail(res, 500, 'Could not complete the stage');
  } finally { client.release(); }
});

router.post('/projects/:id/stages/:no/reopen', needPerm(KEYS.RD_STAGE), async (req, res) => {
  const reason = str(req.body && req.body.reason);
  if (!reason) return fail(res, 400, 'Give a reason for reopening this stage');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = await openStage(req, res, client);
    if (!o) { await client.query('ROLLBACK'); return; }
    if (!o.acc.stage) { await client.query('ROLLBACK'); return fail(res, 403, 'You may not reopen stages of this project'); }
    if (o.p.status === 'Completed') { await client.query('ROLLBACK'); return conflict(res, 'The project is Completed. Change its status first, then reopen the stage.'); }
    if (!o.stage.completed_at) { await client.query('ROLLBACK'); return conflict(res, `Stage ${o.no} is not completed.`); }
    if (req.body.stage_version !== undefined && Number(req.body.stage_version) !== o.stage.version) { await client.query('ROLLBACK'); return conflict(res, 'This stage changed while you were looking at it. Reload and try again.', { current_version: o.stage.version }); }
    const old = o.stage.actual_date;
    await client.query(`INSERT INTO rd_stage_history (stage_id, action, action_date, reason, actor_id) VALUES ($1,'reopened',$2,$3,$4)`, [o.stage.id, old, reason, req.user.id]);
    await client.query('UPDATE rd_stages SET actual_date = NULL, completed_at = NULL, completed_by = NULL, version = version + 1 WHERE id = $1', [o.stage.id]);
    // later completed stages are NOT cleared; they are flagged so someone checks them
    const later = o.stages.filter(s => s.stage_no > o.no && s.completed_at);
    const flag = `Stage ${o.no} was reopened on ${R.dmy(today())}: ${reason}`;
    for (const s of later) await client.query('UPDATE rd_stages SET review_flag = $1 WHERE id = $2', [flag, s.id]);
    await client.query('UPDATE rd_projects SET updated_at = NOW() WHERE id = $1', [o.p.id]);
    await addUpdate(client, o.p.id, 'system', req, `Stage ${o.no} reopened (was completed ${R.dmy(old)}): ${reason}${later.length ? `. Later completed stages to review: ${later.map(s => s.stage_no).join(', ')}` : ''}`);
    await audit(client, req, { action: 'rd.stage_reopen', entity: 'rd_stage', id: o.stage.id, summary: `${o.p.project_number} stage ${o.no} reopened`, before: { completed: old }, reason });
    await client.query('COMMIT');
    res.json({ success: true, stage: o.no, affected_later_stages: later.map(s => s.stage_no) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('rd reopen failed:', err); fail(res, 500, 'Could not reopen the stage');
  } finally { client.release(); }
});

router.post('/projects/:id/complete', needPerm(KEYS.RD_STAGE), async (req, res) => {
  const b = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = await open(req, res, { db: client, lock: true });
    if (!o) { await client.query('ROLLBACK'); return; }
    if (!o.acc.stage) { await client.query('ROLLBACK'); return fail(res, 403, 'You may not complete this project'); }
    if (o.p.status === 'Completed') { await client.query('ROLLBACK'); return conflict(res, 'The project is already completed'); }
    if (['On Hold', 'Rejected'].includes(o.p.status)) { await client.query('ROLLBACK'); return conflict(res, `The project is ${o.p.status}. Change its status first.`); }
    const lite = toLite(await loadStages(client, o.p.id), o.p.est_trial_days);
    const open_ = lite.filter(s => !s.actual).map(s => s.no);
    if (open_.length) { await client.query('ROLLBACK'); return res.status(422).json({ success: false, error: 'Every stage must be completed first', missing: open_.map(n => `Stage ${n} is not completed`) }); }
    const flagged = (await client.query('SELECT stage_no FROM rd_stages WHERE project_id = $1 AND review_flag IS NOT NULL', [o.p.id])).rows.map(r => r.stage_no);
    if (flagged.length) { await client.query('ROLLBACK'); return res.status(422).json({ success: false, error: 'Stages flagged for review must be checked first', missing: flagged.map(n => `Stage ${n} is flagged after an earlier stage was reopened`) }); }
    const last = lite[7].actual, t = today();
    const date = b.date || t;
    if (!R.isValidDate(date) || date > t || date < last) { await client.query('ROLLBACK'); return fail(res, 400, `Completion date must be between ${R.dmy(last)} and ${R.dmy(t)}`); }
    if (b.confirm !== true) { await client.query('ROLLBACK'); return fail(res, 400, 'Confirm that you want to mark this project completed'); }
    if (!(await changeProject(client, req, res, o, b.version, { status: 'Completed', completed_on: date, status_before_hold: null }, { action: 'rd.complete', summary: `${o.p.project_number} completed on ${R.dmy(date)}` }))) { await client.query('ROLLBACK'); return; }
    await addUpdate(client, o.p.id, 'system', req, `Project completed on ${R.dmy(date)}`);
    await client.query('COMMIT');
    res.json({ success: true, completed_on: date });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err); fail(res, 500, 'Could not complete the project');
  } finally { client.release(); }
});

// ---------------------------------------------------------------------------------------------------------------
// approvals (append-only records; the person recorded is always the signed-in one)
// ---------------------------------------------------------------------------------------------------------------
const APPROVAL_PERM = { rd_head: KEYS.RD_APPROVE_HEAD, management: KEYS.RD_APPROVE_MGMT, qc_signoff: KEYS.RD_QC_SIGNOFF, handover_ack: KEYS.RD_HANDOVER_ACK, customer: KEYS.RD_EDIT };
const APPROVAL_STAGE = { qc_signoff: 4, customer: 6, handover_ack: 8 };
router.post('/projects/:id/approvals', requirePermissionAny([KEYS.RD_EDIT, KEYS.RD_APPROVE_HEAD, KEYS.RD_APPROVE_MGMT, KEYS.RD_QC_SIGNOFF, KEYS.RD_HANDOVER_ACK]), async (req, res) => {
  const b = req.body || {};
  if (!APPROVAL_PERM[b.kind]) return fail(res, 400, 'Kind must be one of: ' + Object.keys(APPROVAL_PERM).join(', '));
  if (!['approved', 'rejected', 'returned'].includes(b.decision)) return fail(res, 400, 'Decision must be approved, rejected or returned');
  if (!can(req.access, APPROVAL_PERM[b.kind])) return fail(res, 403, `You are not authorised to record: ${R.APPROVAL_LABELS[b.kind]}`);
  const remarks = String(b.remarks || '').trim();
  if (b.decision !== 'approved' && !remarks) return fail(res, 400, 'Give remarks when rejecting or returning for information');
  let date = b.decision_date || today();
  if (!R.isValidDate(date) || date > today()) return fail(res, 400, 'Decision date must be a valid date that is not in the future');
  let rep = null, evidence = '';
  if (b.kind === 'customer') {
    // external approval: who the customer is, what the evidence is, and the INTERNAL person recording it
    rep = str(b.external_rep); evidence = String(b.evidence || '').trim();
    if (!rep || !evidence) return fail(res, 400, 'Record the customer representative and the evidence (for example the e-mail or letter reference)');
  }
  try {
    const o = await open(req, res); if (!o) return;
    if (o.p.is_draft || !(o.acc.edit || can(req.access, APPROVAL_PERM[b.kind]) && (can(req.access, KEYS.RD_VIEW_ALL) || o.acc.involved))) return fail(res, 403, 'You may not record decisions on this project');
    const r = await pool.query(
      `INSERT INTO rd_approvals (project_id, stage_no, kind, decision, decision_date, remarks, external_rep, evidence, decided_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [o.p.id, APPROVAL_STAGE[b.kind] || null, b.kind, b.decision, date, remarks, rep, evidence, req.user.id]);
    await addUpdate(pool, o.p.id, 'system', req, `${R.APPROVAL_LABELS[b.kind]}: ${b.decision}${remarks ? ' - ' + remarks : ''}`);
    await audit(pool, req, { action: 'rd.approval', entity: 'rd_project', id: o.p.id, summary: `${o.p.project_number} ${R.APPROVAL_LABELS[b.kind]}: ${b.decision}`, after: { kind: b.kind, decision: b.decision } });
    await pool.query('UPDATE rd_projects SET updated_at = NOW() WHERE id = $1', [o.p.id]);
    res.status(201).json({ success: true, id: r.rows[0].id });
  } catch (err) { console.error('rd approval failed:', err); fail(res, 500, 'Could not record the decision'); }
});

// ---------------------------------------------------------------------------------------------------------------
// tasks and notes
// ---------------------------------------------------------------------------------------------------------------
function readTask(b) {
  const out = {};
  if ('title' in b) out.title = String(b.title || '').trim().slice(0, 250);
  if ('description' in b) out.description = String(b.description || '').trim().slice(0, 4000);
  if ('priority' in b) out.priority = b.priority;
  if ('status' in b) out.status = b.status;
  if ('due_date' in b) out.due_date = b.due_date || null;
  if ('assignee_id' in b) out.assignee_id = b.assignee_id == null || b.assignee_id === '' ? null : idOf(b.assignee_id);
  if ('team' in b) out.team = str(b.team);
  if ('stage_no' in b) out.stage_no = b.stage_no == null || b.stage_no === '' ? null : Number(b.stage_no);
  return out;
}
function checkTask(t) {
  if ('title' in t && !t.title) return 'A task needs a title';
  if ('priority' in t && !R.PRIORITIES.includes(t.priority)) return 'Priority must be High, Medium or Low';
  if ('status' in t && !['todo', 'in_progress', 'blocked', 'done'].includes(t.status)) return 'Status must be to do, in progress, blocked or done';
  if ('due_date' in t && t.due_date && !R.isValidDate(t.due_date)) return 'Due date is not a valid date';
  if ('stage_no' in t && t.stage_no != null && !(Number.isInteger(t.stage_no) && t.stage_no >= 1 && t.stage_no <= 8)) return 'Stage must be 1 to 8';
  if ('team' in t && t.team && !R.DEPARTMENTS.includes(t.team)) return 'Team must be one of the departments';
  return null;
}

router.post('/projects/:id/tasks', needPerm(KEYS.RD_EDIT), async (req, res) => {
  const t = readTask({ priority: 'Medium', ...(req.body || {}) });
  const problem = checkTask(t) || (!t.title ? 'A task needs a title' : null);
  if (problem) return fail(res, 400, problem);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = await open(req, res, { db: client });
    if (!o) { await client.query('ROLLBACK'); return; }
    if (!o.acc.edit || o.p.is_draft) { await client.query('ROLLBACK'); return fail(res, 403, 'You may not add tasks to this project'); }
    if (t.assignee_id) { const u = await client.query('SELECT 1 FROM users WHERE id = $1 AND active', [t.assignee_id]); if (!u.rowCount) { await client.query('ROLLBACK'); return fail(res, 400, 'That person is not an active user'); } }
    const r = await client.query(
      `INSERT INTO rd_tasks (project_id, stage_no, title, description, priority, assignee_id, team, due_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [o.p.id, t.stage_no || null, t.title, t.description || '', t.priority, t.assignee_id || null, t.assignee_id ? null : (t.team || null), t.due_date || null, req.user.id]);
    await addUpdate(client, o.p.id, 'system', req, `Task added: ${t.title}`, r.rows[0].id);
    await audit(client, req, { action: 'rd.task_add', entity: 'rd_task', id: r.rows[0].id, summary: `${o.p.project_number}: task "${t.title}" added` });
    await client.query('UPDATE rd_projects SET updated_at = NOW() WHERE id = $1', [o.p.id]);
    await client.query('COMMIT');
    res.status(201).json({ success: true, id: r.rows[0].id });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err); fail(res, 500, 'Could not add the task');
  } finally { client.release(); }
});

router.patch('/tasks/:id', requirePermissionAny([KEYS.RD_VIEW, KEYS.RD_EDIT]), async (req, res) => {
  const b = req.body || {};
  const taskId = idOf(req.params.id);
  if (!taskId) return fail(res, 400, 'Invalid task id');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tr = await client.query('SELECT * FROM rd_tasks WHERE id = $1 FOR UPDATE', [taskId]);
    const task = norm(tr.rows[0]);
    if (!task) { await client.query('ROLLBACK'); return fail(res, 404, 'Task not found'); }
    req.params.id = String(task.project_id);
    const o = await open(req, res, { db: client });
    if (!o) { await client.query('ROLLBACK'); return; }
    const t = readTask(b);
    const keys = Object.keys(t);
    // the person responsible may update the status of their own task; everything else needs edit rights on the project
    const own = task.assignee_id === req.user.id && keys.every(k => k === 'status');
    if (!(o.acc.edit || own)) { await client.query('ROLLBACK'); return fail(res, 403, 'You may not change this task'); }
    const problem = checkTask(t);
    if (problem) { await client.query('ROLLBACK'); return fail(res, 400, problem); }
    if (Number(b.version) !== task.version) { await client.query('ROLLBACK'); return conflict(res, 'This task was changed by someone else. Reload and try again.', { current_version: task.version }); }
    if (t.assignee_id) { const u = await client.query('SELECT 1 FROM users WHERE id = $1 AND active', [t.assignee_id]); if (!u.rowCount) { await client.query('ROLLBACK'); return fail(res, 400, 'That person is not an active user'); } }
    const sets = { ...t };
    if ('assignee_id' in t && t.assignee_id) sets.team = null;           // claimed: no longer an unclaimed team task
    if ('status' in t) sets.completed_at = t.status === 'done' ? new Date() : null;
    const changed = Object.keys(sets).filter(k => k !== 'completed_at');
    if (!changed.length) { await client.query('ROLLBACK'); return fail(res, 400, 'Nothing to change'); }
    const cols = Object.keys(sets);
    const upd = await client.query(`UPDATE rd_tasks SET ${cols.map((k, i) => `${k} = $${i + 1}`).join(', ')}, version = version + 1 WHERE id = $${cols.length + 1} AND version = $${cols.length + 2} RETURNING id`, [...cols.map(k => sets[k]), taskId, task.version]);
    if (!upd.rowCount) { await client.query('ROLLBACK'); return conflict(res, 'This task was changed at the same moment. Reload and try again.'); }
    if ('status' in t && t.status !== task.status) await addUpdate(client, o.p.id, 'system', req, `Task "${task.title}": ${task.status} -> ${t.status}`, taskId);
    await audit(client, req, { action: 'rd.task_edit', entity: 'rd_task', id: taskId, summary: `${o.p.project_number}: task "${task.title}" changed (${changed.join(', ')})`, before: Object.fromEntries(changed.map(k => [k, task[k]])), after: Object.fromEntries(changed.map(k => [k, sets[k]])) });
    await client.query('UPDATE rd_projects SET updated_at = NOW() WHERE id = $1', [o.p.id]);
    await client.query('COMMIT');
    res.json({ success: true, version: task.version + 1 });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('rd task failed:', err); fail(res, 500, 'Could not save the task');
  } finally { client.release(); }
});

router.post('/projects/:id/updates', requirePermissionAny([KEYS.RD_VIEW, KEYS.RD_CREATE]), async (req, res) => {
  const kind = req.body && req.body.kind;
  const body = String((req.body && req.body.body) || '').trim();
  if (!['comment', 'lab_note'].includes(kind)) return fail(res, 400, 'Kind must be comment or lab_note');
  if (!body) return fail(res, 400, 'Write something first');
  if (body.length > 5000) return fail(res, 400, 'That is too long (5000 characters at most)');
  try {
    const o = await open(req, res); if (!o) return;
    if (o.p.is_draft) return fail(res, 409, 'The request has not been submitted yet');
    // lab observations are confidential technical content; discussion comments are open to anyone who can see the project
    if (kind === 'lab_note' && !(o.acc.edit && o.acc.technical)) return fail(res, 403, 'Lab notes can only be written by R&D staff who may see confidential content');
    await addUpdate(pool, o.p.id, kind, req, body);
    await pool.query('UPDATE rd_projects SET updated_at = NOW() WHERE id = $1', [o.p.id]);
    res.status(201).json({ success: true });
  } catch (err) { console.error(err); fail(res, 500, 'Could not save'); }
});

module.exports = router;
