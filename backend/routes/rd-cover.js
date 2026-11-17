// routes/rd-cover.js - away and cover: who is away, when, who covers.
//   GET  /api/rd/cover              my absences, covers I hold, requests waiting for my answer or approval, the team calendar
//   GET  /api/rd/cover/preview      the work that will be waiting while someone is away
//   GET  /api/rd/cover/summary      what happened while I was away (last 14 days)
//   POST /api/rd/cover              ask to be away { user_id?, from_date, to_date, kind, reason?, handover_note?, cover_user_id? (a suggestion) }
//   PATCH /api/rd/cover/:id         change dates, kind, reason, notes or the suggested cover (the manager can change the cover)
//   POST /api/rd/cover/:id/approve  the manager approves and chooses who covers { approve, cover_user_id?, reason? }
//   POST /api/rd/cover/:id/respond  the chosen cover says "I can cover" or "I cannot cover" { accept, reason? }
//   POST /api/rd/cover/:id/end      end it early
// How it goes: the person asks. The MANAGER approves and chooses who covers (the person may only suggest someone). The chosen person
// says "I can cover". Only when both have said yes does the cover take over, from the first day: they see the person's open tasks,
// reviews and stages, and get their notices. The task stays the person's; what the cover does is recorded "on behalf of" them, and the
// cover can never review work they did for someone.
const express = require('express');
const { pool } = require('../database');
const { fail } = require('../utils');
const { audit } = require('../audit');
const { KEYS } = require('../permissions');
const { can } = require('../access');
const R = require('../rd-logic');
const { notifyUsers } = require('../notify');

const router = express.Router();
const MAX_DAYS = 90;
const KINDS = ['Leave', 'Travel', 'Training', 'Sick', 'Other'];
const COVER_ROLES = ['rd', 'rd_trainee', 'qc', 'manager', 'admin'];       // who can be asked to cover: R&D-related people
// The cover takes over only when the absence is approved AND the cover has confirmed. "Shown" also includes absences still waiting (for the calendar and warnings).
const ACTIVE = "a.ended_at IS NULL AND a.from_date <= $DATE AND a.to_date >= $DATE AND a.approval_status = 'approved' AND a.cover_status = 'accepted'";
const SHOWN = "a.ended_at IS NULL AND a.from_date <= $DATE AND a.to_date >= $DATE AND a.approval_status <> 'rejected' AND a.cover_status <> 'declined'";
const active = (n) => ACTIVE.replace(/\$DATE/g, '$' + n), shown = (n) => SHOWN.replace(/\$DATE/g, '$' + n);
const idOf = (v) => (/^\d+$/.test(String(v)) && Number(v) > 0 ? Number(v) : null);
const LIVE = "p.is_draft = FALSE AND p.status NOT IN ('Completed', 'Rejected')";

/** Is `coverId` covering `absentId` on `date` (default today)? */
async function isCovering(db, coverId, absentId, date) {
  if (!coverId || !absentId || coverId === absentId) return false;
  const r = await db.query(`SELECT 1 FROM rd_absences a WHERE a.cover_user_id = $1 AND a.user_id = $2 AND ${active(3)} LIMIT 1`, [coverId, absentId, date || R.todayIST()]);
  return r.rowCount > 0;
}
/** The people (id, name, dates, handover) `coverId` is covering today. */
async function coveredBy(db, coverId, date) {
  const r = await db.query(`SELECT a.id AS absence_id, a.user_id, u.name, a.kind, a.from_date::text AS from_date, a.to_date::text AS to_date, a.reason, a.handover_note, a.cover_status
    FROM rd_absences a JOIN users u ON u.id = a.user_id WHERE a.cover_user_id = $1 AND u.active AND ${active(2)} ORDER BY u.name`, [coverId, date || R.todayIST()]);
  return r.rows;
}
/** Who is covering each of these people today: [{ user_id, cover_user_id, absent_name }]. */
async function coversOf(db, absentIds, date) {
  const ids = [...new Set((absentIds || []).filter(Boolean))];
  if (!ids.length) return [];
  const r = await db.query(`SELECT a.user_id, a.cover_user_id, u.name AS absent_name FROM rd_absences a JOIN users u ON u.id = a.user_id
    WHERE a.user_id = ANY($1) AND ${active(2)}`, [ids, date || R.todayIST()]);
  return r.rows;
}
/** For a list of people: who of them is away today, until when, and who covers. Map user_id -> { until, cover_name }. */
async function awayToday(db, ids, date) {
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length) return new Map();
  const r = await db.query(`SELECT a.user_id, a.to_date::text AS until, cu.name AS cover_name, (a.approval_status = 'approved' AND a.cover_status = 'accepted') AS covered FROM rd_absences a LEFT JOIN users cu ON cu.id = a.cover_user_id WHERE a.user_id = ANY($1) AND ${shown(2)}`, [list, date || R.todayIST()]);
  return new Map(r.rows.map(x => [x.user_id, { until: x.until, cover_name: x.cover_name, covered: x.covered }]));
}

