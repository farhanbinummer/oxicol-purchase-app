// routes/rd-cover.js - cover while someone is away.
//   GET  /api/rd/cover            my absences, who I am covering, and (for R&D editors) everyone's upcoming absences
//   POST /api/rd/cover            { user_id?, cover_user_id, from_date, to_date, reason? }  record an absence and who covers it
//   POST /api/rd/cover/:id/end    end it early
// While an absence is active (today is between its dates and it has not been ended) the cover person may do the absent person's open
// tasks and gets their notices. The task stays the absent person's; what the cover does is recorded "on behalf of" them.
// Doing work for someone never lets the cover review that same work (the person who did it can never accept it).
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
const COVER_ROLES = ['rd', 'rd_trainee', 'qc', 'manager', 'admin'];       // who can be asked to cover: R&D-related people
const ACTIVE = 'a.ended_at IS NULL AND a.from_date <= $DATE AND a.to_date >= $DATE';
const active = (n) => ACTIVE.replace(/\$DATE/g, '$' + n);
const idOf = (v) => (/^\d+$/.test(String(v)) && Number(v) > 0 ? Number(v) : null);

/** Is `coverId` covering `absentId` on `date` (default today)? */
async function isCovering(db, coverId, absentId, date) {
  if (!coverId || !absentId || coverId === absentId) return false;
  const r = await db.query(`SELECT 1 FROM rd_absences a WHERE a.cover_user_id = $1 AND a.user_id = $2 AND ${active(3)} LIMIT 1`, [coverId, absentId, date || R.todayIST()]);
  return r.rowCount > 0;
}
/** The people (id, name) `coverId` is covering today. */
async function coveredBy(db, coverId, date) {
  const r = await db.query(`SELECT a.id AS absence_id, a.user_id, u.name, a.from_date::text AS from_date, a.to_date::text AS to_date, a.reason
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

const SHOW = `a.id, a.user_id, au.name AS user_name, a.cover_user_id, cu.name AS cover_name, a.from_date::text AS from_date, a.to_date::text AS to_date, a.reason, a.ended_at
  FROM rd_absences a JOIN users au ON au.id = a.user_id JOIN users cu ON cu.id = a.cover_user_id`;
router.use((req, res, next) => (req.access.isAdmin || can(req.access, KEYS.RD_VIEW) || can(req.access, KEYS.RD_EDIT) ? next() : fail(res, 403, 'Not allowed')));
const canManage = (req) => req.access.isAdmin || can(req.access, KEYS.RD_EDIT);

router.get('/', async (req, res) => {
  try {
    const t = R.todayIST(), me = req.user.id;
    const upcoming = 'a.ended_at IS NULL AND a.to_date >= $2';
    const [mine, covering, all] = await Promise.all([
      pool.query(`SELECT ${SHOW} WHERE a.user_id = $1 AND ${upcoming} ORDER BY a.from_date`, [me, t]),
      pool.query(`SELECT ${SHOW} WHERE a.cover_user_id = $1 AND ${upcoming} ORDER BY a.from_date`, [me, t]),
      canManage(req) ? pool.query(`SELECT ${SHOW} WHERE ${upcoming.replace('$2', '$1')} ORDER BY a.from_date, au.name LIMIT 200`, [t]) : { rows: [] }
    ]);
    const people = await pool.query(`SELECT u.id, u.name FROM users u WHERE u.active AND EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role = ANY($1)) ORDER BY u.name`, [COVER_ROLES]);
    res.json({ success: true, today: t, max_days: MAX_DAYS, can_manage: canManage(req), mine: mine.rows, covering: covering.rows, all: all.rows, people: people.rows.filter(p => p.id !== me || canManage(req)) });
  } catch (err) { console.error('rd cover list failed:', err); fail(res, 500, 'Could not load cover'); }
});

router.post('/', async (req, res) => {
  const b = req.body || {};
  const who = b.user_id == null || b.user_id === '' ? req.user.id : idOf(b.user_id);
  const cover = idOf(b.cover_user_id), from = String(b.from_date || ''), to = String(b.to_date || ''), reason = String(b.reason || '').trim().slice(0, 200) || null;
  if (!who || !cover) return fail(res, 400, 'Choose who is away and who will cover');
  if (who !== req.user.id && !canManage(req)) return fail(res, 403, 'You can only record your own absence');
  if (who === cover) return fail(res, 400, 'Someone cannot cover for themselves');
  if (!R.isValidDate(from) || !R.isValidDate(to)) return fail(res, 400, 'Give the first and last day away');
  if (to < from) return fail(res, 400, 'The last day cannot be before the first day');
  if (to < R.todayIST()) return fail(res, 400, 'The last day is already past');
  if ((Date.parse(to) - Date.parse(from)) / 86400000 + 1 > MAX_DAYS) return fail(res, 400, `Cover can last at most ${MAX_DAYS} days. Record a new one when it ends.`);
  try {
    const u = await pool.query(`SELECT u.id, u.name, u.active, EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role = ANY($2)) AS rd FROM users u WHERE u.id = ANY($1)`, [[who, cover], COVER_ROLES]);
    const away = u.rows.find(x => x.id === who), cv = u.rows.find(x => x.id === cover);
    if (!away || !away.active) return fail(res, 400, 'That person is not an active user');
    if (!cv || !cv.active) return fail(res, 400, 'The cover person is not an active user');
    if (!cv.rd) return fail(res, 400, 'The cover person must be in the R&D team (R&D, trainee, quality, manager or administrator)');
    const overlap = (id, col) => pool.query(`SELECT 1 FROM rd_absences WHERE ${col} = $1 AND ended_at IS NULL AND from_date <= $3 AND to_date >= $2 LIMIT 1`, [id, from, to]);
    if ((await overlap(who, 'user_id')).rowCount) return fail(res, 409, `${away.name} already has an absence recorded in those dates. End it first.`);
    if ((await overlap(cover, 'user_id')).rowCount) return fail(res, 409, `${cv.name} is away in those dates too, so cannot cover. Choose someone else.`);
    const ins = await pool.query('INSERT INTO rd_absences (user_id, cover_user_id, from_date, to_date, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [who, cover, from, to, reason, req.user.id]);
    await audit(pool, req, { action: 'rd.cover_set', entity: 'rd_absence', id: ins.rows[0].id, summary: `${away.name} away ${from} to ${to}, covered by ${cv.name}` });
    const when = `${R.dmy(from)} to ${R.dmy(to)}`;
    try {
      notifyUsers([cover].filter(x => x !== req.user.id), { kind: 'task_assigned', subject: `Covering for ${away.name}`, text: `${req.user.name} asked you to cover for ${away.name} from ${when}${reason ? ' (' + reason + ')' : ''}. Their open tasks will appear in My Day under "Covering for ${away.name}" while they are away. Please check what needs doing.`, path: 'my-day.html' });
      if (who !== req.user.id) notifyUsers([who], { kind: 'task_cancelled', subject: 'Your absence and cover', text: `${req.user.name} recorded your absence from ${when}. ${cv.name} will cover your tasks.`, path: 'my-day.html' });
    } catch (e) { console.error('notice failed:', e.message); }
    res.status(201).json({ success: true, id: ins.rows[0].id });
  } catch (err) { console.error('rd cover create failed:', err); fail(res, 500, 'Could not record the absence'); }
});

router.post('/:id/end', async (req, res) => {
  const id = idOf(req.params.id);
  if (!id) return fail(res, 400, 'Invalid id');
  try {
    const r = await pool.query(`SELECT ${SHOW} WHERE a.id = $1`, [id]);
    const a = r.rows[0];
    if (!a || a.ended_at) return fail(res, 404, 'Absence not found');
    if (!(canManage(req) || a.user_id === req.user.id || a.cover_user_id === req.user.id)) return fail(res, 403, 'Only the person away, the cover, or R&D management can end this');
    await pool.query('UPDATE rd_absences SET ended_at = NOW() WHERE id = $1', [id]);
    await audit(pool, req, { action: 'rd.cover_end', entity: 'rd_absence', id, summary: `Cover ended early: ${a.user_name} / ${a.cover_name}` });
    res.json({ success: true });
  } catch (err) { console.error('rd cover end failed:', err); fail(res, 500, 'Could not end the cover'); }
});

module.exports = { router, isCovering, coveredBy, coversOf };
