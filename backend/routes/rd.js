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
const { notifyUsers, notifyRole } = require('../notify');
const cover = require('./rd-cover');

// Notices by email and WhatsApp (when switched on; each person may turn them off). Never allowed to fail the action that caused them.
/** Notices for whoever a task is assigned to also reach the person covering for them today ("You are covering for ..."). */
async function tellWithCover(ids, kind, subject, text, path, exceptId) {
  try {
    const list = (ids || []).filter(x => x && x !== exceptId);
    notifyUsers(list, { kind, subject, text, path });
    const covers = (await cover.coversOf(pool, list)).filter(c => c.cover_user_id !== exceptId && !list.includes(c.cover_user_id));
    for (const c of covers) notifyUsers([c.cover_user_id], { kind, subject, text: `You are covering for ${c.absent_name}. ${text}`, path });
  } catch (e) { console.error('notice failed:', e.message); }
}
const tell = (ids, kind, subject, text, path, exceptId) => { try { notifyUsers((ids || []).filter(x => x && x !== exceptId), { kind, subject, text, path }); } catch (e) { console.error('notice failed:', e.message); } };
/** The people who check a task's work: whoever assigned it and the owner (or lead) of the stage it belongs to. */
async function reviewersOf(task) {
  const ids = [task.created_by];
  if (task.stage_no) { const r = await pool.query('SELECT COALESCE(s.owner_user_id, p.lead_user_id) AS uid FROM rd_stages s JOIN rd_projects p ON p.id = s.project_id WHERE s.project_id = $1 AND s.stage_no = $2', [task.project_id, task.stage_no]); if (r.rows[0]) ids.push(r.rows[0].uid); }
  return [...new Set(ids.filter(Boolean))];
}
const announceRequest = (req, id, number, title) => { try { notifyRole('rd', req.user.id, { kind: 'request', subject: `New R&D request ${number}`, text: `"${title}" was submitted by ${req.user.name} and is waiting to be assessed.`, path: `project.html?id=${id}` }); } catch (e) { console.error('notice failed:', e.message); } };
const router = express.Router();
router.use('/cover', cover.router);