const SHOW = `a.id, a.user_id, au.name AS user_name, a.cover_user_id, cu.name AS cover_name, a.kind, a.from_date::text AS from_date, a.to_date::text AS to_date, a.reason,
  a.handover_note, a.cover_status, a.cover_responded_at, a.cover_decline_reason, a.created_by, a.ended_at,
  a.approval_status, a.approved_by, ap.name AS approved_by_name, a.approval_reason
  FROM rd_absences a LEFT JOIN users ap ON ap.id = a.approved_by JOIN users au ON au.id = a.user_id LEFT JOIN users cu ON cu.id = a.cover_user_id`;
router.use((req, res, next) => (req.access.isAdmin || can(req.access, KEYS.RD_VIEW) || can(req.access, KEYS.RD_EDIT) ? next() : fail(res, 403, 'Not allowed')));
// R&D editors and people who approve absences (the Manager) may record, change and end other people's absences and read their handover notes
const canManage = (req) => req.access.isAdmin || can(req.access, KEYS.RD_EDIT) || can(req.access, KEYS.RD_COVER_APPROVE);
const canApprove = (req) => req.access.isAdmin || can(req.access, KEYS.RD_COVER_APPROVE);
/** Everyone who may approve an absence (the Manager role by default, and administrators). */
async function approverIds(db) {
  const r = await db.query("SELECT DISTINCT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id WHERE u.active AND (ur.role = 'admin' OR EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role = ur.role AND rp.permission_key = 'rd.cover_approve'))");
  return r.rows.map(x => x.id);
}
const statusOf = (a, today) => (a.approval_status === 'rejected' ? 'rejected' : a.ended_at ? 'ended' : a.to_date < today ? 'finished' : a.approval_status === 'pending' ? 'waiting_approval'
  : !a.cover_user_id || a.cover_status === 'none' ? 'needs_cover' : a.cover_status === 'pending' ? 'waiting' : a.from_date <= today ? 'active' : 'confirmed');
/** One absence for the signed-in person: the handover note only for the person away, their cover, whoever recorded it, and R&D managers. */
function shape(a, req, today) {
  const me = req.user.id, mayRead = canManage(req) || a.user_id === me || a.cover_user_id === me || a.created_by === me;
  const out = { id: a.id, user_id: a.user_id, user_name: a.user_name, cover_user_id: a.cover_user_id, cover_name: a.cover_name, kind: a.kind, from_date: a.from_date, to_date: a.to_date, reason: a.reason, cover_status: a.cover_status, approval_status: a.approval_status, approved_by_name: a.approved_by_name || null, status: statusOf(a, today),
    can_edit: !a.ended_at && a.to_date >= today && (canManage(req) || a.user_id === me || a.created_by === me), can_respond: a.cover_user_id === me && a.cover_status === 'pending' && !a.ended_at && a.to_date >= today,
    can_approve: canApprove(req) && a.approval_status === 'pending' && !a.ended_at && a.to_date >= today && (a.user_id !== me || req.access.isAdmin),
    can_assign: canApprove(req) && a.approval_status === 'approved' && !a.cover_user_id && !a.ended_at && a.to_date >= today };
  if (mayRead || out.can_approve || out.can_assign) { out.handover_note = a.handover_note || ''; out.cover_decline_reason = a.cover_decline_reason || null; out.approval_reason = a.approval_reason || null; }
  return out;
}

