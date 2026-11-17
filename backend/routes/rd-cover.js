// routes/rd-cover.js - "Away and cover": who is away, when, who covers, and the handover.
//   GET  /api/rd/cover              my absences, covers I hold, requests waiting for my answer, the team calendar, who can cover
//   GET  /api/rd/cover/preview      what will be waiting while someone is away (open tasks, stages owned, reviews)
//   GET  /api/rd/cover/summary      "welcome back": what happened while I was away (last 14 days)
//   POST /api/rd/cover              { user_id?, cover_user_id, from_date, to_date, kind, reason?, handover_note? }
//   PATCH /api/rd/cover/:id         change dates, cover, kind, reason or the handover note
//   POST /api/rd/cover/:id/respond  the cover confirms or declines { accept, reason? }
//   POST /api/rd/cover/:id/end      end it early
// While an absence is active (today is between its dates and it has not been ended or declined) the cover person may do the absent
// person's open tasks, sees their reviews and stages, and gets their notices. The task stays the absent person's; what the cover
// does is recorded "on behalf of" them. Doing work for someone never lets the cover review that same work.
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
  const r = await db.query(`SELECT a.user_id, a.to_date::text AS until, cu.name AS cover_name, (a.approval_status = 'approved' AND a.cover_status = 'accepted') AS covered FROM rd_absences a JOIN users cu ON cu.id = a.cover_user_id WHERE a.user_id = ANY($1) AND ${shown(2)}`, [list, date || R.todayIST()]);
  return new Map(r.rows.map(x => [x.user_id, { until: x.until, cover_name: x.cover_name, covered: x.covered }]));
}

const SHOW = `a.id, a.user_id, au.name AS user_name, a.cover_user_id, cu.name AS cover_name, a.kind, a.from_date::text AS from_date, a.to_date::text AS to_date, a.reason,
  a.handover_note, a.cover_status, a.cover_responded_at, a.cover_decline_reason, a.created_by, a.ended_at,
  a.approval_status, a.approved_by, ap.name AS approved_by_name, a.approval_reason
  FROM rd_absences a LEFT JOIN users ap ON ap.id = a.approved_by JOIN users au ON au.id = a.user_id JOIN users cu ON cu.id = a.cover_user_id`;
router.use((req, res, next) => (req.access.isAdmin || can(req.access, KEYS.RD_VIEW) || can(req.access, KEYS.RD_EDIT) ? next() : fail(res, 403, 'Not allowed')));
// R&D editors and people who approve absences (the Manager) may record, change and end other people's absences and read their handover notes
const canManage = (req) => req.access.isAdmin || can(req.access, KEYS.RD_EDIT) || can(req.access, KEYS.RD_COVER_APPROVE);
const canApprove = (req) => req.access.isAdmin || can(req.access, KEYS.RD_COVER_APPROVE);
/** Everyone who may approve an absence (the Manager role by default, and administrators). */
async function approverIds(db) {
  const r = await db.query("SELECT DISTINCT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id WHERE u.active AND (ur.role = 'admin' OR EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role = ur.role AND rp.permission_key = 'rd.cover_approve'))");
  return r.rows.map(x => x.id);
}
const statusOf = (a, today) => (a.approval_status === 'rejected' ? 'rejected' : a.cover_status === 'declined' ? 'declined' : a.ended_at ? 'ended' : a.to_date < today ? 'finished'
  : a.approval_status === 'pending' ? 'waiting_approval' : a.cover_status === 'pending' ? 'waiting' : a.from_date <= today ? 'active' : 'confirmed');