// ---------------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------------
/** DATE columns arrive as local-midnight Date objects; format them with LOCAL getters so no time-zone shift is possible. */
function ymd(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  return v.getFullYear() + '-' + String(v.getMonth() + 1).padStart(2, '0') + '-' + String(v.getDate()).padStart(2, '0');
}
// statuses that still need someone's attention; done and cancelled are finished
const OPEN_TASK = ['todo', 'in_progress', 'blocked', 'in_review'];
const DATE_COLS = ['request_date', 'target_launch_date', 'completed_on', 'planned_date', 'actual_date', 'due_date', 'decision_date', 'action_date'];
/** Adds 'within' / 'above' / 'below' for numbers that have an expected range, so every screen can show the same flag. */
function withFlags(t) { if (t) t.range_flags = t.result_schema && t.result_data ? R.rangeFlags(t.result_schema, t.result_data) : null; return t; }
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
  if (!acc.visible && opts && opts.coverVisible && !p.is_draft) acc.visible = true;     // covering the task's owner: may open the project, but gets no edit rights
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
    form_templates: R.FORM_TEMPLATES, form_limits: { max_fields: R.MAX_FORM_FIELDS },
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
// People who can be chosen as project lead, team member, stage owner or task assignee: R&D-related roles only.
// Anyone already assigned on the project (lead, member, stage owner, task assignee) stays in the list so a saved choice never vanishes.
const RD_TEAM_ROLES = ['rd', 'rd_trainee', 'qc', 'manager', 'admin'];
router.get('/people', needPerm(KEYS.RD_EDIT), async (req, res) => {
  try {
    const pid = idOf(req.query.project);
    const r = await pool.query(
      `SELECT u.id, u.name, array_agg(DISTINCT ur.role) AS roles FROM users u JOIN user_roles ur ON ur.user_id = u.id
        WHERE u.active AND (ur.user_id IN (SELECT user_id FROM user_roles WHERE role = ANY($1))
          OR ($2::int IS NOT NULL AND u.id IN (
               SELECT lead_user_id FROM rd_projects WHERE id = $2 UNION
               SELECT user_id FROM rd_project_members WHERE project_id = $2 UNION
               SELECT owner_user_id FROM rd_stages WHERE project_id = $2 UNION
               SELECT assignee_id FROM rd_tasks WHERE project_id = $2)))
        GROUP BY u.id, u.name ORDER BY u.name`, [RD_TEAM_ROLES, pid]);
    const away = await cover.awayToday(pool, r.rows.map(x => x.id));
    res.json({ success: true, people: r.rows.map(x => ({ ...x, away: away.get(x.id) || null })) });
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
              (SELECT COUNT(*)::int FROM rd_tasks t WHERE t.project_id = p.id AND t.status NOT IN ('done','cancelled')) AS open_tasks,
              (SELECT COUNT(*)::int FROM rd_tasks t WHERE t.project_id = p.id AND t.status NOT IN ('done','cancelled','in_review') AND t.due_date < (now() AT TIME ZONE 'Asia/Kolkata')::date) AS overdue_tasks,
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

// open tasks assigned to the signed-in person, on projects they may open (same visibility clause as the list)
router.get('/my-tasks', requirePermissionAny([KEYS.RD_VIEW, KEYS.RD_CREATE]), async (req, res) => {
  try {
    const vis = visibleClause(req.access, req.user.id, 'p', 0);
    const r = await pool.query(
      `SELECT t.id, t.title, t.status, t.priority, t.due_date, t.project_id, p.project_number, p.title AS project_title
         FROM rd_tasks t JOIN rd_projects p ON p.id = t.project_id
        WHERE t.assignee_id = $1 AND t.status NOT IN ('done','cancelled','in_review') AND p.is_draft = FALSE AND ${vis.clause}
        ORDER BY t.due_date NULLS LAST, t.id LIMIT 50`, vis.params);
    res.json({ success: true, tasks: r.rows.map(x => norm(x)) });
  } catch (err) { console.error('rd my-tasks failed:', err); fail(res, 500, 'Could not load your tasks'); }
});

/**
 * "My day": what this person should do next. Their open tasks, the tasks they handed to others, the stages they own and
 * what was finished in the last week. Only projects they may open (same visibility clause as the list).
 */
router.get('/my-day', requirePermissionAny([KEYS.RD_VIEW, KEYS.RD_CREATE]), async (req, res) => {
  try {
    const vis = visibleClause(req.access, req.user.id, 'p', 0);                // $1 is the person, $2-$4 their visibility
    const params = [...vis.params, ['Completed', 'Rejected']];                  // $5: closed statuses are left out
    const live = `p.is_draft = FALSE AND NOT (p.status = ANY($5)) AND ${vis.clause}`;
    const cols = `t.id, t.title, t.description, t.result_schema, t.result_data, t.status, t.priority, t.due_date, t.stage_no, t.project_id, t.completed_at, t.result, t.version, t.requires_review, t.expects_trial, t.review_note, t.checklist_item_id, ci.label AS checklist_label,
                  p.project_number, p.title AS project_title, p.status AS project_status,
                  au.name AS assignee_name, cr.name AS assigned_by_name, cb.name AS completed_by_name`;
    const from = `FROM rd_tasks t JOIN rd_projects p ON p.id = t.project_id LEFT JOIN users au ON au.id = t.assignee_id
                  LEFT JOIN users cr ON cr.id = t.created_by LEFT JOIN users cb ON cb.id = t.completed_by LEFT JOIN rd_checklist_items ci ON ci.id = t.checklist_item_id`;
    const week = "t.completed_at > NOW() - INTERVAL '7 days'";
    const reviewer = `(t.created_by = $1 OR (t.stage_no IS NOT NULL AND EXISTS (SELECT 1 FROM rd_stages rs WHERE rs.project_id = t.project_id AND rs.stage_no = t.stage_no AND (rs.owner_user_id = $1 OR (rs.owner_user_id IS NULL AND p.lead_user_id = $1)))))`;
    const [mine, doneByMe, assigned, assignedDone, stages, submitted, toReview] = await Promise.all([
      pool.query(`SELECT ${cols} ${from} WHERE t.assignee_id = $1 AND t.status NOT IN ('done','cancelled','in_review') AND ${live} ORDER BY t.due_date NULLS LAST, t.id LIMIT 100`, params),
      pool.query(`SELECT ${cols} ${from} WHERE t.assignee_id = $1 AND t.status = 'done' AND ${week} AND ${live} ORDER BY t.completed_at DESC LIMIT 10`, params),
      pool.query(`SELECT ${cols} ${from} WHERE t.created_by = $1 AND t.assignee_id IS NOT NULL AND t.assignee_id <> $1 AND t.status NOT IN ('done','cancelled','in_review') AND ${live} ORDER BY t.due_date NULLS LAST, t.id LIMIT 100`, params),
      pool.query(`SELECT ${cols} ${from} WHERE t.created_by = $1 AND t.assignee_id IS NOT NULL AND t.assignee_id <> $1 AND t.status = 'done' AND ${week} AND ${live} ORDER BY t.completed_at DESC LIMIT 10`, params),
      pool.query(
        `SELECT p.id AS project_id, p.project_number, p.title AS project_title, p.status AS project_status, s.stage_no, s.planned_date,
                (SELECT COUNT(*)::int FROM rd_checklist_items c WHERE c.stage_id = s.id AND NOT c.done) AS items_left
           FROM rd_projects p JOIN rd_stages s ON s.project_id = p.id
          WHERE ${live} AND s.completed_at IS NULL
            AND s.stage_no = (SELECT MIN(x.stage_no) FROM rd_stages x WHERE x.project_id = p.id AND x.completed_at IS NULL)
            AND (s.owner_user_id = $1 OR (s.owner_user_id IS NULL AND p.lead_user_id = $1))
          ORDER BY s.planned_date NULLS LAST, p.id`, params),
      pool.query(`SELECT ${cols} ${from} WHERE t.assignee_id = $1 AND t.status = 'in_review' AND ${live} ORDER BY t.completed_at`, params),
      pool.query(`SELECT ${cols} ${from} WHERE t.status = 'in_review' AND t.assignee_id IS NOT NULL AND t.assignee_id <> $1 AND ${reviewer} AND ${live} ORDER BY t.completed_at`, params)
    ]);
    const rows = (r) => r.rows.map(x => withFlags(norm(x)));
    // tasks of people I am covering for today (while they are away), and my own upcoming absences
    const covered = await cover.coveredBy(pool, req.user.id);
    const covering = [];
    for (const c of covered) {
      const q = await pool.query(`SELECT ${cols} ${from} WHERE t.assignee_id = $1 AND t.status NOT IN ('done','cancelled','in_review') AND p.is_draft = FALSE AND NOT (p.status = ANY($2)) ORDER BY t.due_date NULLS LAST, t.id LIMIT 100`, [c.user_id, ['Completed', 'Rejected']]);
      // the reviews waiting for that person, and the stages they own, so nothing waits for their return
      const rvw = await pool.query(`SELECT ${cols} ${from} WHERE t.status = 'in_review' AND t.assignee_id IS NOT NULL AND t.assignee_id <> $1 AND t.completed_by IS DISTINCT FROM $1 AND t.assignee_id <> $3 AND t.completed_by IS DISTINCT FROM $3
        AND p.is_draft = FALSE AND NOT (p.status = ANY($2)) AND (t.created_by = $1 OR (t.stage_no IS NOT NULL AND EXISTS (SELECT 1 FROM rd_stages rs WHERE rs.project_id = t.project_id AND rs.stage_no = t.stage_no AND COALESCE(rs.owner_user_id, p.lead_user_id) = $1))) ORDER BY t.completed_at`, [c.user_id, ['Completed', 'Rejected'], req.user.id]);
      const stg = await pool.query(
        `SELECT p.id AS project_id, p.project_number, p.title AS project_title, s.stage_no, s.planned_date, (SELECT COUNT(*)::int FROM rd_checklist_items ci WHERE ci.stage_id = s.id AND NOT ci.done) AS items_left
           FROM rd_projects p JOIN rd_stages s ON s.project_id = p.id WHERE p.is_draft = FALSE AND NOT (p.status = ANY($2)) AND s.completed_at IS NULL
            AND s.stage_no = (SELECT MIN(x.stage_no) FROM rd_stages x WHERE x.project_id = p.id AND x.completed_at IS NULL) AND COALESCE(s.owner_user_id, p.lead_user_id) = $1 ORDER BY s.planned_date NULLS LAST, p.id`, [c.user_id, ['Completed', 'Rejected']]);
      covering.push({ ...c, tasks: rows(q), reviews: rows(rvw), stages: rows(stg).map(x => ({ ...x, stage_name: R.STAGES[x.stage_no - 1].name })) });
    }
    const away = await pool.query(`SELECT a.id, a.kind, a.cover_status, a.approval_status, a.from_date::text AS from_date, a.to_date::text AS to_date, cu.name AS cover_name FROM rd_absences a LEFT JOIN users cu ON cu.id = a.cover_user_id WHERE a.user_id = $1 AND a.ended_at IS NULL AND a.to_date >= $2 ORDER BY a.from_date`, [req.user.id, today()]);
    res.json({
      success: true, today: today(), covering, my_absences: away.rows, mine: rows(mine), done_by_me: rows(doneByMe), assigned: rows(assigned), assigned_done: rows(assignedDone), submitted: rows(submitted), to_review: rows(toReview),
      stages: rows(stages).map(x => ({ ...x, stage_name: R.STAGES[x.stage_no - 1].name }))
    });
  } catch (err) { console.error('rd my-day failed:', err); fail(res, 500, 'Could not load your day'); }
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
    if (submitting) announceRequest(req, id, number, ins.rows[0].title);
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
    announceRequest(req, o.p.id, number, o.p.title);
    res.json({ success: true, id: o.p.id, project_number: number });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('rd submit failed:', err); fail(res, 500, 'Could not submit the request');
  } finally { client.release(); }
});

/** Everything one project screen needs, with confidential content removed for people without access to it. */
/** What the project's Overview shows about its lab trials: how many, the latest result and the preferred formula. Nothing confidential (the formula name only with technical access). */
async function trialsSummary(p, technical) {
  if (p.is_draft) return { count: 0 };
  const [rows, reqs] = await Promise.all([
    pool.query(`SELECT t.id, t.trial_no, t.stage_no, t.trial_date, t.outcome, t.formula_ref,
                       COUNT(r.id) FILTER (WHERE r.result = 'Pass')::int AS pass, COUNT(r.id) FILTER (WHERE r.result = 'Fail')::int AS fail
                  FROM rd_trials t LEFT JOIN rd_trial_results r ON r.trial_id = t.id WHERE t.project_id = $1 GROUP BY t.id ORDER BY t.trial_no`, [p.id]),
    pool.query('SELECT COUNT(*)::int AS n FROM rd_requirements WHERE project_id = $1', [p.id])
  ]);
  const total = reqs.rows[0].n, list = rows.rows;
  if (!list.length) return { count: 0, total };
  const last = list[list.length - 1], prev = list.length > 1 ? list[list.length - 2] : null, pref = list.find(x => x.outcome === 'Preferred formula');
  const lastDate = ymd(last.trial_date), t = today();
  return { count: list.length, total, last_date: lastDate, days_since: R.daysBetween(lastDate, t),
    latest: { label: R.trialLabel(last.trial_no), date: lastDate, outcome: last.outcome, pass: last.pass, fail: last.fail },
    previous: prev ? { label: R.trialLabel(prev.trial_no), pass: prev.pass } : null,
    preferred: pref ? { label: R.trialLabel(pref.trial_no), ...(technical ? { formula_ref: pref.formula_ref } : {}) } : null,
    series: list.map(x => ({ label: R.trialLabel(x.trial_no), pass: x.pass })) };
}

async function detail(req, p, members, acc) {
  const t = today();
  const trialCounts = (await pool.query('SELECT stage_no, COUNT(*)::int AS n FROM rd_trials WHERE project_id = $1 GROUP BY stage_no', [p.id])).rows;
  const trialsAt = (no) => (trialCounts.find(x => x.stage_no === no) || { n: 0 }).n;
  const [reqs, stageRows, items, tasks, updates, approvals, mem, fav, people] = await Promise.all([
    pool.query('SELECT * FROM rd_requirements WHERE project_id = $1 ORDER BY position', [p.id]),
    pool.query('SELECT s.*, ou.name AS owner_name, cu.name AS completed_by_name FROM rd_stages s LEFT JOIN users ou ON ou.id = s.owner_user_id LEFT JOIN users cu ON cu.id = s.completed_by WHERE s.project_id = $1 ORDER BY s.stage_no', [p.id]),
    pool.query('SELECT c.*, u.name AS done_by_name FROM rd_checklist_items c JOIN rd_stages s ON s.id = c.stage_id LEFT JOIN users u ON u.id = c.done_by WHERE s.project_id = $1 ORDER BY c.stage_id, c.position', [p.id]),
    pool.query('SELECT t.*, au.name AS assignee_name, cb.name AS completed_by_name, cr.name AS assigned_by_name, rb.name AS reviewed_by_name, ob.name AS on_behalf_name, ci.label AS checklist_label FROM rd_tasks t LEFT JOIN users au ON au.id = t.assignee_id LEFT JOIN users cb ON cb.id = t.completed_by LEFT JOIN users cr ON cr.id = t.created_by LEFT JOIN users rb ON rb.id = t.reviewed_by LEFT JOIN users ob ON ob.id = t.on_behalf_of LEFT JOIN rd_checklist_items ci ON ci.id = t.checklist_item_id WHERE t.project_id = $1 ORDER BY (t.status = \'done\'), t.due_date NULLS LAST, t.id', [p.id]),
    pool.query(`SELECT id, task_id, kind, author_name, body, at FROM rd_updates WHERE project_id = $1 AND ($2 OR kind <> 'lab_note') ORDER BY at DESC, id DESC LIMIT 100`, [p.id, acc.technical]),
    pool.query('SELECT a.*, u.name AS decided_by_name FROM rd_approvals a LEFT JOIN users u ON u.id = a.decided_by WHERE a.project_id = $1 ORDER BY a.at, a.id', [p.id]),
    pool.query('SELECT u.id, u.name FROM rd_project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = $1 ORDER BY u.name', [p.id]),
    pool.query('SELECT favourite FROM rd_user_projects WHERE user_id = $1 AND project_id = $2', [req.user.id, p.id]),
    p.lead_user_id ? pool.query('SELECT id, name FROM users WHERE id = $1', [p.lead_user_id]) : { rows: [] }
  ]);
  const lead = people.rows[0] || null;
  const latest = (kind) => approvals.rows.filter(a => a.kind === kind).pop() || null;
  const by = new Map(); items.rows.forEach(c => { if (!by.has(c.stage_id)) by.set(c.stage_id, []); by.get(c.stage_id).push({ id: c.id, label: c.label, done: c.done, needs_result: R.needsResult(c.label), done_by_name: c.done_by_name || null, done_at: c.done_at,
    // the result is lab content: shown only with the confidential technical permission, like lab notes
    result: acc.technical ? (c.result || null) : null, result_hidden: !acc.technical && !!c.result, result_at: c.result_at || null }); });

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
    // work the stage owner handed to other people: it must be finished (or cancelled with a reason) before the stage closes
    const linked = tasks.rows.filter(x => x.stage_no === s.stage_no && x.status !== 'cancelled');
    const openLinked = linked.filter(x => OPEN_TASK.includes(x.status));
    if (!done && openLinked.length) missing.push(`${openLinked.length} assigned task${openLinked.length === 1 ? '' : 's'} not finished`);
    const work = { total: linked.length, done: linked.filter(x => x.status === 'done').length, in_review: linked.filter(x => x.status === 'in_review').length,
      overdue: openLinked.filter(x => x.status !== 'in_review' && x.due_date && ymd(x.due_date) < t).length, people: [...new Set(linked.map(x => x.assignee_name).filter(Boolean))] };
    return {
      no: s.stage_no, name: tpl.name, days: l.days, planned: l.planned, actual: l.actual, remarks: s.remarks, version: s.version,
      owner: s.owner_user_id ? { id: s.owner_user_id, name: s.owner_name, explicit: true } : (lead ? { id: lead.id, name: lead.name, explicit: false } : null),
      completed_at: s.completed_at, completed_by_name: s.completed_by_name, review_flag: s.review_flag,
      trial_count: R.TRIAL_STAGES.includes(s.stage_no) ? trialsAt(s.stage_no) : null,
      no_trial_warning: !done && R.TRIAL_STAGES.includes(s.stage_no) && trialsAt(s.stage_no) === 0,        // a warning only: it never blocks completing the stage
      state: done ? 'done' : s.stage_no === currentNo ? 'current' : 'pending',
      delay: R.delayDays({ planned: l.planned, actual: l.actual }, t),
      overdue: !done && !!l.planned && t > l.planned,
      needs: tpl.needs || null, checklist, missing, work
    };
  });
  const cur = stages.find(s => s.state === 'current') || null;
  const out = {
    project: { ...p }, requirements: reqs.rows, stages, today: t, current_stage_no: currentNo,
    progress: { done: stages.filter(s => s.state === 'done').length, total: 8 },
    conflicts: R.findConflicts(lite, p.target_launch_date),
    next_step: cur && { stage: cur.no, name: cur.name, owner: cur.owner, due: cur.planned, overdue: cur.overdue, checklist: cur.checklist, missing: cur.missing },
    tasks: tasks.rows.map(x => withFlags(norm(x))), updates: updates.rows, approvals: approvals.rows.map(norm),
    members: mem.rows, lead, favourite: fav.rows[0] ? fav.rows[0].favourite : false,
    covering_ids: (await cover.coveredBy(pool, req.user.id)).map(c => c.user_id),       // people I am covering for today: I may do their tasks
    can: { ...acc, create_task: acc.edit && !p.is_draft, trial_view: req.access.isAdmin || can(req.access, KEYS.RD_TRIAL_VIEW), trial_edit: (req.access.isAdmin || can(req.access, KEYS.RD_TRIAL_EDIT)) && can(req.access, KEYS.FIELD_RD_TECHNICAL) }
  };
  out.project.lead_name = lead ? lead.name : null;
  if (out.can.trial_view) out.trials_summary = await trialsSummary(p, acc.technical);
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
    const body = req.body || {};
    const done = !!body.done;
    const it = await client.query('SELECT * FROM rd_checklist_items WHERE id = $1 AND stage_id = $2 FOR UPDATE', [idOf(req.params.item), o.stage.id]);
    const item = it.rows[0];
    if (!item) { await client.query('ROLLBACK'); return fail(res, 404, 'Checklist item not found'); }
    // A result (what was found) is lab content: only people who may see it may write it, and an item that needs one cannot be ticked without it.
    const writes = 'result' in body;
    const text = writes ? String(body.result == null ? '' : body.result).trim() : null;
    if (writes && text.length > R.MAX_RESULT_LENGTH) { await client.query('ROLLBACK'); return fail(res, 400, `The result is too long (at most ${R.MAX_RESULT_LENGTH} characters)`); }
    if (writes && text && !o.acc.technical) { await client.query('ROLLBACK'); return fail(res, 403, 'Recording a result needs R&D technical access'); }
    const effective = writes ? text : (item.result || '');
    if (done && R.needsResult(item.label) && !effective) {
      await client.query('ROLLBACK');
      return fail(res, 400, o.acc.technical ? 'Record what was found before ticking this item' : 'This item needs a result, and recording one needs R&D technical access');
    }
    const sets = ['done = $1', 'done_by = $2', 'done_at = $3'];
    const vals = [done, done ? req.user.id : null, done ? new Date() : null];
    if (writes) { sets.push(`result = $${vals.length + 1}`); vals.push(text || null); sets.push(`result_at = $${vals.length + 1}`); vals.push(text ? new Date() : null); }
    vals.push(item.id);
    await client.query(`UPDATE rd_checklist_items SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    await client.query('UPDATE rd_projects SET updated_at = NOW() WHERE id = $1', [o.p.id]);
    // The audit line names the item and the action only. The result text is never copied into the audit log.
    await audit(client, req, { action: 'rd.checklist', entity: 'rd_project', id: o.p.id,
      summary: `${o.p.project_number}: stage ${o.stage.stage_no} item "${item.label}" ${done ? (writes && item.done ? 'result updated' : 'ticked') : 'unticked'}${writes && text ? ' with a result' : ''}` });
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
    const openWork = await client.query("SELECT COUNT(*)::int n FROM rd_tasks WHERE project_id = $1 AND stage_no = $2 AND status IN ('todo','in_progress','blocked','in_review')", [o.p.id, o.no]);
    if (openWork.rows[0].n) missing.push(`${openWork.rows[0].n} assigned task${openWork.rows[0].n === 1 ? '' : 's'} not finished`);
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
    // a warning only: stages 2 and 3 can still be completed without a recorded lab trial, but it is written down so nobody has to guess
    const noTrial = R.TRIAL_STAGES.includes(o.no) && (await client.query('SELECT 1 FROM rd_trials WHERE project_id = $1 AND stage_no = $2 LIMIT 1', [o.p.id, o.no])).rowCount === 0;
    await addUpdate(client, o.p.id, 'system', req, `Stage ${o.no} "${tpl.name}" completed on ${R.dmy(date)}` + (noTrial ? ' (no lab trial was recorded for this stage)' : ''));
    await audit(client, req, { action: 'rd.stage_complete', entity: 'rd_stage', id: o.stage.id, summary: `${o.p.project_number} stage ${o.no} completed on ${R.dmy(date)}` + (noTrial ? ' without a recorded lab trial' : ''), after: noTrial ? { date, no_lab_trial: true } : { date } });
    await client.query('COMMIT');
    tell([o.p.requested_by_user, o.p.lead_user_id], 'stage', `Stage ${o.no} complete: ${o.p.project_number}`, `${req.user.name} completed stage ${o.no} (${tpl.name}) of ${o.p.project_number} "${o.p.title}".${o.no < 8 ? ' Next is stage ' + (o.no + 1) + '.' : ' All stages are complete.'}`, `project.html?id=${o.p.id}`, req.user.id);
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
    tell([o.p.requested_by_user, o.p.lead_user_id], 'project', `Project completed: ${o.p.project_number}`, `${req.user.name} marked ${o.p.project_number} "${o.p.title}" completed.`, `project.html?id=${o.p.id}`, req.user.id);
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
  if ('checklist_item_id' in b) out.checklist_item_id = b.checklist_item_id == null || b.checklist_item_id === '' ? null : idOf(b.checklist_item_id);
  if ('requires_review' in b) out.requires_review = bool(b.requires_review) === true;
  if ('expects_trial' in b) out.expects_trial = bool(b.expects_trial) === true;
  if ('due_date' in b) out.due_date = b.due_date || null;
  if ('assignee_id' in b) out.assignee_id = b.assignee_id == null || b.assignee_id === '' ? null : idOf(b.assignee_id);
  if ('team' in b) out.team = str(b.team);
  if ('stage_no' in b) out.stage_no = b.stage_no == null || b.stage_no === '' ? null : Number(b.stage_no);
  return out;
}
function checkTask(t) {
  if ('title' in t && !t.title) return 'A task needs a title';
  if ('priority' in t && !R.PRIORITIES.includes(t.priority)) return 'Priority must be High, Medium or Low';
  if ('status' in t && !['todo', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled'].includes(t.status)) return 'Status must be to do, in progress, blocked, in review, done or cancelled';
  if ('due_date' in t && t.due_date && !R.isValidDate(t.due_date)) return 'Due date is not a valid date';
  if ('stage_no' in t && t.stage_no != null && !(Number.isInteger(t.stage_no) && t.stage_no >= 1 && t.stage_no <= 8)) return 'Stage must be 1 to 8';
  if ('team' in t && t.team && !R.DEPARTMENTS.includes(t.team)) return 'Team must be one of the departments';
  return null;
}

router.post('/projects/:id/tasks', needPerm(KEYS.RD_EDIT), async (req, res) => {
  const t = readTask({ priority: 'Medium', ...(req.body || {}) });
  const problem = checkTask(t) || (!t.title ? 'A task needs a title' : null) || (!t.assignee_id ? 'Choose who is responsible for the task' : null) || (!t.due_date ? 'Give the task a due date' : null);
  if (problem) return fail(res, 400, problem);
  let schema = null;                       // what should come back: a form, a checklist, or (none) free text
  if (req.body && req.body.result_schema) { const v = R.validateSchema(req.body.result_schema); if (v.error) return fail(res, 400, v.error); schema = v.schema; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = await open(req, res, { db: client });
    if (!o) { await client.query('ROLLBACK'); return; }
    if (!o.acc.edit || o.p.is_draft) { await client.query('ROLLBACK'); return fail(res, 403, 'You may not add tasks to this project'); }
    if (t.assignee_id) { const u = await client.query('SELECT 1 FROM users WHERE id = $1 AND active', [t.assignee_id]); if (!u.rowCount) { await client.query('ROLLBACK'); return fail(res, 400, 'That person is not an active user'); } }
    if (t.checklist_item_id) {          // a task can be tied to one checklist item of its own stage
      const ok = t.stage_no && (await client.query('SELECT 1 FROM rd_checklist_items c JOIN rd_stages s ON s.id = c.stage_id WHERE c.id = $1 AND s.project_id = $2 AND s.stage_no = $3', [t.checklist_item_id, o.p.id, t.stage_no])).rowCount;
      if (!ok) { await client.query('ROLLBACK'); return fail(res, 400, 'Choose a checklist item of the stage this task belongs to'); }
    }
    // work done by a trainee is always checked by someone else; for anyone else the person assigning decides
    const trainee = (await client.query("SELECT 1 FROM user_roles ur WHERE ur.user_id = $1 AND ur.role = 'rd_trainee' AND NOT EXISTS (SELECT 1 FROM user_roles x WHERE x.user_id = $1 AND x.role IN ('rd','admin'))", [t.assignee_id])).rowCount > 0;
    const review = trainee || t.requires_review === true;
    const r = await client.query(
      `INSERT INTO rd_tasks (project_id, stage_no, checklist_item_id, title, description, priority, assignee_id, team, due_date, requires_review, created_by, result_schema, expects_trial)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13) RETURNING id`,
      [o.p.id, t.stage_no || null, t.checklist_item_id || null, t.title, t.description || '', t.priority, t.assignee_id || null, t.assignee_id ? null : (t.team || null), t.due_date || null, review, req.user.id, schema ? JSON.stringify(schema) : null, t.expects_trial === true]);
    // the person doing the work must be able to open the project, so they join its team
    await client.query('INSERT INTO rd_project_members (project_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [o.p.id, t.assignee_id]);
    await addUpdate(client, o.p.id, 'system', req, `Task added: ${t.title}`, r.rows[0].id);
    await audit(client, req, { action: 'rd.task_add', entity: 'rd_task', id: r.rows[0].id, summary: `${o.p.project_number}: task "${t.title}" added` });
    await client.query('UPDATE rd_projects SET updated_at = NOW() WHERE id = $1', [o.p.id]);
    await client.query('COMMIT');
    tellWithCover([t.assignee_id], 'task_assigned', `New task: ${t.title}`, `${req.user.name} assigned you a task in ${o.p.project_number}: "${t.title}", due ${R.dmy(t.due_date)}.${schema ? ` When you hand it in you will fill in a "${schema.name}" ${schema.kind === 'checklist' ? 'checklist' : 'form'}.` : ''}`, 'my-day.html', req.user.id);
    const awayInfo = t.assignee_id ? ((await cover.awayToday(pool, [t.assignee_id])).get(t.assignee_id) || null) : null;       // the page warns when the person is away and says who covers
    res.status(201).json({ success: true, id: r.rows[0].id, assignee_away: awayInfo });
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
    const covering = await cover.isCovering(client, req.user.id, task.assignee_id);
    const o = await open(req, res, { db: client, coverVisible: covering });
    if (!o) { await client.query('ROLLBACK'); return; }
    const t = readTask(b);
    delete t.checklist_item_id; delete t.requires_review; delete t.expects_trial;       // set when the task is created
    const keys = Object.keys(t);
    // the person responsible may update the status of their own task; everything else needs edit rights on the project
    const own = (task.assignee_id === req.user.id || covering) && keys.every(k => k === 'status');
    if (!(o.acc.edit || own)) { await client.query('ROLLBACK'); return fail(res, 403, 'You may not change this task'); }
    // a task is finished only by "Complete task", which records the result; a finished task changes only by being reopened
    if (['done', 'in_review', 'cancelled'].includes(t.status)) { await client.query('ROLLBACK'); return fail(res, 400, 'Use "Complete task" (which records the result), the review buttons, or "Cancel task" for that'); }
    if (['done', 'in_review', 'cancelled'].includes(task.status) && keys.length) { await client.query('ROLLBACK'); return conflict(res, task.status === 'in_review' ? 'This task is waiting for review. Accept it or send it back first.' : 'This task is finished. Reopen it to change it.'); }
    const problem = checkTask(t);
    if (problem) { await client.query('ROLLBACK'); return fail(res, 400, problem); }
    if (Number(b.version) !== task.version) { await client.query('ROLLBACK'); return conflict(res, 'This task was changed by someone else. Reload and try again.', { current_version: task.version }); }
    if (t.assignee_id) { const u = await client.query('SELECT 1 FROM users WHERE id = $1 AND active', [t.assignee_id]); if (!u.rowCount) { await client.query('ROLLBACK'); return fail(res, 400, 'That person is not an active user'); } }
    const sets = { ...t };
    if ('assignee_id' in t && t.assignee_id) await client.query('INSERT INTO rd_project_members (project_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [o.p.id, t.assignee_id]);
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

/**
 * Completes (or hands in for review) a task inside the caller's transaction: status, history, feed and audit. Shared by "Complete task"
 * and by recording a lab trial that is linked to a task. The caller has already checked who may do this and has the task row locked.
 */
async function completeTaskRows(client, req, o, task, text, answers, covering) {
  const taskId = task.id;
  // a task that needs review is handed in by the person doing it; someone else with edit rights (the owner) can close it directly
  const submit = task.requires_review && (task.assignee_id === req.user.id || covering);
  const behalf = covering ? task.assignee_id : null;       // covering: recorded as done on behalf of the absent person
  await client.query(`UPDATE rd_tasks SET status = $4, completed_at = NOW(), completed_by = $1, on_behalf_of = $6, result = $2, result_data = $5::jsonb, review_note = NULL, version = version + 1 WHERE id = $3`, [req.user.id, text, taskId, submit ? 'in_review' : 'done', answers ? JSON.stringify(answers) : null, behalf]);
  await client.query(`INSERT INTO rd_task_history (task_id, action, result, actor_id, on_behalf_of) VALUES ($1,$4,$2,$3,$5)`, [taskId, text, req.user.id, submit ? 'submitted' : 'completed', behalf]);
  await addUpdate(client, o.p.id, 'system', req, (submit ? `Task "${task.title}" submitted for review` : `Task "${task.title}" completed`) + (behalf ? ` on behalf of the person responsible (away)` : ''), taskId);
  await audit(client, req, { action: submit ? 'rd.task_submit' : 'rd.task_complete', entity: 'rd_task', id: taskId, summary: `${o.p.project_number}: task "${task.title}" ${submit ? 'submitted for review' : 'completed'} with a result` });
  await client.query('UPDATE rd_projects SET updated_at = NOW() WHERE id = $1', [o.p.id]);
  return { submit, behalf };
}

/** The notices that follow a completed task (after the transaction has committed). */
function afterTaskCompleted(req, o, task, submit, behalf) {
  if (submit) reviewersOf(task).then(ids => tell(ids, 'task_review', `Work to review: ${task.title}`, `${req.user.name} handed in "${task.title}" (${o.p.project_number}) for you to check.`, 'my-day.html#sReview', req.user.id)).catch(e => console.error('notice failed:', e.message));
  else tell([task.created_by], 'task_done', `Task done: ${task.title}`, `${req.user.name} completed "${task.title}" (${o.p.project_number}).`, `project.html?id=${o.p.id}#list`, req.user.id);
  if (behalf) tell([behalf], 'task_done', `Done for you: ${task.title}`, `${req.user.name} covered for you and ${submit ? 'handed in' : 'completed'} "${task.title}" (${o.p.project_number}) while you were away.`, 'my-day.html', req.user.id);
}