/** What will be waiting while someone is away: their open tasks that are due by the end of the absence (or have no date), the stages they own, and the work waiting for their review. */
async function previewFor(db, userId, to) {
  const [tasks, stages, reviews] = await Promise.all([
    db.query(`SELECT t.id, t.title, t.status, t.due_date::text AS due_date, t.project_id, p.project_number FROM rd_tasks t JOIN rd_projects p ON p.id = t.project_id
      WHERE t.assignee_id = $1 AND t.status IN ('todo','in_progress','blocked') AND ${LIVE} AND (t.due_date IS NULL OR t.due_date <= $2) ORDER BY t.due_date NULLS LAST, t.id LIMIT 50`, [userId, to]),
    db.query(`SELECT p.id AS project_id, p.project_number, s.stage_no, s.planned_date::text AS planned_date FROM rd_projects p JOIN rd_stages s ON s.project_id = p.id
      WHERE ${LIVE} AND s.completed_at IS NULL AND s.stage_no = (SELECT MIN(x.stage_no) FROM rd_stages x WHERE x.project_id = p.id AND x.completed_at IS NULL)
        AND COALESCE(s.owner_user_id, p.lead_user_id) = $1 ORDER BY s.planned_date NULLS LAST, p.id LIMIT 30`, [userId]),
    db.query(`SELECT COUNT(*)::int AS n FROM rd_tasks t JOIN rd_projects p ON p.id = t.project_id WHERE t.status = 'in_review' AND ${LIVE} AND t.assignee_id IS DISTINCT FROM $1
      AND (t.created_by = $1 OR (t.stage_no IS NOT NULL AND EXISTS (SELECT 1 FROM rd_stages rs WHERE rs.project_id = t.project_id AND rs.stage_no = t.stage_no AND COALESCE(rs.owner_user_id, p.lead_user_id) = $1)))`, [userId])
  ]);
  return { tasks: tasks.rows, stages: stages.rows.map(x => ({ ...x, stage_name: R.STAGES[x.stage_no - 1].name })), reviews: reviews.rows[0].n };
}

router.get('/', async (req, res) => {
  try {
    const t = R.todayIST(), me = req.user.id;
    const upcoming = 'a.ended_at IS NULL AND a.to_date >= $2';
    const [mine, covering, team, recent, people, toApprove] = await Promise.all([
      pool.query(`SELECT ${SHOW} WHERE a.user_id = $1 AND ${upcoming} ORDER BY a.from_date`, [me, t]),
      pool.query(`SELECT ${SHOW} WHERE a.cover_user_id = $1 AND ${upcoming} ORDER BY a.from_date`, [me, t]),
      (canManage(req) || can(req.access, KEYS.RD_VIEW_ALL)) ? pool.query(`SELECT ${SHOW} WHERE ${upcoming.replace('$2', '$1')} AND a.from_date <= ($1::date + 60) ORDER BY a.from_date, au.name LIMIT 200`, [t]) : { rows: [] },
      pool.query(`SELECT ${SHOW} WHERE a.user_id = $1 AND a.cover_status <> 'declined' AND a.approval_status = 'approved' AND (a.ended_at IS NOT NULL OR a.to_date < $2) AND a.from_date <= $2 AND COALESCE(a.ended_at::date, a.to_date) >= ($2::date - 14) ORDER BY a.to_date DESC LIMIT 3`, [me, t]),
      pool.query(`SELECT u.id, u.name FROM users u WHERE u.active AND EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role = ANY($1)) ORDER BY u.name`, [COVER_ROLES]),
      canApprove(req) ? pool.query(`SELECT ${SHOW} WHERE a.ended_at IS NULL AND a.to_date >= $1 AND (a.approval_status = 'pending' OR (a.approval_status = 'approved' AND a.cover_user_id IS NULL)) ORDER BY a.from_date, au.name LIMIT 100`, [t]) : { rows: [] }
    ]);
    const all = [...mine.rows, ...covering.rows, ...team.rows];
    const mineS = mine.rows.map(a => shape(a, req, t)), covS = covering.rows.map(a => shape(a, req, t));
    res.json({ success: true, today: t, max_days: MAX_DAYS, kinds: KINDS, can_manage: canManage(req), can_approve: canApprove(req), to_approve: toApprove.rows.map(a => shape(a, req, t)), mine: mineS, covering: covS, waiting_for_me: covS.filter(a => a.can_respond),
      team: team.rows.map(a => shape(a, req, t)), people: people.rows.filter(p => p.id !== me || canManage(req)), welcome_back: recent.rows.map(a => shape(a, req, t)), _n: all.length });
  } catch (err) { console.error('rd cover list failed:', err); fail(res, 500, 'Could not load cover'); }
});