/** One absence for the signed-in person: the handover note only for the person away, their cover, whoever recorded it, and R&D managers. */
function shape(a, req, today) {
  const me = req.user.id, mayRead = canManage(req) || a.user_id === me || a.cover_user_id === me || a.created_by === me;
  const out = { id: a.id, user_id: a.user_id, user_name: a.user_name, cover_user_id: a.cover_user_id, cover_name: a.cover_name, kind: a.kind, from_date: a.from_date, to_date: a.to_date, reason: a.reason, cover_status: a.cover_status, approval_status: a.approval_status, approved_by_name: a.approved_by_name || null, status: statusOf(a, today),
    can_edit: !a.ended_at && a.to_date >= today && (canManage(req) || a.user_id === me || a.created_by === me), can_respond: a.cover_user_id === me && a.cover_status === 'pending' && !a.ended_at && a.to_date >= today,
    can_approve: canApprove(req) && a.approval_status === 'pending' && !a.ended_at && a.to_date >= today && (a.user_id !== me || req.access.isAdmin) };
  if (mayRead || out.can_approve) { out.handover_note = a.handover_note || ''; out.cover_decline_reason = a.cover_decline_reason || null; out.approval_reason = a.approval_reason || null; }
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
      canApprove(req) ? pool.query(`SELECT ${SHOW} WHERE a.approval_status = 'pending' AND a.ended_at IS NULL AND a.cover_status <> 'declined' AND a.to_date >= $1 ORDER BY a.from_date, au.name LIMIT 100`, [t]) : { rows: [] }
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
  const cover = idOf(b.cover_user_id != null ? b.cover_user_id : (existing && existing.cover_user_id));
  const from = String(b.from_date != null ? b.from_date : (existing && existing.from_date) || ''), to = String(b.to_date != null ? b.to_date : (existing && existing.to_date) || '');
  const kind = b.kind != null ? String(b.kind) : (existing ? existing.kind : 'Leave');
  const reason = b.reason != null ? (String(b.reason).trim().slice(0, 200) || null) : (existing ? existing.reason : null);
  const note = b.handover_note != null ? (String(b.handover_note).trim().slice(0, 3000) || null) : (existing ? existing.handover_note : null);
  if (!who || !cover) return bad(400, 'Choose who is away and who will cover');
  if (who !== req.user.id && !canManage(req) && !(existing && existing.created_by === req.user.id)) return bad(403, 'You can only record your own absence');
  if (who === cover) return bad(400, 'Someone cannot cover for themselves');
  if (!KINDS.includes(kind)) return bad(400, 'Choose the kind of absence: ' + KINDS.join(', '));
  if (!R.isValidDate(from) || !R.isValidDate(to)) return bad(400, 'Give the first and last day away');
  if (to < from) return bad(400, 'The last day cannot be before the first day');
  const today = R.todayIST();
  if (to < today) return bad(400, 'The last day is already past');
  if (existing && existing.from_date <= today && from !== existing.from_date) return bad(400, 'The absence has already started, so its first day cannot be changed');
  if (!existing && from < today) return bad(400, 'The first day cannot be in the past. Use today if you are already away.');
  if ((Date.parse(to) - Date.parse(from)) / 86400000 + 1 > MAX_DAYS) return bad(400, `Cover can last at most ${MAX_DAYS} days. Record a new one when it ends.`);
  const u = await pool.query(`SELECT u.id, u.name, u.active, EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role = ANY($2)) AS rd FROM users u WHERE u.id = ANY($1)`, [[who, cover], COVER_ROLES]);
  const away = u.rows.find(x => x.id === who), cv = u.rows.find(x => x.id === cover);
  if (!away || !away.active) return bad(400, 'That person is not an active user');
  if (!cv || !cv.active) return bad(400, 'The cover person is not an active user');
  if (!cv.rd) return bad(400, 'The cover person must be in the R&D team (R&D, trainee, quality, manager or administrator)');
  const overlap = (id, col) => pool.query(`SELECT 1 FROM rd_absences WHERE ${col} = $1 AND ended_at IS NULL AND from_date <= $3 AND to_date >= $2 AND id <> $4 LIMIT 1`, [id, from, to, existing ? existing.id : 0]);
  if ((await overlap(who, 'user_id')).rowCount) return bad(409, `${away.name} already has an absence recorded in those dates. Change or end it first.`);
  if ((await overlap(cover, 'user_id')).rowCount) return bad(409, `${cv.name} is away in those dates too, so cannot cover. Choose someone else.`);
  return { who, cover, from, to, kind, reason, note, away, cv };
}
const tellOne = (ids, o) => { try { notifyUsers(ids, o); } catch (e) { console.error('notice failed:', e.message); } };