/** Completes a task. The result (what was done or found) is required, so a task is never closed with nothing on record. */
router.post('/tasks/:id/complete', requirePermissionAny([KEYS.RD_VIEW, KEYS.RD_EDIT]), async (req, res) => {
  const b = req.body || {};
  const taskId = idOf(req.params.id);
  if (!taskId) return fail(res, 400, 'Invalid task id');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const task = norm((await client.query('SELECT * FROM rd_tasks WHERE id = $1 FOR UPDATE', [taskId])).rows[0]);
    if (!task) { await client.query('ROLLBACK'); return fail(res, 404, 'Task not found'); }
    req.params.id = String(task.project_id);
    const covering = await cover.isCovering(client, req.user.id, task.assignee_id);
    const o = await open(req, res, { db: client, coverVisible: covering });
    if (!o) { await client.query('ROLLBACK'); return; }
    if (o.p.is_draft || ['Completed', 'Rejected'].includes(o.p.status)) { await client.query('ROLLBACK'); return conflict(res, `The project is ${o.p.status}. Tasks cannot be completed on it.`); }
    // the person responsible completes their own task; the person covering for them while they are away may too; otherwise it needs edit rights on the project
    if (!(o.acc.edit || task.assignee_id === req.user.id || covering)) { await client.query('ROLLBACK'); return fail(res, 403, 'Only the person responsible, or R&D with edit rights, can complete this task'); }
    if (task.status === 'done') { await client.query('ROLLBACK'); return conflict(res, 'This task is already completed.'); }
    if (task.status === 'in_review') { await client.query('ROLLBACK'); return conflict(res, 'This task is already waiting for review.'); }
    if (task.status === 'cancelled') { await client.query('ROLLBACK'); return conflict(res, 'This task was cancelled.'); }
    if (b.version !== undefined && Number(b.version) !== task.version) { await client.query('ROLLBACK'); return conflict(res, 'This task was changed by someone else. Reload and try again.', { current_version: task.version }); }
    // What comes back: the answers to the form the owner chose, or free text when the task has no form.
    let text, answers = null;
    if (task.result_schema) {
      const v = R.validateAnswers(task.result_schema, b.data);
      if (v.error) { await client.query('ROLLBACK'); return fail(res, 400, v.error); }
      answers = v.data; text = R.summarise(task.result_schema, answers);
    } else {
      text = String(b.result == null ? '' : b.result).trim();
      if (text.length < R.MIN_TASK_RESULT_LENGTH) { await client.query('ROLLBACK'); return fail(res, 400, `Write what was done or found (at least ${R.MIN_TASK_RESULT_LENGTH} characters)`); }
      if (text.length > R.MAX_RESULT_LENGTH) { await client.query('ROLLBACK'); return fail(res, 400, `The result is too long (at most ${R.MAX_RESULT_LENGTH} characters)`); }
    }
    const { submit } = await completeTaskRows(client, req, o, task, text, answers, covering);
    await client.query('COMMIT');
    afterTaskCompleted(req, o, task, submit, task.assignee_id !== req.user.id && covering ? task.assignee_id : null);
    res.json({ success: true, version: task.version + 1, task_status: submit ? 'in_review' : 'done' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('rd task complete failed:', err); fail(res, 500, 'Could not complete the task');
  } finally { client.release(); }
});

/** Reopens a completed task. Needs edit rights and a reason; the earlier result stays in the task's history. */
router.post('/tasks/:id/reopen', requirePermissionAny([KEYS.RD_VIEW, KEYS.RD_EDIT]), async (req, res) => {
  const b = req.body || {};
  const taskId = idOf(req.params.id);
  if (!taskId) return fail(res, 400, 'Invalid task id');
  const reason = String(b.reason == null ? '' : b.reason).trim();
  if (!reason) return fail(res, 400, 'Give a reason for reopening the task');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const task = norm((await client.query('SELECT * FROM rd_tasks WHERE id = $1 FOR UPDATE', [taskId])).rows[0]);
    if (!task) { await client.query('ROLLBACK'); return fail(res, 404, 'Task not found'); }
    req.params.id = String(task.project_id);
    const o = await open(req, res, { db: client });
    if (!o) { await client.query('ROLLBACK'); return; }
    if (!o.acc.edit) { await client.query('ROLLBACK'); return fail(res, 403, 'Only R&D with edit rights can reopen a task'); }
    if (!['done', 'cancelled'].includes(task.status)) { await client.query('ROLLBACK'); return conflict(res, 'This task is not completed or cancelled.'); }
    if (b.version !== undefined && Number(b.version) !== task.version) { await client.query('ROLLBACK'); return conflict(res, 'This task was changed by someone else. Reload and try again.', { current_version: task.version }); }
    await client.query(`INSERT INTO rd_task_history (task_id, action, result, reason, actor_id) VALUES ($1,'reopened',$2,$3,$4)`, [taskId, task.result, reason, req.user.id]);
    await client.query(`UPDATE rd_tasks SET status = $2, completed_at = NULL, completed_by = NULL, result = NULL, result_data = NULL, reviewed_by = NULL, reviewed_at = NULL, review_note = NULL, cancel_reason = NULL, version = version + 1 WHERE id = $1`, [taskId, task.status === 'cancelled' ? 'todo' : 'in_progress']);
    await addUpdate(client, o.p.id, 'system', req, `Task "${task.title}" reopened: ${reason}`, taskId);
    await audit(client, req, { action: 'rd.task_reopen', entity: 'rd_task', id: taskId, summary: `${o.p.project_number}: task "${task.title}" reopened` });
    await client.query('UPDATE rd_projects SET updated_at = NOW() WHERE id = $1', [o.p.id]);
    await client.query('COMMIT');
    tellWithCover([task.assignee_id], 'task_reopened', `Task reopened: ${task.title}`, `${req.user.name} reopened "${task.title}" (${o.p.project_number}): ${reason}`, 'my-day.html', req.user.id);
    res.json({ success: true, version: task.version + 1 });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('rd task reopen failed:', err); fail(res, 500, 'Could not reopen the task');
  } finally { client.release(); }
});