router.get('/preview', async (req, res) => {
  const who = req.query.user_id ? idOf(req.query.user_id) : req.user.id, to = String(req.query.to || '');
  if (!who || !R.isValidDate(to)) return fail(res, 400, 'Give the last day away');
  if (who !== req.user.id && !canManage(req)) return fail(res, 403, 'You can only look at your own work');
  try { res.json({ success: true, ...(await previewFor(pool, who, to)) }); } catch (err) { console.error('rd cover preview failed:', err); fail(res, 500, 'Could not load the preview'); }
});

/** "Welcome back": what was done for the person while they were away, and what has arrived since. */
router.get('/summary', async (req, res) => {
  try {
    const t = R.todayIST(), me = req.user.id;
    const r = await pool.query(`SELECT ${SHOW} WHERE a.user_id = $1 AND a.cover_status <> 'declined' AND a.approval_status = 'approved' AND (a.ended_at IS NOT NULL OR a.to_date < $2) AND a.from_date <= $2 AND COALESCE(a.ended_at::date, a.to_date) >= ($2::date - 14) ORDER BY a.to_date DESC LIMIT 1`, [me, t]);
    const a = r.rows[0]; if (!a) return res.json({ success: true, summary: null });
    const end = a.ended_at ? new Date(a.ended_at).toISOString() : a.to_date + 'T23:59:59+05:30';
    const [done, added, open] = await Promise.all([
      pool.query(`SELECT t.id, t.title, t.status, p.project_number, t.project_id, cb.name AS by_name FROM rd_tasks t JOIN rd_projects p ON p.id = t.project_id LEFT JOIN users cb ON cb.id = t.completed_by
        WHERE t.on_behalf_of = $1 AND t.completed_at >= ($2::date::timestamptz) AND t.completed_at <= $3::timestamptz ORDER BY t.completed_at LIMIT 30`, [me, a.from_date, end]),
      pool.query(`SELECT COUNT(*)::int AS n FROM rd_tasks WHERE assignee_id = $1 AND created_at >= ($2::date::timestamptz) AND created_at <= $3::timestamptz`, [me, a.from_date, end]),
      pool.query(`SELECT COUNT(*)::int AS n FROM rd_tasks t JOIN rd_projects p ON p.id = t.project_id WHERE t.assignee_id = $1 AND t.status IN ('todo','in_progress','blocked') AND ${LIVE}`, [me])
    ]);
    res.json({ success: true, summary: { absence: shape(a, req, t), done_for_me: done.rows, new_tasks: added.rows[0].n, open_now: open.rows[0].n } });
  } catch (err) { console.error('rd cover summary failed:', err); fail(res, 500, 'Could not load the summary'); }
});

