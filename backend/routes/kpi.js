// routes/kpi.js - team performance numbers, worked out from records the app already keeps (no extra data entry).
//   GET  /api/kpi/rd                 every R&D person's numbers for a period      (permission kpi.view_all)
//   GET  /api/kpi/rd/me              the signed-in person's own numbers           (anyone who may view R&D)
//   GET  /api/kpi/rd/person/:id      one person: their tasks and a six-month trend (kpi.view_all, or yourself)
//   GET  /api/kpi/rd/export          the same table as a spreadsheet file (CSV)   (kpi.view_all)
//   GET  /api/kpi/targets            the thresholds for green / amber / red
//   PUT  /api/kpi/targets            change them                                  (administrator)
//
// What is measured (and what is not):
//   - Only work recorded in the app, by the person themselves. A task someone else closed for them is not counted as theirs.
//   - Percentages always come with the counts behind them, and a "few items" flag when there are too few to mean much.
//   - There is deliberately NO single score and NO ranking: the people are listed alphabetically.
const express = require('express');
const { pool } = require('../database');
const { fail } = require('../utils');
const { audit } = require('../audit');
const { KEYS } = require('../permissions');
const { can } = require('../access');
const R = require('../rd-logic');

const router = express.Router();
const IST = "'Asia/Kolkata'";
const DEFAULT_TARGETS = { green_min: 90, amber_min: 70, overdue_amber_max: 2 };
const FEW = { on_time: 5, first_time_right: 5, stage_on_time: 3 };       // fewer items than this: the percentage is shown with a warning
const OPEN = ['todo', 'in_progress', 'blocked', 'in_review'];
const WORKING = ['todo', 'in_progress', 'blocked'];

const needAll = (req, res) => { if (can(req.access, KEYS.KPI_VIEW_ALL)) return true; fail(res, 403, 'Only people allowed to see team performance can do that'); return false; };
const rate = (n, d) => (d > 0 ? Math.round(n / d * 1000) / 10 : null);
const round1 = (v) => (v == null ? null : Math.round(Number(v) * 10) / 10);

async function loadTargets(db) {
  const r = await (db || pool).query('SELECT green_min, amber_min, overdue_amber_max FROM kpi_targets WHERE id = 1');
  const t = r.rows[0] || DEFAULT_TARGETS;
  return { green_min: Number(t.green_min), amber_min: Number(t.amber_min), overdue_amber_max: Number(t.overdue_amber_max) };
}
/** 'green' / 'amber' / 'red' for a percentage, or null when there is nothing to measure. */
const band = (pct, t) => (pct == null ? null : pct >= t.green_min ? 'green' : pct >= t.amber_min ? 'amber' : 'red');
const overdueBand = (n, t) => (n === 0 ? 'green' : n <= t.overdue_amber_max ? 'amber' : 'red');

/** The period from the query string: valid dates, from before to, at most a year. Default: the last 30 days. */
function readPeriod(req) {
  const to = req.query.to || R.todayIST();
  const from = req.query.from || R.addDays(to, -29);
  if (!R.isValidDate(from) || !R.isValidDate(to)) return { error: 'Dates must be real dates (YYYY-MM-DD)' };
  if (from > to) return { error: 'The start date is after the end date' };
  if (R.daysBetween(from, to) > 366) return { error: 'Choose a period of at most one year' };
  return { from, to };
}