/** Shared by accept / send-back / cancel: loads the task and the project and checks the person may review it. */
async function reviewContext(req, res, client, { needInReview }) {
  const taskId = idOf(req.params.id);
  if (!taskId) { fail(res, 400, 'Invalid task id'); return null; }
  const task = norm((await client.query('SELECT * FROM rd_tasks WHERE id = $1 FOR UPDATE', [taskId])).rows[0]);
  if (!task) { fail(res, 404, 'Task not found'); return null; }
  req.params.id = String(task.project_id);
  const o = await open(req, res, { db: client });
  if (!o) return null;
  if (!o.acc.edit) { fail(res, 403, 'Only R&D with edit rights can do that'); return null; }
  if (needInReview && task.status !== 'in_review') { conflict(res, 'This task is not waiting for review.'); return null; }
  return { task, o, taskId };
}

/** Accepts a task that was handed in for review. The person who did the work cannot accept their own work. */
router.post('/tasks/:id/accept', requirePermissionAny([KEYS.RD_VIEW, KEYS.RD_EDIT]), async (req, res) => {
  const note = String((req.body || {}).note || '').trim().slice(0, 500);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const c = await reviewContext(req, res, client, { needInReview: true });
    if (!c) { await client.query('ROLLBACK'); return; }
    const { task, o, taskId } = c;
    if (task.assignee_id === req.user.id || task.completed_by === req.user.id) { await client.query('ROLLBACK'); return fail(res, 403, 'Someone else has to review your work'); }
    await client.query(`UPDATE rd_tasks SET status = 'done', reviewed_by = $1, reviewed_at = NOW(), review_note = $2, version = version + 1 WHERE id = $3`, [req.user.id, note || null, taskId]);
    await client.query(`INSERT INTO rd_task_history (task_id, action, result, reason, actor_id) VALUES ($1,'accepted',$2,$3,$4)`, [taskId, task.result, note || null, req.user.id]);
    await addUpdate(client, o.p.id, 'system', req, `Task "${task.title}" accepted`, taskId);
    await audit(client, req, { action: 'rd.task_accept', entity: 'rd_task', id: taskId, summary: `${o.p.project_number}: task "${task.title}" accepted` });
    await client.query('UPDATE rd_projects SET updated_at = NOW() WHERE id = $1', [o.p.id]);
    await client.query('COMMIT');
    tell([task.assignee_id], 'task_accepted', `Accepted: ${task.title}`, `${req.user.name} accepted your work on "${task.title}" (${o.p.project_number}).${note ? ' ' + note : ''}`, 'my-day.html', req.user.id);
    res.json({ success: true });
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); console.error('rd task accept failed:', err); fail(res, 500, 'Could not accept the task'); } finally { client.release(); }
});