/** Checks what is typed for a new or changed absence. Returns { error, status } or { who, cover, from, to, kind, reason, note, away, cv }. */
async function check(req, b, existing) {
  const bad = (status, error) => ({ status, error });
  const who = existing ? existing.user_id : (b.user_id == null || b.user_id === '' ? req.user.id : idOf(b.user_id));
  const cover = b.cover_user_id === null || b.cover_user_id === '' ? null : idOf(b.cover_user_id != null ? b.cover_user_id : (existing && existing.cover_user_id));
  const from = String(b.from_date != null ? b.from_date : (existing && existing.from_date) || ''), to = String(b.to_date != null ? b.to_date : (existing && existing.to_date) || '');
  const kind = b.kind != null ? String(b.kind) : (existing ? existing.kind : 'Leave');
  const reason = b.reason != null ? (String(b.reason).trim().slice(0, 200) || null) : (existing ? existing.reason : null);
  const note = b.handover_note != null ? (String(b.handover_note).trim().slice(0, 3000) || null) : (existing ? existing.handover_note : null);
  if (!who) return bad(400, 'Choose who is away');
  if (who !== req.user.id && !canManage(req) && !(existing && existing.created_by === req.user.id)) return bad(403, 'You can only ask for your own absence');
  // someone with authority who records it settles it on the spot, so a cover must be chosen; a person asking for themselves only suggests one
  const deciding = !existing && canApprove(req) && (who !== req.user.id || req.access.isAdmin);
  if (!cover && (deciding || (existing && existing.approval_status === 'approved'))) return bad(400, 'Choose who will cover');
  if (cover && who === cover) return bad(400, 'A person cannot cover for themselves');
  if (!KINDS.includes(kind)) return bad(400, 'Choose the type: ' + KINDS.join(', '));
  if (!R.isValidDate(from) || !R.isValidDate(to)) return bad(400, 'Give the first and last day away');
  if (to < from) return bad(400, 'The last day cannot be before the first day');
  const today = R.todayIST();
  if (to < today) return bad(400, 'The last day is already past');
  if (existing && existing.from_date <= today && from !== existing.from_date) return bad(400, 'The absence has already started, so the first day cannot be changed');
  if (!existing && from < today) return bad(400, 'The first day cannot be in the past. Use today if you are already away.');
  if ((Date.parse(to) - Date.parse(from)) / 86400000 + 1 > MAX_DAYS) return bad(400, `An absence can be at most ${MAX_DAYS} days. Ask again when it ends.`);
  const away = await personCheck(who, null);
  if (!away || !away.active) return bad(400, 'That person is not an active user');
  const overlap = (id, col) => pool.query(`SELECT 1 FROM rd_absences WHERE ${col} = $1 AND ended_at IS NULL AND from_date <= $3 AND to_date >= $2 AND id <> $4 LIMIT 1`, [id, from, to, existing ? existing.id : 0]);
  if ((await overlap(who, 'user_id')).rowCount) return bad(409, `${away.name} already has an absence on those dates. Change or end it first.`);
  let cv = null;
  if (cover) { const bc = await coverCheck(cover, from, to, existing ? existing.id : 0); if (bc) return bc; cv = await personCheck(cover, null); }
  return { who, cover, from, to, kind, reason, note, away, cv, deciding };
}
async function personCheck(id) {
  const u = await pool.query(`SELECT u.id, u.name, u.active, EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role = ANY($2)) AS rd FROM users u WHERE u.id = $1`, [id, COVER_ROLES]);
  return u.rows[0] || null;
}
/** Can this person cover on those dates? Returns an error object, or null when fine. */
async function coverCheck(coverId, from, to, exceptAbsenceId) {
  const cv = await personCheck(coverId);
  if (!cv || !cv.active) return { status: 400, error: 'The person chosen to cover is not an active user' };
  if (!cv.rd) return { status: 400, error: 'The person who covers must be in the R&D team (R&D, trainee, quality, manager or administrator)' };
  const clash = await pool.query('SELECT 1 FROM rd_absences WHERE user_id = $1 AND ended_at IS NULL AND from_date <= $3 AND to_date >= $2 AND id <> $4 LIMIT 1', [coverId, from, to, exceptAbsenceId || 0]);
  if (clash.rowCount) return { status: 409, error: `${cv.name} is away on those dates too, so cannot cover. Choose someone else.` };
  return null;
}
const tellOne = (ids, o) => { try { notifyUsers(ids, o); } catch (e) { console.error('notice failed:', e.message); } };

const dates = (a) => `${R.dmy(a.from_date || a.from)} to ${R.dmy(a.to_date || a.to)}`;
const askCover = (req, cover, awayName, from, to, kind, reason, hasNote) => tellOne([cover].filter(x => x && x !== req.user.id), { kind: 'cover_request', subject: `Can you cover for ${awayName}?`,
  text: `${awayName} will be away from ${R.dmy(from)} to ${R.dmy(to)} (${kind}${reason ? ', ' + reason : ''}) and the manager chose you to cover. ${hasNote ? 'Notes were left for you. ' : ''}Please open "Away and cover" and press "I can cover" or "I cannot cover".`, path: 'cover.html' });