/** All the raw counts for the period, one row per person, from the live records. */
async function collect(from, to) {
  const today = R.todayIST();
  const cd = `(t.completed_at AT TIME ZONE ${IST})::date`;
  const [done, open, review, reviewer, stages, users] = await Promise.all([
    pool.query(
      `SELECT t.assignee_id AS uid, COUNT(*)::int AS completed, COUNT(*) FILTER (WHERE t.due_date IS NOT NULL)::int AS with_due,
              COUNT(*) FILTER (WHERE t.due_date IS NOT NULL AND ${cd} <= t.due_date)::int AS on_time,
              AVG(${cd} - t.due_date) FILTER (WHERE t.due_date IS NOT NULL AND ${cd} > t.due_date) AS avg_late
         FROM rd_tasks t WHERE t.status = 'done' AND t.assignee_id IS NOT NULL AND t.completed_by = t.assignee_id AND ${cd} BETWEEN $1 AND $2 GROUP BY 1`, [from, to]),
    pool.query(
      `SELECT t.assignee_id AS uid, COUNT(*) FILTER (WHERE t.status = ANY($1))::int AS open_now,
              COUNT(*) FILTER (WHERE t.status = ANY($2) AND t.due_date < $3)::int AS overdue_now
         FROM rd_tasks t JOIN rd_projects p ON p.id = t.project_id
        WHERE t.assignee_id IS NOT NULL AND p.is_draft = FALSE AND p.status NOT IN ('Completed', 'Rejected') GROUP BY 1`, [OPEN, WORKING, today]),
    pool.query(
      `SELECT t.assignee_id AS uid, COUNT(DISTINCT t.id)::int AS accepted,
              COUNT(DISTINCT t.id) FILTER (WHERE NOT EXISTS (SELECT 1 FROM rd_task_history s WHERE s.task_id = t.id AND s.action = 'sent_back'))::int AS first_time
         FROM rd_tasks t JOIN rd_task_history a ON a.task_id = t.id AND a.action = 'accepted'
        WHERE t.assignee_id IS NOT NULL AND (a.at AT TIME ZONE ${IST})::date BETWEEN $1 AND $2 GROUP BY 1`, [from, to]),
    pool.query(
      `SELECT a.actor_id AS uid, COUNT(*)::int AS reviews, AVG(EXTRACT(EPOCH FROM (a.at - s.at)) / 86400.0) AS avg_days
         FROM rd_task_history a
         JOIN LATERAL (SELECT x.at FROM rd_task_history x WHERE x.task_id = a.task_id AND x.action = 'submitted' AND x.at < a.at ORDER BY x.at DESC LIMIT 1) s ON TRUE
        WHERE a.action IN ('accepted', 'sent_back') AND a.actor_id IS NOT NULL AND (a.at AT TIME ZONE ${IST})::date BETWEEN $1 AND $2 GROUP BY 1`, [from, to]),
    pool.query(
      `SELECT COALESCE(s.owner_user_id, p.lead_user_id) AS uid, COUNT(*)::int AS done, COUNT(*) FILTER (WHERE s.planned_date IS NOT NULL)::int AS with_plan,
              COUNT(*) FILTER (WHERE s.planned_date IS NOT NULL AND s.actual_date <= s.planned_date)::int AS on_time,
              AVG(s.actual_date - s.planned_date) FILTER (WHERE s.planned_date IS NOT NULL AND s.actual_date > s.planned_date) AS avg_delay
         FROM rd_stages s JOIN rd_projects p ON p.id = s.project_id
        WHERE s.completed_at IS NOT NULL AND p.is_draft = FALSE AND s.actual_date BETWEEN $1 AND $2 AND COALESCE(s.owner_user_id, p.lead_user_id) IS NOT NULL GROUP BY 1`, [from, to]),
    pool.query(`SELECT u.id, u.name, u.username, array_agg(DISTINCT ur.role) AS roles FROM users u JOIN user_roles ur ON ur.user_id = u.id WHERE u.active GROUP BY u.id, u.name, u.username`)
  ]);
  const by = (rows) => new Map(rows.rows.map(r => [r.uid, r]));
  return { done: by(done), open: by(open), review: by(review), reviewer: by(reviewer), stages: by(stages), users: users.rows };
}

/** One person's numbers, with their bands and "few items" flags. */
function personRow(u, c, targets) {
  const d = c.done.get(u.id) || {}, o = c.open.get(u.id) || {}, a = c.review.get(u.id) || {}, rv = c.reviewer.get(u.id) || {}, s = c.stages.get(u.id) || {};
  const tasks = { completed: d.completed || 0, with_due: d.with_due || 0, on_time: d.on_time || 0, on_time_rate: rate(d.on_time || 0, d.with_due || 0), avg_days_late: round1(d.avg_late),
    open_now: o.open_now || 0, overdue_now: o.overdue_now || 0 };
  const review = { accepted: a.accepted || 0, first_time: a.first_time || 0, first_time_rate: rate(a.first_time || 0, a.accepted || 0), reviews_done: rv.reviews || 0, avg_review_days: round1(rv.avg_days) };
  const stg = { done: s.done || 0, with_plan: s.with_plan || 0, on_time: s.on_time || 0, on_time_rate: rate(s.on_time || 0, s.with_plan || 0), avg_delay_days: round1(s.avg_delay) };
  return {
    id: u.id, name: u.name, username: u.username, roles: u.roles, tasks, review, stages: stg,
    bands: { on_time: band(tasks.on_time_rate, targets), first_time_right: band(review.first_time_rate, targets), stage_on_time: band(stg.on_time_rate, targets), overdue: o.open_now ? overdueBand(tasks.overdue_now, targets) : null },
    few: { on_time: tasks.with_due > 0 && tasks.with_due < FEW.on_time, first_time_right: review.accepted > 0 && review.accepted < FEW.first_time_right, stage_on_time: stg.with_plan > 0 && stg.with_plan < FEW.stage_on_time },
    has_activity: !!(d.completed || o.open_now || a.accepted || rv.reviews || s.done)
  };
}