/** Sends a task back to the person who did it, with a comment. Their earlier result stays in the history. */
router.post('/tasks/:id/send-back', requirePermissionAny([KEYS.RD_VIEW, KEYS.RD_EDIT]), async (req, res) => {
  const note = String((req.body || {}).note || '').trim().slice(0, 500);
  if (!note) return fail(res, 400, 'Say what needs to change');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const c = await reviewContext(req, res, client, { needInReview: true });
    if (!c) { await client.query('ROLLBACK'); return; }
    const { task, o, taskId } = c;
    if (task.assignee_id === req.user.id || task.completed_by === req.user.id) { await client.query('ROLLBACK'); return fail(res, 403, 'Someone else has to review your work'); }
    await client.query(`INSERT INTO rd_task_history (task_id, action, result, reason, actor_id) VALUES ($1,'sent_back',$2,$3,$4)`, [taskId, task.result, note, req.user.id]);
    await client.query(`UPDATE rd_tasks SET status = 'in_progress', result = NULL, result_data = NULL, completed_at = NULL, completed_by = NULL, review_note = $1, version = version + 1 WHERE id = $2`, [note, taskId]);
    await addUpdate(client, o.p.id, 'system', req, `Task "${task.title}" sent back: ${note}`, taskId);
    await audit(client, req, { action: 'rd.task_send_back', entity: 'rd_task', id: taskId, summary: `${o.p.project_number}: task "${task.title}" sent back` });
    await client.query('UPDATE rd_projects SET updated_at = NOW() WHERE id = $1', [o.p.id]);
    await client.query('COMMIT');
    tellWithCover([task.assignee_id], 'task_sent_back', `Sent back: ${task.title}`, `${req.user.name} sent "${task.title}" (${o.p.project_number}) back for changes: ${note}`, 'my-day.html', req.user.id);
    res.json({ success: true });
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); console.error('rd task send-back failed:', err); fail(res, 500, 'Could not send the task back'); } finally { client.release(); }
});

/** Cancels a task that is no longer needed. A reason is required, and it stays on the record. */
router.post('/tasks/:id/cancel', requirePermissionAny([KEYS.RD_VIEW, KEYS.RD_EDIT]), async (req, res) => {
  const reason = String((req.body || {}).reason || '').trim().slice(0, 500);
  if (!reason) return fail(res, 400, 'Give a reason for cancelling the task');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const c = await reviewContext(req, res, client, { needInReview: false });
    if (!c) { await client.query('ROLLBACK'); return; }
    const { task, o, taskId } = c;
    if (!OPEN_TASK.includes(task.status)) { await client.query('ROLLBACK'); return conflict(res, 'This task is already finished.'); }
    await client.query(`INSERT INTO rd_task_history (task_id, action, result, reason, actor_id) VALUES ($1,'cancelled',$2,$3,$4)`, [taskId, task.result, reason, req.user.id]);
    await client.query(`UPDATE rd_tasks SET status = 'cancelled', cancel_reason = $1, version = version + 1 WHERE id = $2`, [reason, taskId]);
    await addUpdate(client, o.p.id, 'system', req, `Task "${task.title}" cancelled: ${reason}`, taskId);
    await audit(client, req, { action: 'rd.task_cancel', entity: 'rd_task', id: taskId, summary: `${o.p.project_number}: task "${task.title}" cancelled` });
    await client.query('UPDATE rd_projects SET updated_at = NOW() WHERE id = $1', [o.p.id]);
    await client.query('COMMIT');
    tellWithCover([task.assignee_id], 'task_cancelled', `Task cancelled: ${task.title}`, `${req.user.name} cancelled "${task.title}" (${o.p.project_number}): ${reason}`, 'my-day.html', req.user.id);
    res.json({ success: true });
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); console.error('rd task cancel failed:', err); fail(res, 500, 'Could not cancel the task'); } finally { client.release(); }
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

// ---------------------------------------------------------------------------------------------------------------
// Lab trials: structured records of each trial (formula used, what changed, results against each performance requirement).
// Rules: trials are never deleted (a correction needs a reason and keeps the old values); formula, what changed, observations and
// measured values are confidential (field.rd_technical); cost per kg needs field.prices; marking a trial "Preferred formula" records
// the outcome only (it completes no stage, ticks no item and records no approval); at most one trial per project is Preferred.
// ---------------------------------------------------------------------------------------------------------------
const TRIAL_COLS = ['trial_date', 'stage_no', 'formula_ref', 'changed_variables', 'batch_size_text', 'observations', 'extra_fields', 'outcome', 'rm_cost_per_kg', 'results'];
const TRIAL_CONFIDENTIAL = new Set([...R.CONFIDENTIAL_TRIAL_FIELDS, 'results']);       // results carry measured values
const trialOpen = (p) => !p.is_draft && !R.CLOSED_STATUSES.includes(p.status) && p.status !== R.HOLD_STATUS;
const trialClosedMessage = (p) => (p.is_draft ? 'The request has not been submitted yet' : `The project is ${p.status}. Trials cannot be added or corrected on it.`);
const needTrialView = (req, res, next) => ((req.access.isAdmin || can(req.access, KEYS.RD_TRIAL_VIEW)) ? next() : fail(res, 403, `Your role ("${req.user.role}") is not allowed to see lab trials`));
const needTrialEdit = (req, res, next) => ((req.access.isAdmin || can(req.access, KEYS.RD_TRIAL_EDIT)) ? next() : fail(res, 403, `Your role ("${req.user.role}") is not allowed to record lab trials`));