router.post('/', async (req, res) => {
  try {
    const c = await check(req, req.body || {}, null); if (c.error) return fail(res, c.status, c.error);
    // a manager (or administrator) recording it settles it at once and the cover is asked straight away; otherwise it waits for the manager
    const auto = c.deciding;
    const ins = await pool.query(`INSERT INTO rd_absences (user_id, cover_user_id, from_date, to_date, kind, reason, handover_note, created_by, approval_status, approved_by, approved_at, cover_status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,${auto ? 'NOW()' : 'NULL'},$11) RETURNING id`, [c.who, c.cover, c.from, c.to, c.kind, c.reason, c.note, req.user.id, auto ? 'approved' : 'pending', auto ? req.user.id : null, auto ? 'pending' : 'none']);
    await audit(pool, req, { action: 'rd.cover_set', entity: 'rd_absence', id: ins.rows[0].id, summary: `${c.away.name} away ${c.from} to ${c.to} (${c.kind})${c.cv ? ', cover ' + (auto ? '' : 'suggested: ') + c.cv.name : ''}` });
    if (auto) askCover(req, c.cover, c.away.name, c.from, c.to, c.kind, c.reason, !!c.note);
    else tellOne((await approverIds(pool)).filter(x => x !== req.user.id), { kind: 'cover_request', subject: `Please decide: ${c.away.name} wants to be away`, text: `${c.away.name} asks to be away from ${dates(c)} (${c.kind}${c.reason ? ', ' + c.reason : ''}). ${c.cv ? 'They suggest ' + c.cv.name + ' as cover.' : 'They did not suggest a cover.'} Please open "Away and cover", choose who will cover, and approve or say no.`, path: 'cover.html' });
    if (c.who !== req.user.id) tellOne([c.who], { kind: 'cover_response', subject: 'Your absence is recorded', text: `${req.user.name} recorded your absence from ${dates(c)}.${c.cv ? ' ' + c.cv.name + ' was asked to cover your work.' : ''}`, path: 'cover.html' });
    const heads = await previewFor(pool, c.who, c.to);
    res.status(201).json({ success: true, id: ins.rows[0].id, approval: auto ? 'approved' : 'pending', heads_up: { tasks: heads.tasks.length, stages: heads.stages.length, reviews: heads.reviews } });
  } catch (err) { console.error('rd cover create failed:', err); fail(res, 500, 'Could not save'); }
});

router.patch('/:id', async (req, res) => {
  const id = idOf(req.params.id); if (!id) return fail(res, 400, 'Invalid id');
  try {
    const r = await pool.query(`SELECT ${SHOW} WHERE a.id = $1`, [id]); const a = r.rows[0];
    if (!a || a.ended_at) return fail(res, 404, 'Absence not found');
    if (!(canManage(req) || a.user_id === req.user.id || a.created_by === req.user.id)) return fail(res, 403, 'Only the person away or the manager can change this');
    const body = req.body || {};
    const c = await check(req, body, a); if (c.error) return fail(res, c.status, c.error);
    const coverChanged = (c.cover || null) !== (a.cover_user_id || null);
    if (coverChanged && a.approval_status === 'approved' && !canApprove(req)) return fail(res, 403, 'The manager chose who covers. Ask the manager to change it.');
    const datesChanged = c.from !== a.from_date || c.to !== a.to_date;
    const changed = coverChanged || datesChanged || c.kind !== a.kind || (c.reason || null) !== (a.reason || null) || (c.note || null) !== (a.handover_note || null);
    if (!changed) return fail(res, 400, 'Nothing was changed');
    // new dates need the manager again (unless the manager made the change); the cover is only asked once the absence is approved
    const reapprove = datesChanged && a.approval_status === 'approved' && !(canApprove(req) && (a.user_id !== req.user.id || req.access.isAdmin));
    const approval = reapprove ? 'pending' : a.approval_status;
    const coverStatus = !c.cover ? 'none' : approval !== 'approved' ? ((coverChanged || datesChanged) ? 'none' : a.cover_status) : ((coverChanged || datesChanged) ? 'pending' : a.cover_status);
    const resetCover = coverStatus !== a.cover_status;
    await pool.query(`UPDATE rd_absences SET cover_user_id = $2, from_date = $3, to_date = $4, kind = $5, reason = $6, handover_note = $7, cover_status = $8, updated_at = NOW()${resetCover ? ', cover_responded_at = NULL, cover_decline_reason = NULL' : ''}${reapprove ? ", approval_status = 'pending', approved_by = NULL, approved_at = NULL" : ''} WHERE id = $1`, [id, c.cover, c.from, c.to, c.kind, c.reason, c.note, coverStatus]);
    await audit(pool, req, { action: 'rd.cover_edit', entity: 'rd_absence', id, summary: `Absence of ${a.user_name} changed: ${c.from} to ${c.to}${c.cv ? ', cover ' + c.cv.name : ''}` });
    if (coverStatus === 'pending' && resetCover) askCover(req, c.cover, c.away.name, c.from, c.to, c.kind, c.reason, !!c.note);
    if (coverChanged && a.cover_user_id && ['pending', 'accepted'].includes(a.cover_status)) tellOne([a.cover_user_id].filter(x => x !== req.user.id), { kind: 'cover_response', subject: 'You no longer need to cover', text: `Someone else will cover for ${c.away.name} from ${dates(a)}. You do not need to do anything.`, path: 'cover.html' });
    else if (datesChanged && a.cover_user_id && ['pending', 'accepted'].includes(a.cover_status) && !resetCover) tellOne([a.cover_user_id].filter(x => x !== req.user.id), { kind: 'cover_response', subject: `New dates: cover for ${c.away.name}`, text: `${c.away.name} will now be away ${dates(c)}.`, path: 'cover.html' });
    if (reapprove) tellOne((await approverIds(pool)).filter(x => x !== req.user.id), { kind: 'cover_request', subject: `Please decide again: ${c.away.name}'s dates changed`, text: `${c.away.name} now asks to be away ${dates(c)}. Please open "Away and cover" and approve or say no.`, path: 'cover.html' });
    res.json({ success: true });
  } catch (err) { console.error('rd cover edit failed:', err); fail(res, 500, 'Could not save the change'); }
});