router.post('/', async (req, res) => {
  try {
    const c = await check(req, req.body || {}, null); if (c.error) return fail(res, c.status, c.error);
    // someone with authority who records another person's absence has approved it by doing so; nobody approves their own (an administrator excepted)
    const auto = canApprove(req) && (c.who !== req.user.id || req.access.isAdmin);
    const ins = await pool.query(`INSERT INTO rd_absences (user_id, cover_user_id, from_date, to_date, kind, reason, handover_note, created_by, approval_status, approved_by, approved_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,${auto ? 'NOW()' : 'NULL'}) RETURNING id`, [c.who, c.cover, c.from, c.to, c.kind, c.reason, c.note, req.user.id, auto ? 'approved' : 'pending', auto ? req.user.id : null]);
    await audit(pool, req, { action: 'rd.cover_set', entity: 'rd_absence', id: ins.rows[0].id, summary: `${c.away.name} away ${c.from} to ${c.to} (${c.kind}), cover ${c.cv.name}` });
    const when = `${R.dmy(c.from)} to ${R.dmy(c.to)}`;
    tellOne([c.cover].filter(x => x !== req.user.id), { kind: 'cover_request', subject: `Can you cover for ${c.away.name}?`, text: `${req.user.name} asked you to cover for ${c.away.name} from ${when}${c.reason ? ' (' + c.reason + ')' : ''}.${c.note ? ' A handover note was left for you.' : ''} Please open "Away and cover" and confirm that you can, or say that you cannot so another cover can be chosen.`, path: 'cover.html' });
    if (!auto) tellOne((await approverIds(pool)).filter(x => x !== req.user.id && x !== c.cover), { kind: 'cover_request', subject: `Please approve: ${c.away.name} will be away`, text: `${c.away.name} will be away from ${when} (${c.kind}${c.reason ? ', ' + c.reason : ''}), with ${c.cv.name} as cover. Please open "Away and cover" to approve or refuse it. The cover only takes over once you approve and ${c.cv.name} confirms.`, path: 'cover.html' });
    if (c.who !== req.user.id) tellOne([c.who], { kind: 'cover_response', subject: 'Your absence and cover', text: `${req.user.name} recorded your absence from ${when}. ${c.cv.name} was asked to cover your tasks.`, path: 'cover.html' });
    const heads = await previewFor(pool, c.who, c.to);
    res.status(201).json({ success: true, id: ins.rows[0].id, approval: auto ? 'approved' : 'pending', heads_up: { tasks: heads.tasks.length, stages: heads.stages.length, reviews: heads.reviews } });
  } catch (err) { console.error('rd cover create failed:', err); fail(res, 500, 'Could not record the absence'); }
});