/** Everyone who works in R&D (an R&D role) or has R&D activity in the period, listed alphabetically. */
async function allPeople(from, to) {
  const [c, targets] = await Promise.all([collect(from, to), loadTargets()]);
  const rows = c.users.map(u => personRow(u, c, targets)).filter(p => p.roles.some(r => ['rd', 'rd_trainee'].includes(r)) || p.has_activity);
  rows.sort((x, y) => x.name.localeCompare(y.name));
  return { people: rows, targets, c };
}

router.get('/targets', async (req, res) => {
  try { res.json({ success: true, targets: await loadTargets(), defaults: DEFAULT_TARGETS }); } catch (err) { console.error(err); fail(res, 500, 'Could not load the targets'); }
});

router.put('/targets', async (req, res) => {
  if (!req.access.isAdmin) return fail(res, 403, 'Only an administrator can change the targets');
  const b = req.body || {};
  const g = Number(b.green_min), a = Number(b.amber_min), m = Number(b.overdue_amber_max);
  if (!Number.isFinite(g) || !Number.isFinite(a) || g > 100 || a < 0 || a >= g) return fail(res, 400, 'The green threshold must be above the amber one, between 0 and 100');
  if (!Number.isInteger(m) || m < 0 || m > 50) return fail(res, 400, 'The amber limit for overdue tasks must be a whole number from 0 to 50');
  try {
    const before = await loadTargets();
    await pool.query('UPDATE kpi_targets SET green_min = $1, amber_min = $2, overdue_amber_max = $3, updated_by = $4, updated_at = NOW() WHERE id = 1', [g, a, m, req.user.id]);
    await audit(pool, req, { action: 'kpi.targets', entity: 'kpi_targets', id: 1, summary: `Performance targets changed: green from ${g}%, amber from ${a}%, overdue amber up to ${m}`, before, after: { green_min: g, amber_min: a, overdue_amber_max: m } });
    res.json({ success: true, targets: await loadTargets() });
  } catch (err) { console.error(err); fail(res, 500, 'Could not save the targets'); }
});

router.get('/rd', async (req, res) => {
  if (!needAll(req, res)) return;
  const p = readPeriod(req); if (p.error) return fail(res, 400, p.error);
  try {
    const { people, targets } = await allPeople(p.from, p.to);
    res.json({ success: true, period: { from: p.from, to: p.to, today: R.todayIST() }, targets, few: FEW, people });
  } catch (err) { console.error('kpi list failed:', err); fail(res, 500, 'Could not work out the numbers'); }
});

router.get('/rd/me', async (req, res) => {
  if (!can(req.access, KEYS.RD_VIEW)) return fail(res, 403, 'You do not have access to R&D');
  const p = readPeriod(req); if (p.error) return fail(res, 400, p.error);
  try {
    const [c, targets] = await Promise.all([collect(p.from, p.to), loadTargets()]);
    const u = c.users.find(x => x.id === req.user.id);
    if (!u) return fail(res, 404, 'Your account was not found');
    res.json({ success: true, period: { from: p.from, to: p.to, today: R.todayIST() }, targets, few: FEW, person: personRow(u, c, targets) });
  } catch (err) { console.error('kpi me failed:', err); fail(res, 500, 'Could not work out your numbers'); }
});