/** The chosen person's answer. "I cannot cover" ends it and tells the manager and the person, so another cover can be chosen. */
router.post('/:id/respond', async (req, res) => {
  const id = idOf(req.params.id); if (!id) return fail(res, 400, 'Invalid id');
  const accept = req.body && req.body.accept === true, reason = String((req.body && req.body.reason) || '').trim();
  if (!accept && reason.length < 5) return fail(res, 400, 'Say why you cannot cover (at least 5 characters)');
  try {
    const r = await pool.query(`SELECT ${SHOW} WHERE a.id = $1`, [id]); const a = r.rows[0];
    if (!a || a.ended_at || a.to_date < R.todayIST()) return fail(res, 404, 'Request not found');
    if (a.cover_user_id !== req.user.id) return fail(res, 403, 'Only the person asked to cover can answer');
    if (a.cover_status === 'none') return fail(res, 409, 'You have not been asked to cover yet: the manager has to approve and choose first');
    if (a.cover_status !== 'pending') return fail(res, 409, 'This has already been answered');
    if (accept) await pool.query("UPDATE rd_absences SET cover_status = 'accepted', cover_responded_at = NOW(), updated_at = NOW() WHERE id = $1", [id]);
    else await pool.query("UPDATE rd_absences SET cover_status = 'none', cover_user_id = NULL, cover_responded_at = NOW(), cover_decline_reason = $2, updated_at = NOW() WHERE id = $1", [id, reason.slice(0, 1000)]);
    await audit(pool, req, { action: accept ? 'rd.cover_accept' : 'rd.cover_decline', entity: 'rd_absence', id, summary: `${a.cover_name} said ${accept ? '"I can cover"' : '"I cannot cover"'} for ${a.user_name} (${a.from_date} to ${a.to_date})`, reason: accept ? undefined : reason });
    const when = dates(a);
    if (accept) tellOne([...new Set([a.user_id, a.created_by, a.approved_by].filter(x => x && x !== req.user.id))], { kind: 'cover_response', subject: `${a.cover_name} will cover`, text: `${a.cover_name} said "I can cover" for ${a.user_name} from ${when}.`, path: 'cover.html' });
    else tellOne([...new Set([a.approved_by, ...(await approverIds(pool)), a.user_id].filter(x => x && x !== req.user.id))], { kind: 'cover_response', subject: `${a.cover_name} cannot cover: please choose someone else`, text: `${a.cover_name} cannot cover for ${a.user_name} from ${when}: ${reason}. The absence is still approved, but nobody is chosen to cover yet. Please open "Away and cover" and choose another person.`, path: 'cover.html' });
    res.json({ success: true, status: accept ? 'accepted' : 'declined' });
  } catch (err) { console.error('rd cover respond failed:', err); fail(res, 500, 'Could not save your answer'); }
});