async function requirementRows(db, projectId) {
  return (await db.query('SELECT id, position, parameter, target, acceptable_range FROM rd_requirements WHERE project_id = $1 ORDER BY position, id', [projectId])).rows;
}
/** One trial as the signed-in person may see it. Confidential text and cost are left out (not just blanked) when not allowed. */
function shapeTrial(row, results, corrections, ctx, files) {
  const t = {
    id: row.id, trial_no: row.trial_no, label: R.trialLabel(row.trial_no), stage_no: row.stage_no, trial_date: ymd(row.trial_date),
    recorded_by_name: row.recorded_by_name, batch_size_text: row.batch_size_text, outcome: row.outcome, version: row.version,
    created_at: row.created_at, updated_at: row.updated_at,
    results: results.map(r => ({ requirement_id: r.requirement_id, result: r.result, ...(ctx.technical ? { measured_value: r.measured_value } : {}) })),
    summary: R.trialSummary(results, ctx.total), attachment_count: (files || []).length,
    task: row.task_id ? { id: row.task_id, title: row.task_title || null } : null,
    corrections: corrections.map(c => {
      const keys = Object.keys(c.new_values || {}).filter(k => ctx.prices || k !== 'rm_cost_per_kg').filter(k => ctx.technical || !TRIAL_CONFIDENTIAL.has(k));
      const base = { id: c.id, at: c.created_at, by: c.corrected_by_name, fields: keys };
      const costOnly = Object.keys(c.new_values || {}).every(k => k === 'rm_cost_per_kg');
      if (!ctx.technical && !(ctx.prices && costOnly)) return base;          // a change to the cost alone is shown, with its reason, to people who may see prices
      const strip = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => ctx.prices || k !== 'rm_cost_per_kg'));
      return { ...base, reason: c.reason, old: strip(c.old_values), new: strip(c.new_values) };
    })
  };
  if (ctx.technical) {
    t.formula_ref = row.formula_ref; t.changed_variables = row.changed_variables; t.observations = row.observations; t.extra_fields = row.extra_fields || [];
    t.attachments = (files || []).map(f => ({ id: f.id, file_name: f.file_name, mime: f.mime, size_bytes: f.size_bytes, by: f.uploaded_by_name, at: f.created_at }));
  }
  if (ctx.prices) t.rm_cost_per_kg = row.rm_cost_per_kg == null ? null : Number(row.rm_cost_per_kg);
  return t;
}
async function loadTrials(db, projectId, ctx, onlyId) {
  const rows = (await db.query(`SELECT * FROM rd_trials WHERE project_id = $1${onlyId ? ' AND id = $2' : ''} ORDER BY trial_no`, onlyId ? [projectId, onlyId] : [projectId])).rows;
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const taskIds = rows.map(r => r.task_id).filter(Boolean);
  const titles = taskIds.length ? new Map((await db.query('SELECT id, title FROM rd_tasks WHERE id = ANY($1)', [taskIds])).rows.map(t => [t.id, t.title])) : new Map();
  rows.forEach(r => { if (r.task_id) r.task_title = titles.get(r.task_id); });
  const [res, cor, fil] = await Promise.all([
    db.query('SELECT trial_id, requirement_id, result, measured_value FROM rd_trial_results WHERE trial_id = ANY($1) ORDER BY requirement_id', [ids]),
    db.query('SELECT id, trial_id, corrected_by_name, reason, old_values, new_values, created_at FROM rd_trial_corrections WHERE trial_id = ANY($1) ORDER BY id', [ids]),
    db.query('SELECT id, trial_id, file_name, mime, size_bytes, uploaded_by_name, created_at FROM rd_trial_attachments WHERE trial_id = ANY($1) AND removed_at IS NULL ORDER BY id', [ids])      // never the file itself
  ]);
  return rows.map(r => shapeTrial(r, res.rows.filter(x => x.trial_id === r.id), cor.rows.filter(x => x.trial_id === r.id), ctx, fil.rows.filter(x => x.trial_id === r.id)));
}
const trialCtx = (req, total) => ({ technical: can(req.access, KEYS.FIELD_RD_TECHNICAL), prices: can(req.access, KEYS.FIELD_PRICES), total });

/** The lab-trial tasks this person may record a trial for on a project: their own, and those of people they are covering for today. */
async function myTrialTasks(db, userId, projectId) {
  const covered = (await cover.coveredBy(db, userId)).map(c => c.user_id);
  return (await db.query(`SELECT t.id, t.title, t.stage_no, t.due_date::text AS due_date FROM rd_tasks t WHERE t.project_id = $1 AND t.expects_trial AND t.status IN ('todo','in_progress','blocked') AND (t.assignee_id = $2 OR t.assignee_id = ANY($3)) ORDER BY t.due_date NULLS LAST, t.id`, [projectId, userId, covered])).rows;
}

router.get('/projects/:id/trials', needTrialView, async (req, res) => {
  try {
    const o = await open(req, res); if (!o) return;
    const reqs = await requirementRows(pool, o.p.id);
    const ctx = trialCtx(req, reqs.length);
    res.json({
      success: true, today: today(), project_status: o.p.status, requirements: reqs, outcomes: R.TRIAL_OUTCOMES, results: R.TRIAL_RESULTS, limits: { max_extra_fields: R.MAX_EXTRA_FIELDS, attach_max_bytes: R.ATTACH_MAX_BYTES, attach_max_per_trial: R.ATTACH_MAX_PER_TRIAL },
      trials: o.p.is_draft ? [] : await loadTrials(pool, o.p.id, ctx),
      open_trial_tasks: (trialOpen(o.p) && ctx.technical && (req.access.isAdmin || can(req.access, KEYS.RD_TRIAL_EDIT))) ? await myTrialTasks(pool, req.user.id, o.p.id) : [],
      can: { add: (req.access.isAdmin || can(req.access, KEYS.RD_TRIAL_EDIT)) && ctx.technical && trialOpen(o.p), cost: (req.access.isAdmin || can(req.access, KEYS.RD_TRIAL_COST)) && ctx.prices && !o.p.is_draft, technical: ctx.technical, prices: ctx.prices, open: trialOpen(o.p), closed_reason: trialOpen(o.p) ? null : trialClosedMessage(o.p) }
    });
  } catch (err) { console.error('rd trials list failed:', err); fail(res, 500, 'Could not load the trials'); }
});

/** Makes a trial the only Preferred one: any earlier Preferred trial goes back to "Needs another trial" through a correction row. */
async function supersedePreferred(client, req, projectId, exceptId, newLabel) {
  const prev = (await client.query("SELECT id, trial_no, version FROM rd_trials WHERE project_id = $1 AND outcome = 'Preferred formula' AND id <> COALESCE($2, 0) FOR UPDATE", [projectId, exceptId || null])).rows;
  for (const x of prev) {
    await client.query("UPDATE rd_trials SET outcome = 'Needs another trial', version = version + 1, updated_at = NOW() WHERE id = $1", [x.id]);
    await client.query('INSERT INTO rd_trial_corrections (trial_id, corrected_by, corrected_by_name, reason, old_values, new_values) VALUES ($1,$2,$3,$4,$5,$6)',
      [x.id, req.user.id, req.user.name, `${newLabel} was marked as the preferred formula, so ${R.trialLabel(x.trial_no)} is no longer preferred`, JSON.stringify({ outcome: 'Preferred formula' }), JSON.stringify({ outcome: 'Needs another trial' })]);
    await audit(client, req, { action: 'rd.trial_correct', entity: 'rd_trial', id: x.id, summary: `${R.trialLabel(x.trial_no)} no longer preferred (${newLabel} is now preferred)`, before: { outcome: 'Preferred formula' }, after: { outcome: 'Needs another trial' } });
  }
  return prev.length;
}