router.patch('/:id', async (req, res) => {
  const id = idOf(req.params.id); if (!id) return fail(res, 400, 'Invalid id');
  try {
    const r = await pool.query(`SELECT ${SHOW} WHERE a.id = $1`, [id]); const a = r.rows[0];
    if (!a || a.ended_at) return fail(res, 404, 'Absence not found');
    if (!(canManage(req) || a.user_id === req.user.id || a.created_by === req.user.id)) return fail(res, 403, 'Only the person away or R&D management can change this');
    const c = await check(req, req.body || {}, a); if (c.error) return fail(res, c.status, c.error);
    const coverChanged = c.cover !== a.cover_user_id;
    const changed = coverChanged || c.from !== a.from_date || c.to !== a.to_date || c.kind !== a.kind || (c.reason || null) !== (a.reason || null) || (c.note || null) !== (a.handover_note || null);
    if (!changed) return fail(res, 400, 'Nothing was changed');
    const datesChanged = c.from !== a.from_date || c.to !== a.to_date;
    const reapprove = (coverChanged || datesChanged) && a.approval_status === 'approved' && !(canApprove(req) && (a.user_id !== req.user.id || req.access.isAdmin));      // a changed plan needs approving again
    await pool.query(`UPDATE rd_absences SET cover_user_id = $2, from_date = $3, to_date = $4, kind = $5, reason = $6, handover_note = $7, updated_at = NOW()${coverChanged ? ", cover_status = 'pending', cover_responded_at = NULL, cover_decline_reason = NULL" : ''}${reapprove ? ", approval_status = 'pending', approved_by = NULL, approved_at = NULL" : ''} WHERE id = $1`, [id, c.cover, c.from, c.to, c.kind, c.reason, c.note]);
    if (reapprove) tellOne((await approverIds(pool)).filter(x => x !== req.user.id), { kind: 'cover_request', subject: `Please approve again: ${c.away.name}'s absence changed`, text: `${c.away.name}'s absence now runs ${R.dmy(c.from)} to ${R.dmy(c.to)} with ${c.cv.name} as cover. It needs approving again.`, path: 'cover.html' });
    await audit(pool, req, { action: 'rd.cover_edit', entity: 'rd_absence', id, summary: `Absence of ${a.user_name} changed: ${c.from} to ${c.to}, cover ${c.cv.name}` });
    const when = `${R.dmy(c.from)} to ${R.dmy(c.to)}`;
    if (coverChanged) {
      tellOne([c.cover].filter(x => x !== req.user.id), { kind: 'cover_request', subject: `Can you cover for ${c.away.name}?`, text: `${req.user.name} asked you to cover for ${c.away.name} from ${when}. Please open "Away and cover" and confirm that you can.`, path: 'cover.html' });
      tellOne([a.cover_user_id].filter(x => x !== req.user.id), { kind: 'cover_response', subject: 'You are no longer asked to cover', text: `${c.away.name}'s cover from ${R.dmy(a.from_date)} to ${R.dmy(a.to_date)} was given to ${c.cv.name}. You do not need to do anything.`, path: 'cover.html' });
    } else if (c.from !== a.from_date || c.to !== a.to_date) tellOne([a.cover_user_id].filter(x => x !== req.user.id), { kind: 'cover_response', subject: `Dates changed: cover for ${c.away.name}`, text: `${c.away.name} will now be away from ${when}. You are still the cover.`, path: 'cover.html' });
    res.json({ success: true });
  } catch (err) { console.error('rd cover edit failed:', err); fail(res, 500, 'Could not change the absence'); }
});

/** The cover's own answer. Declining ends the absence's cover (it is kept in the history) and tells the person away to choose someone else. */
router.post('/:id/respond', async (req, res) => {
  const id = idOf(req.params.id); if (!id) return fail(res, 400, 'Invalid id');
  const accept = req.body && req.body.accept === true, reason = String((req.body && req.body.reason) || '').trim();
  if (!accept && reason.length < 5) return fail(res, 400, 'Say why you cannot cover (at least 5 characters), so another cover can be chosen');
  try {
    const r = await pool.query(`SELECT ${SHOW} WHERE a.id = $1`, [id]); const a = r.rows[0];
    if (!a || a.ended_at || a.to_date < R.todayIST()) return fail(res, 404, 'Request not found');
    if (a.cover_user_id !== req.user.id) return fail(res, 403, 'Only the person asked to cover can answer');
    if (a.cover_status !== 'pending') return fail(res, 409, 'This has already been answered');
    if (accept) await pool.query("UPDATE rd_absences SET cover_status = 'accepted', cover_responded_at = NOW(), updated_at = NOW() WHERE id = $1", [id]);
    else await pool.query("UPDATE rd_absences SET cover_status = 'declined', cover_responded_at = NOW(), cover_decline_reason = $2, ended_at = NOW(), updated_at = NOW() WHERE id = $1", [id, reason.slice(0, 1000)]);
    await audit(pool, req, { action: accept ? 'rd.cover_accept' : 'rd.cover_decline', entity: 'rd_absence', id, summary: `${a.cover_name} ${accept ? 'confirmed' : 'declined'} covering for ${a.user_name} (${a.from_date} to ${a.to_date})`, reason: accept ? undefined : reason });
    const who = [...new Set([a.user_id, a.created_by].filter(x => x && x !== req.user.id))];
    tellOne(who, accept
      ? { kind: 'cover_response', subject: `${a.cover_name} will cover`, text: `${a.cover_name} confirmed that they will cover for ${a.user_name} from ${R.dmy(a.from_date)} to ${R.dmy(a.to_date)}.`, path: 'cover.html' }
      : { kind: 'cover_response', subject: `${a.cover_name} cannot cover: please choose someone else`, text: `${a.cover_name} cannot cover for ${a.user_name} from ${R.dmy(a.from_date)} to ${R.dmy(a.to_date)}: ${reason}. Please record the absence again with another cover so the work is not left without one.`, path: 'cover.html' });
    res.json({ success: true, status: accept ? 'accepted' : 'declined' });
  } catch (err) { console.error('rd cover respond failed:', err); fail(res, 500, 'Could not save your answer'); }
});