router.get('/rd/person/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid person');
  if (id !== req.user.id && !needAll(req, res)) return;
  if (id === req.user.id && !can(req.access, KEYS.RD_VIEW) && !can(req.access, KEYS.KPI_VIEW_ALL)) return fail(res, 403, 'You do not have access to R&D');
  const p = readPeriod(req); if (p.error) return fail(res, 400, p.error);
  try {
    const [c, targets] = await Promise.all([collect(p.from, p.to), loadTargets()]);
    const u = c.users.find(x => x.id === id);
    if (!u) return fail(res, 404, 'Person not found');
    const cd = `(t.completed_at AT TIME ZONE ${IST})::date`;
    const tasks = await pool.query(
      `SELECT t.id, t.title, t.status, t.due_date, t.completed_at, t.completed_by, t.project_id, p.project_number, ${cd} AS done_on,
              CASE WHEN t.status = 'done' AND t.due_date IS NOT NULL THEN (${cd} - t.due_date) END AS days_late,
              (SELECT COUNT(*)::int FROM rd_task_history h WHERE h.task_id = t.id AND h.action = 'sent_back') AS sent_back
         FROM rd_tasks t JOIN rd_projects p ON p.id = t.project_id
        WHERE t.assignee_id = $1 AND p.is_draft = FALSE
          AND ((t.status = 'done' AND t.completed_by = t.assignee_id AND ${cd} BETWEEN $2 AND $3) OR t.status = ANY($4))
        ORDER BY (t.status = 'done'), t.due_date NULLS LAST, t.id LIMIT 100`, [id, p.from, p.to, OPEN]);
    // six months ending at the end of the period, so a trend is visible without opening anything else
    const trendRows = await pool.query(
      `SELECT to_char(date_trunc('month', x.cd), 'YYYY-MM') AS m, COUNT(*)::int AS completed, COUNT(*) FILTER (WHERE x.due_date IS NOT NULL)::int AS with_due,
              COUNT(*) FILTER (WHERE x.due_date IS NOT NULL AND x.cd <= x.due_date)::int AS on_time
         FROM (SELECT t.due_date, ${cd} AS cd FROM rd_tasks t WHERE t.assignee_id = $1 AND t.status = 'done' AND t.completed_by = t.assignee_id) x
        WHERE x.cd >= (date_trunc('month', $2::date) - INTERVAL '5 months')::date AND x.cd <= $2::date GROUP BY 1`, [id, p.to]);
    const got = new Map(trendRows.rows.map(r => [r.m, r]));
    const trend = []; const end = new Date(p.to + 'T00:00:00Z');
    for (let i = 5; i >= 0; i--) {
      const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1)); const key = d.toISOString().slice(0, 7); const r = got.get(key) || { completed: 0, with_due: 0, on_time: 0 };
      trend.push({ month: key, completed: r.completed, with_due: r.with_due, on_time: r.on_time, on_time_rate: rate(r.on_time, r.with_due) });
    }
    res.json({ success: true, period: { from: p.from, to: p.to, today: R.todayIST() }, targets, few: FEW, person: personRow(u, c, targets), tasks: tasks.rows, trend });
  } catch (err) { console.error('kpi person failed:', err); fail(res, 500, 'Could not work out the numbers'); }
});

const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
router.get('/rd/export', async (req, res) => {
  if (!needAll(req, res)) return;
  const p = readPeriod(req); if (p.error) return fail(res, 400, p.error);
  try {
    const { people } = await allPeople(p.from, p.to);
    const head = ['Person', 'Username', 'Roles', 'Period from', 'Period to', 'Tasks completed', 'Completed with a due date', 'Completed on time', 'On-time rate %', 'Average days late', 'Open tasks now', 'Overdue now',
      'Work accepted', 'Accepted first time', 'First-time-right %', 'Reviews done', 'Average review days', 'Stages completed', 'Stages with a plan', 'Stages on time', 'Stages on-time %', 'Average stage delay days'];
    const lines = [head.map(csvCell).join(',')];
    people.forEach(x => lines.push([x.name, x.username, x.roles.join(' / '), p.from, p.to, x.tasks.completed, x.tasks.with_due, x.tasks.on_time, x.tasks.on_time_rate, x.tasks.avg_days_late, x.tasks.open_now, x.tasks.overdue_now,
      x.review.accepted, x.review.first_time, x.review.first_time_rate, x.review.reviews_done, x.review.avg_review_days, x.stages.done, x.stages.with_plan, x.stages.on_time, x.stages.on_time_rate, x.stages.avg_delay_days].map(csvCell).join(',')));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="rd-team-performance-${p.from}-to-${p.to}.csv"`);
    res.send('﻿' + lines.join('\r\n') + '\r\n');
  } catch (err) { console.error('kpi export failed:', err); fail(res, 500, 'Could not export the numbers'); }
});

/** A short summary for the administrator's and manager's home page: the team's overall numbers and who is below target (alphabetical, never ranked). */
router.teamSummary = async function teamSummary(days) {
  const n = days || 30, to = R.todayIST(), from = R.addDays(to, -(n - 1));
  const { people, targets } = await allPeople(from, to);
  const active = people.filter(p => p.has_activity);
  const sum = (f) => active.reduce((a, p) => a + f(p), 0);
  const withDue = sum(p => p.tasks.with_due), onTime = sum(p => p.tasks.on_time);
  const below = [];
  active.forEach(p => {
    const why = [];
    if (p.bands.on_time === 'red') why.push(`on time ${p.tasks.on_time_rate}%${p.few.on_time ? ' (few items)' : ''}`);
    if (p.bands.first_time_right === 'red') why.push(`right first time ${p.review.first_time_rate}%${p.few.first_time_right ? ' (few items)' : ''}`);
    if (p.bands.stage_on_time === 'red') why.push(`stages on time ${p.stages.on_time_rate}%${p.few.stage_on_time ? ' (few items)' : ''}`);
    if (p.bands.overdue === 'red') why.push(`${p.tasks.overdue_now} overdue tasks`);
    if (why.length) below.push({ id: p.id, name: p.name, why });
  });
  return { period: { from, to, days: n }, people: active.length, completed: sum(p => p.tasks.completed), on_time_rate: rate(onTime, withDue), with_due: withDue, overdue_now: sum(p => p.tasks.overdue_now), below_target: below, targets };
};

module.exports = router;