router.post('/projects/:id/trials', needTrialEdit, async (req, res) => {
  const b = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    req.params.id = String(idOf(req.params.id) || 0);
    const o = await open(req, res, { db: client, lock: true });
    if (!o) { await client.query('ROLLBACK'); return; }       // locking the project row also serialises trial numbering
    if (!trialOpen(o.p)) { await client.query('ROLLBACK'); return conflict(res, trialClosedMessage(o.p)); }
    const technical = can(req.access, KEYS.FIELD_RD_TECHNICAL), prices = can(req.access, KEYS.FIELD_PRICES);
    if (!technical) { await client.query('ROLLBACK'); return fail(res, 403, 'Recording a trial needs R&D technical access (the formula and observations are confidential)'); }
    if (b.rm_cost_per_kg != null && String(b.rm_cost_per_kg).trim() !== '' && !prices) { await client.query('ROLLBACK'); return fail(res, 403, 'Recording the cost needs access to prices'); }
    const reqs = await requirementRows(client, o.p.id);
    const { errors, clean } = R.validateTrial(b, { requirementIds: reqs.map(r => r.id), today: today() });
    if (errors.length) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, error: errors[0].message, errors }); }
    // optional: this trial is the work of one of the person's "produces a lab trial" tasks
    let link = null;
    if (b.task_id != null && b.task_id !== '') {
      const tid = idOf(b.task_id);
      const tk = tid ? norm((await client.query('SELECT * FROM rd_tasks WHERE id = $1 AND project_id = $2 FOR UPDATE', [tid, o.p.id])).rows[0]) : null;
      if (!tk || !tk.expects_trial) { await client.query('ROLLBACK'); return fail(res, 400, 'Choose one of your lab trial tasks on this project'); }
      if (!['todo', 'in_progress', 'blocked'].includes(tk.status)) { await client.query('ROLLBACK'); return conflict(res, 'That task is not open any more'); }
      const covering = await cover.isCovering(client, req.user.id, tk.assignee_id);
      if (tk.assignee_id !== req.user.id && !covering) { await client.query('ROLLBACK'); return fail(res, 403, 'That task is assigned to someone else'); }
      link = { tk, covering };
    }
    const next = (await client.query('SELECT COALESCE(MAX(trial_no), 0) + 1 AS n FROM rd_trials WHERE project_id = $1', [o.p.id])).rows[0].n;
    if (clean.outcome === 'Preferred formula') await supersedePreferred(client, req, o.p.id, null, R.trialLabel(next));      // before the insert: only one Preferred at a time
    const ins = await client.query(
      `INSERT INTO rd_trials (project_id, trial_no, stage_no, trial_date, recorded_by, recorded_by_name, formula_ref, changed_variables, batch_size_text, observations, outcome, rm_cost_per_kg, extra_fields, task_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14) RETURNING id`,
      [o.p.id, next, clean.stage_no, clean.trial_date, req.user.id, req.user.name, clean.formula_ref, clean.changed_variables || '', clean.batch_size_text || '', clean.observations || '', clean.outcome, prices ? (clean.rm_cost_per_kg == null ? null : clean.rm_cost_per_kg) : null, JSON.stringify(clean.extra_fields || []), link ? link.tk.id : null]);
    const given = new Map((clean.results || []).map(r => [r.requirement_id, r]));
    for (const r of reqs) {
      const g = given.get(r.id) || { result: 'Not tested', measured_value: '' };
      await client.query('INSERT INTO rd_trial_results (trial_id, requirement_id, result, measured_value) VALUES ($1,$2,$3,$4)', [ins.rows[0].id, r.id, g.result, g.measured_value]);
    }
    // a linked task is completed by the usual rules (handed in for review where that applies); the result is a plain, non-confidential sentence
    const passed = (clean.results || []).filter(r => r.result === 'Pass').length;
    let taskDone = null;
    if (link && !link.tk.result_schema) taskDone = await completeTaskRows(client, req, o, link.tk, `Lab trial ${R.trialLabel(next)} recorded: ${clean.outcome}, ${passed} of ${reqs.length} requirements pass.`, null, link.covering);
    await addUpdate(client, o.p.id, 'system', req, `Lab trial ${R.trialLabel(next)} recorded (${clean.outcome})`);
    // the audit trail records that a trial exists and its non-confidential facts, never the formula, observations, measured values or cost
    await audit(client, req, { action: 'rd.trial_add', entity: 'rd_trial', id: ins.rows[0].id, summary: `${o.p.project_number}: trial ${R.trialLabel(next)} recorded`, after: { trial_no: next, stage_no: clean.stage_no, trial_date: clean.trial_date, outcome: clean.outcome } });
    await client.query('UPDATE rd_projects SET updated_at = NOW() WHERE id = $1', [o.p.id]);
    await client.query('COMMIT');
    if (taskDone) afterTaskCompleted(req, o, link.tk, taskDone.submit, taskDone.behalf);
    // tell the people who follow the project (no formula, observations or values: a notice can be read by people without technical access)
    try {
      const stageOwner = (await pool.query('SELECT owner_user_id FROM rd_stages WHERE project_id = $1 AND stage_no = $2', [o.p.id, clean.stage_no])).rows[0];
      const label = R.trialLabel(next), where = `${o.p.project_number} "${o.p.title}"`, path = `project.html?id=${o.p.id}#trials`;
      if (clean.outcome === 'Preferred formula') tell([o.p.lead_user_id, o.p.requested_by_user, stageOwner && stageOwner.owner_user_id], 'trial_preferred', `Preferred formula chosen: ${o.p.project_number}`, `${req.user.name} marked lab trial ${label} as the preferred formula for ${where} (${passed} of ${reqs.length} requirements pass). This only records the outcome: it does not complete a stage or give an approval.`, path, req.user.id);
      else tell([o.p.lead_user_id, stageOwner && stageOwner.owner_user_id], 'trial_added', `Lab trial ${label}: ${o.p.project_number}`, `${req.user.name} recorded lab trial ${label} on ${where}: ${passed} of ${reqs.length} requirements pass (${clean.outcome}).`, path, req.user.id);
    } catch (e) { console.error('notice failed:', e.message); }
    res.status(201).json({ success: true, id: ins.rows[0].id, trial_no: next, label: R.trialLabel(next), task: link ? { id: link.tk.id, status: taskDone ? (taskDone.submit ? 'in_review' : 'done') : 'open' } : null });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('rd trial add failed:', err); fail(res, 500, 'Could not record the trial');
  } finally { client.release(); }
});

router.patch('/projects/:id/trials/:trialId', needTrialEdit, async (req, res) => {
  const b = req.body || {};
  const trialId = idOf(req.params.trialId);
  if (!trialId) return fail(res, 400, 'Invalid trial id');
  const reason = String(b.reason || '').trim();
  if (reason.length < 5) return fail(res, 400, 'Say why you are correcting this trial (at least 5 characters)');
  if (reason.length > 1000) return fail(res, 400, 'The reason is too long (1000 characters at most)');
  if (!Number.isInteger(Number(b.version))) return fail(res, 400, 'Send the version you are correcting');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    req.params.id = String(idOf(req.params.id) || 0);
    const o = await open(req, res, { db: client, lock: true });
    if (!o) { await client.query('ROLLBACK'); return; }
    const tr = (await client.query('SELECT * FROM rd_trials WHERE id = $1 AND project_id = $2 FOR UPDATE', [trialId, o.p.id])).rows[0];
    if (!tr) { await client.query('ROLLBACK'); return fail(res, 404, 'Trial not found'); }
    if (!trialOpen(o.p)) { await client.query('ROLLBACK'); return conflict(res, trialClosedMessage(o.p)); }
    const technical = can(req.access, KEYS.FIELD_RD_TECHNICAL), prices = can(req.access, KEYS.FIELD_PRICES);
    if (!technical) { await client.query('ROLLBACK'); return fail(res, 403, 'Correcting a trial needs R&D technical access'); }
    if ('rm_cost_per_kg' in b && !prices) { await client.query('ROLLBACK'); return fail(res, 403, 'Correcting the cost needs access to prices'); }
    if (Number(b.version) !== tr.version) { await client.query('ROLLBACK'); return conflict(res, 'Someone else changed this trial since you opened it. Reload to see their changes, then apply yours again.', { current_version: tr.version }); }
    const reqs = await requirementRows(client, o.p.id);
    const fields = {}; TRIAL_COLS.forEach(k => { if (k in b) fields[k] = b[k]; });
    const { errors, clean } = R.validateTrial(fields, { requirementIds: reqs.map(r => r.id), today: today(), partial: true });
    if (errors.length) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, error: errors[0].message, errors }); }
    // the values as stored now, in the same shape as the corrected ones, so only real changes are recorded
    const curRes = (await client.query('SELECT requirement_id, result, measured_value FROM rd_trial_results WHERE trial_id = $1 ORDER BY requirement_id', [tr.id])).rows;
    const before = { trial_date: ymd(tr.trial_date), stage_no: tr.stage_no, formula_ref: tr.formula_ref, changed_variables: tr.changed_variables, batch_size_text: tr.batch_size_text, observations: tr.observations, extra_fields: tr.extra_fields || [], outcome: tr.outcome, rm_cost_per_kg: tr.rm_cost_per_kg == null ? null : Number(tr.rm_cost_per_kg), results: curRes };
    if (clean.results) { const given = new Map(clean.results.map(r => [r.requirement_id, r])); clean.results = reqs.map(r => ({ requirement_id: r.id, ...(given.get(r.id) || { result: 'Not tested', measured_value: '' }) })).sort((x, y) => x.requirement_id - y.requirement_id); }
    const d = R.diffTrial(before, clean, TRIAL_COLS);
    if (!d.fields.length) { await client.query('ROLLBACK'); return fail(res, 400, 'Nothing was changed'); }
    if (d.fields.includes('outcome') && clean.outcome === 'Preferred formula') await supersedePreferred(client, req, o.p.id, tr.id, R.trialLabel(tr.trial_no));      // before the update: only one Preferred at a time
    const set = [], vals = [];
    for (const k of d.fields) if (k !== 'results') { vals.push(k === 'extra_fields' ? JSON.stringify(clean[k]) : (clean[k] == null ? null : clean[k])); set.push(`${k} = $${vals.length}${k === 'extra_fields' ? '::jsonb' : ''}`); }
    vals.push(tr.id, tr.version);
    const upd = await client.query(`UPDATE rd_trials SET ${set.concat(['version = version + 1', 'updated_at = NOW()']).join(', ')} WHERE id = $${vals.length - 1} AND version = $${vals.length} RETURNING version`, vals);
    if (!upd.rowCount) { await client.query('ROLLBACK'); return conflict(res, 'Someone else changed this trial at the same moment. Reload and try again.'); }
    if (d.fields.includes('results')) for (const r of clean.results) await client.query('UPDATE rd_trial_results SET result = $3, measured_value = $4 WHERE trial_id = $1 AND requirement_id = $2', [tr.id, r.requirement_id, r.result, r.measured_value]);
    await client.query('INSERT INTO rd_trial_corrections (trial_id, corrected_by, corrected_by_name, reason, old_values, new_values) VALUES ($1,$2,$3,$4,$5,$6)', [tr.id, req.user.id, req.user.name, reason, JSON.stringify(d.old), JSON.stringify(d.new)]);
    await addUpdate(client, o.p.id, 'system', req, `Lab trial ${R.trialLabel(tr.trial_no)} corrected`);
    // field NAMES only, plus the non-confidential values: never the text of the formula, observations, measured values or cost
    const safe = ['trial_date', 'stage_no', 'outcome'];
    await audit(client, req, { action: 'rd.trial_correct', entity: 'rd_trial', id: tr.id, summary: `${o.p.project_number}: trial ${R.trialLabel(tr.trial_no)} corrected (${d.fields.join(', ')})`,
      before: Object.fromEntries(safe.filter(k => d.fields.includes(k)).map(k => [k, d.old[k]])), after: Object.fromEntries(safe.filter(k => d.fields.includes(k)).map(k => [k, d.new[k]])), reason });
    await client.query('UPDATE rd_projects SET updated_at = NOW() WHERE id = $1', [o.p.id]);
    await client.query('COMMIT');
    res.json({ success: true, version: upd.rows[0].version, fields: d.fields });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('rd trial correct failed:', err); fail(res, 500, 'Could not correct the trial');
  } finally { client.release(); }
});

/**
 * Enter or change the raw-material cost per kg of a trial. A separate, narrow permission: the person needs rd.trial_cost (the Manager
 * holds it and passes it to another department such as Accounts) AND access to prices, but no technical access, so they never see
 * a formula. Each change is a correction row (old and new cost, visible only to people who may see prices), and the audit trail
 * records that a cost was set, never the amount.
 */