/** Approve or refuse an absence. Refusing needs a reason and ends it; the person is told and chooses again. */
router.post('/:id/approve', async (req, res) => {
  const id = idOf(req.params.id); if (!id) return fail(res, 400, 'Invalid id');
  const approve = req.body && req.body.approve === true, reason = String((req.body && req.body.reason) || '').trim();
  if (!canApprove(req)) return fail(res, 403, 'Only someone who approves absences (the Manager, or an administrator) can do this');
  if (!approve && reason.length < 5) return fail(res, 400, 'Say why it is not approved (at least 5 characters)');
  try {
    const r = await pool.query(`SELECT ${SHOW} WHERE a.id = $1`, [id]); const a = r.rows[0];
    if (!a || a.ended_at || a.to_date < R.todayIST()) return fail(res, 404, 'Request not found');
    if (a.user_id === req.user.id && !req.access.isAdmin) return fail(res, 403, 'Someone else has to approve your absence');
    if (a.approval_status !== 'pending') return fail(res, 409, 'This has already been decided');
    if (approve) await pool.query("UPDATE rd_absences SET approval_status = 'approved', approved_by = $2, approved_at = NOW(), updated_at = NOW() WHERE id = $1", [id, req.user.id]);
    else await pool.query("UPDATE rd_absences SET approval_status = 'rejected', approved_by = $2, approved_at = NOW(), approval_reason = $3, ended_at = NOW(), updated_at = NOW() WHERE id = $1", [id, req.user.id, reason.slice(0, 1000)]);
    await audit(pool, req, { action: approve ? 'rd.cover_approve' : 'rd.cover_refuse', entity: 'rd_absence', id, summary: `Absence of ${a.user_name} (${a.from_date} to ${a.to_date}) ${approve ? 'approved' : 'not approved'} by ${req.user.name}`, reason: approve ? undefined : reason });
    const when = `${R.dmy(a.from_date)} to ${R.dmy(a.to_date)}`;
    tellOne([...new Set([a.user_id, a.created_by].filter(x => x && x !== req.user.id))], approve
      ? { kind: 'cover_response', subject: `Approved: your absence ${when}`, text: `${req.user.name} approved your absence from ${when}.${a.cover_status === 'accepted' ? ` ${a.cover_name} has confirmed and will take over your work on the first day.` : ` ${a.cover_name} has not confirmed yet; the cover takes over once they do.`}`, path: 'cover.html' }
      : { kind: 'cover_response', subject: `Not approved: your absence ${when}`, text: `${req.user.name} did not approve your absence from ${when}: ${reason}. Please talk to them and record it again.`, path: 'cover.html' });
    tellOne([a.cover_user_id].filter(x => x !== req.user.id), approve
      ? { kind: 'cover_response', subject: `Approved: you cover for ${a.user_name}`, text: `${a.user_name}'s absence from ${when} was approved.${a.cover_status === 'pending' ? ' Please open Away and cover and confirm that you can cover.' : ' You take over their work on the first day.'}`, path: 'cover.html' }
      : { kind: 'cover_response', subject: `No longer needed: cover for ${a.user_name}`, text: `${a.user_name}'s absence from ${when} was not approved, so you do not need to cover.`, path: 'cover.html' });
    res.json({ success: true, status: approve ? 'approved' : 'rejected' });
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