/** The manager approves (and chooses who covers) or says no with a reason. */
router.post('/:id/approve', async (req, res) => {
  const id = idOf(req.params.id); if (!id) return fail(res, 400, 'Invalid id');
  const approve = req.body && req.body.approve === true, reason = String((req.body && req.body.reason) || '').trim();
  if (!canApprove(req)) return fail(res, 403, 'Only the manager (or an administrator) can approve an absence');
  if (!approve && reason.length < 5) return fail(res, 400, 'Say why it is not approved (at least 5 characters)');
  try {
    const r = await pool.query(`SELECT ${SHOW} WHERE a.id = $1`, [id]); const a = r.rows[0];
    if (!a || a.ended_at || a.to_date < R.todayIST()) return fail(res, 404, 'Request not found');
    if (a.user_id === req.user.id && !req.access.isAdmin) return fail(res, 403, 'Someone else has to approve your absence');
    if (a.approval_status !== 'pending') return fail(res, 409, 'This has already been decided');
    const when = dates(a);
    if (!approve) {
      await pool.query("UPDATE rd_absences SET approval_status = 'rejected', approved_by = $2, approved_at = NOW(), approval_reason = $3, ended_at = NOW(), updated_at = NOW() WHERE id = $1", [id, req.user.id, reason.slice(0, 1000)]);
      await audit(pool, req, { action: 'rd.cover_refuse', entity: 'rd_absence', id, summary: `Absence of ${a.user_name} (${a.from_date} to ${a.to_date}) not approved by ${req.user.name}`, reason });
      tellOne([...new Set([a.user_id, a.created_by].filter(x => x && x !== req.user.id))], { kind: 'cover_response', subject: `Not approved: ${when}`, text: `${req.user.name} did not approve your absence from ${when}: ${reason}. Please talk to them.`, path: 'cover.html' });
      return res.json({ success: true, status: 'rejected' });
    }
    const chosen = req.body.cover_user_id != null && req.body.cover_user_id !== '' ? idOf(req.body.cover_user_id) : a.cover_user_id;
    if (!chosen) return fail(res, 400, 'Choose who will cover before you approve');
    if (chosen === a.user_id) return fail(res, 400, 'A person cannot cover for themselves');
    const bad = await coverCheck(chosen, a.from_date, a.to_date, id); if (bad) return fail(res, bad.status, bad.error);
    const asked = chosen !== a.cover_user_id || a.cover_status === 'none';                   // a newly chosen person has to say yes; someone who already said yes stays
    await pool.query(`UPDATE rd_absences SET approval_status = 'approved', approved_by = $2, approved_at = NOW(), cover_user_id = $3, cover_status = $4, updated_at = NOW()${asked ? ', cover_responded_at = NULL, cover_decline_reason = NULL' : ''} WHERE id = $1`, [id, req.user.id, chosen, asked ? 'pending' : a.cover_status]);
    const cv = await personCheck(chosen);
    await audit(pool, req, { action: 'rd.cover_approve', entity: 'rd_absence', id, summary: `Absence of ${a.user_name} (${a.from_date} to ${a.to_date}) approved by ${req.user.name}; cover ${cv.name}` });
    if (asked) askCover(req, chosen, a.user_name, a.from_date, a.to_date, a.kind, a.reason, !!a.handover_note);
    tellOne([...new Set([a.user_id, a.created_by].filter(x => x && x !== req.user.id))], { kind: 'cover_response', subject: `Approved: ${when}`, text: `${req.user.name} approved your absence from ${when}. ${cv.name} will cover your work${asked ? ' once they say "I can cover"' : ''}.`, path: 'cover.html' });
    res.json({ success: true, status: 'approved', cover_name: cv.name });
  } catch (err) { console.error('rd cover approve failed:', err); fail(res, 500, 'Could not save the decision'); }
});

router.post('/:id/end', async (req, res) => {
  const id = idOf(req.params.id);
  if (!id) return fail(res, 400, 'Invalid id');
  try {
    const r = await pool.query(`SELECT ${SHOW} WHERE a.id = $1`, [id]);
    const a = r.rows[0];
    if (!a || a.ended_at) return fail(res, 404, 'Absence not found');
    if (!(canManage(req) || a.user_id === req.user.id || a.cover_user_id === req.user.id || a.created_by === req.user.id)) return fail(res, 403, 'Only the person away, the cover, or R&D management can end this');
    await pool.query('UPDATE rd_absences SET ended_at = NOW(), updated_at = NOW() WHERE id = $1', [id]);
    await audit(pool, req, { action: 'rd.cover_end', entity: 'rd_absence', id, summary: `Cover ended early: ${a.user_name} / ${a.cover_name}` });
    res.json({ success: true });
  } catch (err) { console.error('rd cover end failed:', err); fail(res, 500, 'Could not end the cover'); }
});

module.exports = { router, isCovering, coveredBy, coversOf, awayToday, previewFor, approverIds, KINDS };