router.put('/projects/:id/trials/:trialId/cost', async (req, res) => {
  if (!(req.access.isAdmin || can(req.access, KEYS.RD_TRIAL_COST))) return fail(res, 403, `Your role ("${req.user.role}") is not allowed to enter trial costs`);
  if (!can(req.access, KEYS.FIELD_PRICES)) return fail(res, 403, 'Entering a cost needs access to prices');
  const b = req.body || {};
  const trialId = idOf(req.params.trialId);
  if (!trialId) return fail(res, 400, 'Invalid trial id');
  const c = R.parseTrialCost(b.rm_cost_per_kg); if (c.error) return fail(res, 400, c.error);
  if (!Number.isInteger(Number(b.version))) return fail(res, 400, 'Send the version you are changing');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    req.params.id = String(idOf(req.params.id) || 0);
    const o = await open(req, res, { db: client, lock: true });
    if (!o) { await client.query('ROLLBACK'); return; }
    if (o.p.is_draft) { await client.query('ROLLBACK'); return conflict(res, trialClosedMessage(o.p)); }
    const tr = (await client.query('SELECT * FROM rd_trials WHERE id = $1 AND project_id = $2 FOR UPDATE', [trialId, o.p.id])).rows[0];
    if (!tr) { await client.query('ROLLBACK'); return fail(res, 404, 'Trial not found'); }
    if (Number(b.version) !== tr.version) { await client.query('ROLLBACK'); return conflict(res, 'Someone else changed this trial since you opened it. Reload to see their changes, then apply yours again.', { current_version: tr.version }); }
    const old = tr.rm_cost_per_kg == null ? null : Number(tr.rm_cost_per_kg);
    if (old === c.value) { await client.query('ROLLBACK'); return fail(res, 400, 'Nothing was changed'); }
    const reason = old == null ? (String(b.reason || '').trim() || 'Cost per kg entered') : String(b.reason || '').trim();
    if (reason.length < 5) { await client.query('ROLLBACK'); return fail(res, 400, 'Say why the cost is being changed (at least 5 characters)'); }
    const upd = await client.query('UPDATE rd_trials SET rm_cost_per_kg = $1, version = version + 1, updated_at = NOW() WHERE id = $2 AND version = $3 RETURNING version', [c.value, tr.id, tr.version]);
    if (!upd.rowCount) { await client.query('ROLLBACK'); return conflict(res, 'Someone else changed this trial at the same moment. Reload and try again.'); }
    await client.query('INSERT INTO rd_trial_corrections (trial_id, corrected_by, corrected_by_name, reason, old_values, new_values) VALUES ($1,$2,$3,$4,$5,$6)', [tr.id, req.user.id, req.user.name, reason.slice(0, 1000), JSON.stringify({ rm_cost_per_kg: old }), JSON.stringify({ rm_cost_per_kg: c.value })]);
    await addUpdate(client, o.p.id, 'system', req, `The cost per kg of lab trial ${R.trialLabel(tr.trial_no)} was ${old == null ? 'recorded' : 'changed'}`);
    await audit(client, req, { action: 'rd.trial_cost', entity: 'rd_trial', id: tr.id, summary: `${o.p.project_number}: cost per kg ${old == null ? 'recorded' : 'changed'} for trial ${R.trialLabel(tr.trial_no)}`, reason });
    await client.query('COMMIT');
    res.json({ success: true, version: upd.rows[0].version });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('rd trial cost failed:', err); fail(res, 500, 'Could not save the cost');
  } finally { client.release(); }
});

// ---- photographs and PDFs of trial results (stored in the database; the file's own bytes decide what it is) ----
const attachBody = express.raw({ type: ['image/jpeg', 'image/png', 'application/pdf'], limit: R.ATTACH_MAX_BYTES + 1024 });
const needTechnical = (req, res, next) => (can(req.access, KEYS.FIELD_RD_TECHNICAL) ? next() : fail(res, 403, 'Trial photographs and files are confidential R&D content and need R&D technical access'));

router.post('/projects/:id/trials/:trialId/attachments', needTrialEdit, needTechnical, attachBody, async (req, res) => {
  const trialId = idOf(req.params.trialId);
  if (!trialId) return fail(res, 400, 'Invalid trial id');
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) return fail(res, 400, 'Send a JPEG, PNG or PDF file (no larger than ' + Math.round(R.ATTACH_MAX_BYTES / 1048576) + ' MB)');
  const mime = R.sniffAttachment(buf);
  if (!mime) return fail(res, 400, 'That file is not a JPEG, PNG or PDF');
  let name = ''; try { name = decodeURIComponent(String(req.headers['x-file-name'] || '')); } catch (e) { name = ''; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    req.params.id = String(idOf(req.params.id) || 0);
    const o = await open(req, res, { db: client, lock: true });
    if (!o) { await client.query('ROLLBACK'); return; }
    if (!trialOpen(o.p)) { await client.query('ROLLBACK'); return conflict(res, trialClosedMessage(o.p)); }
    const tr = (await client.query('SELECT id, trial_no FROM rd_trials WHERE id = $1 AND project_id = $2', [trialId, o.p.id])).rows[0];
    if (!tr) { await client.query('ROLLBACK'); return fail(res, 404, 'Trial not found'); }
    const used = (await client.query('SELECT COALESCE(SUM(a.size_bytes), 0)::bigint AS bytes FROM rd_trial_attachments a JOIN rd_trials t ON t.id = a.trial_id WHERE t.project_id = $1', [o.p.id])).rows[0];
    const mine = (await client.query('SELECT COUNT(*)::int AS n FROM rd_trial_attachments WHERE trial_id = $1 AND removed_at IS NULL', [tr.id])).rows[0].n;
    if (mine >= R.ATTACH_MAX_PER_TRIAL) { await client.query('ROLLBACK'); return conflict(res, `A trial can have at most ${R.ATTACH_MAX_PER_TRIAL} files. Remove one first.`); }
    if (Number(used.bytes) + buf.length > R.ATTACH_MAX_PER_PROJECT_BYTES) { await client.query('ROLLBACK'); return conflict(res, 'This project has reached its limit for stored trial files.'); }
    const fileName = R.safeFileName(name, mime);
    const ins = await client.query('INSERT INTO rd_trial_attachments (trial_id, file_name, mime, size_bytes, data, uploaded_by, uploaded_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [tr.id, fileName, mime, buf.length, buf, req.user.id, req.user.name]);
    await addUpdate(client, o.p.id, 'system', req, `A ${mime === 'application/pdf' ? 'file' : 'photograph'} was added to lab trial ${R.trialLabel(tr.trial_no)}`);
    await audit(client, req, { action: 'rd.trial_attach', entity: 'rd_trial', id: tr.id, summary: `${o.p.project_number}: ${mime === 'application/pdf' ? 'file' : 'photograph'} added to trial ${R.trialLabel(tr.trial_no)}`, after: { type: mime, size_bytes: buf.length } });
    await client.query('UPDATE rd_projects SET updated_at = NOW() WHERE id = $1', [o.p.id]);
    await client.query('COMMIT');
    res.status(201).json({ success: true, id: ins.rows[0].id, file_name: fileName, mime, size_bytes: buf.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('rd trial attach failed:', err); fail(res, 500, 'Could not save the file');
  } finally { client.release(); }
});

router.get('/projects/:id/trials/:trialId/attachments/:attId', needTrialView, needTechnical, async (req, res) => {
  const trialId = idOf(req.params.trialId), attId = idOf(req.params.attId);
  if (!trialId || !attId) return fail(res, 400, 'Invalid id');
  try {
    const o = await open(req, res); if (!o) return;
    const r = await pool.query('SELECT a.file_name, a.mime, a.data FROM rd_trial_attachments a JOIN rd_trials t ON t.id = a.trial_id WHERE a.id = $1 AND a.trial_id = $2 AND t.project_id = $3 AND a.removed_at IS NULL', [attId, trialId, o.p.id]);
    const f = r.rows[0]; if (!f) return fail(res, 404, 'File not found');
    res.set({ 'Content-Type': f.mime, 'Content-Length': f.data.length, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': `${f.mime === 'application/pdf' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(f.file_name)}` });
    res.send(f.data);
  } catch (err) { console.error('rd trial file failed:', err); fail(res, 500, 'Could not load the file'); }
});

/** Removing a file keeps it in the database and records who removed it and why; it just stops being shown. */
router.post('/projects/:id/trials/:trialId/attachments/:attId/remove', needTrialEdit, needTechnical, async (req, res) => {
  const trialId = idOf(req.params.trialId), attId = idOf(req.params.attId);
  const reason = String((req.body && req.body.reason) || '').trim();
  if (!trialId || !attId) return fail(res, 400, 'Invalid id');
  if (reason.length < 5) return fail(res, 400, 'Say why you are removing this file (at least 5 characters)');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    req.params.id = String(idOf(req.params.id) || 0);
    const o = await open(req, res, { db: client, lock: true });
    if (!o) { await client.query('ROLLBACK'); return; }
    if (!trialOpen(o.p)) { await client.query('ROLLBACK'); return conflict(res, trialClosedMessage(o.p)); }
    const r = await client.query(`UPDATE rd_trial_attachments a SET removed_at = NOW(), removed_by_name = $4, removed_reason = $5 FROM rd_trials t
      WHERE a.id = $1 AND a.trial_id = $2 AND t.id = a.trial_id AND t.project_id = $3 AND a.removed_at IS NULL RETURNING t.trial_no`, [attId, trialId, o.p.id, req.user.name, reason.slice(0, 1000)]);
    if (!r.rowCount) { await client.query('ROLLBACK'); return fail(res, 404, 'File not found'); }
    await addUpdate(client, o.p.id, 'system', req, `A file was removed from lab trial ${R.trialLabel(r.rows[0].trial_no)}`);
    await audit(client, req, { action: 'rd.trial_attach_remove', entity: 'rd_trial', id: trialId, summary: `${o.p.project_number}: file removed from trial ${R.trialLabel(r.rows[0].trial_no)}`, reason });
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('rd trial attach remove failed:', err); fail(res, 500, 'Could not remove the file');
  } finally { client.release(); }
});

module.exports = router;
