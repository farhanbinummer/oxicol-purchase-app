// routes/admin-data.js - removing data, for administrators only (mounted under /api/admin, which already requires the admin role).
//   GET  /api/admin/data/projects?q=             R&D projects (drafts too) with how much hangs under each
//   GET  /api/admin/data/projects/:id/preview    exactly what removing one project would remove
//   POST /api/admin/data/projects/delete         { ids: [...], confirm, reason }   remove up to 50 projects and everything under them
//   POST /api/admin/data/tasks/:id/delete        { reason }
//   POST /api/admin/data/trials/:id/delete       { reason }
//   POST /api/admin/data/absences/:id/delete     { reason }
//   POST /api/admin/data/notice-log/clear        { older_than_days }   sent-notice records (never the audit history)
// Removing is permanent. So: administrator only, a typed confirmation, a written reason, and an audit entry that says what was removed,
// when, by whom and why, with the counts but never confidential text. The audit history itself can never be removed here.
// Everything under a project is removed together by the database (the links are "cascade"), so nothing is left behind.
const express = require('express');
const { pool } = require('../database');
const { fail } = require('../utils');
const { audit } = require('../audit');
const router = express.Router();

const idOf = (v) => (/^\d+$/.test(String(v)) && Number(v) > 0 ? Number(v) : null);
const MAX_BULK = 50;
const reasonOf = (b) => String((b && b.reason) || '').trim();

/** What hangs under the given projects, per project. */
async function countsFor(db, ids) {
  const q = (sql) => db.query(sql, [ids]);
  const [stages, items, tasks, trials, files, notes, members, approvals] = await Promise.all([
    q("SELECT project_id, COUNT(*) FILTER (WHERE completed_at IS NOT NULL)::int AS done, COUNT(*)::int AS n FROM rd_stages WHERE project_id = ANY($1) GROUP BY project_id"),
    q('SELECT s.project_id, COUNT(*)::int AS n FROM rd_checklist_items c JOIN rd_stages s ON s.id = c.stage_id WHERE s.project_id = ANY($1) GROUP BY s.project_id'),
    q('SELECT project_id, COUNT(*)::int AS n FROM rd_tasks WHERE project_id = ANY($1) GROUP BY project_id'),
    q('SELECT project_id, COUNT(*)::int AS n FROM rd_trials WHERE project_id = ANY($1) GROUP BY project_id'),
    q('SELECT t.project_id, COUNT(*)::int AS n, COALESCE(SUM(a.size_bytes), 0)::bigint AS bytes FROM rd_trial_attachments a JOIN rd_trials t ON t.id = a.trial_id WHERE t.project_id = ANY($1) GROUP BY t.project_id'),
    q('SELECT project_id, COUNT(*)::int AS n FROM rd_updates WHERE project_id = ANY($1) GROUP BY project_id'),
    q('SELECT project_id, COUNT(*)::int AS n FROM rd_project_members WHERE project_id = ANY($1) GROUP BY project_id'),
    q('SELECT project_id, COUNT(*)::int AS n FROM rd_approvals WHERE project_id = ANY($1) GROUP BY project_id')
  ]);
  const by = (r, k = 'n') => new Map(r.rows.map(x => [x.project_id, x[k]]));
  const st = new Map(stages.rows.map(x => [x.project_id, x])), fl = new Map(files.rows.map(x => [x.project_id, x]));
  const it = by(items), tk = by(tasks), tr = by(trials), nt = by(notes), mb = by(members), ap = by(approvals);
  return new Map(ids.map(id => [id, {
    stages: (st.get(id) || {}).n || 0, stages_done: (st.get(id) || {}).done || 0, checklist_items: it.get(id) || 0, tasks: tk.get(id) || 0, trials: tr.get(id) || 0,
    files: (fl.get(id) || {}).n || 0, file_mb: +(Number((fl.get(id) || {}).bytes || 0) / 1048576).toFixed(1), notes: nt.get(id) || 0, team_members: mb.get(id) || 0, approvals: ap.get(id) || 0
  }]));
}
const summarise = (c) => [c.stages_done ? `${c.stages_done} of ${c.stages} stages done` : null, c.tasks ? `${c.tasks} tasks` : null, c.trials ? `${c.trials} lab trials` : null, c.files ? `${c.files} files` : null].filter(Boolean).join(', ') || 'nothing else under it';

router.get('/projects', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const r = await pool.query(
      `SELECT p.id, p.project_number, p.title, p.status, p.is_draft, p.requested_by_name, p.created_at::date::text AS created, p.updated_at
         FROM rd_projects p WHERE ($1 = '' OR p.project_number ILIKE '%' || $1 || '%' OR p.title ILIKE '%' || $1 || '%' OR p.requested_by_name ILIKE '%' || $1 || '%')
        ORDER BY p.id DESC LIMIT 300`, [q]);
    const counts = await countsFor(pool, r.rows.map(x => x.id));
    const total = (await pool.query('SELECT COUNT(*)::int AS n FROM rd_projects')).rows[0].n;
    res.json({ success: true, total, shown: r.rowCount, projects: r.rows.map(x => ({ ...x, counts: counts.get(x.id) })) });
  } catch (err) { console.error('admin data list failed:', err); fail(res, 500, 'Could not load the projects'); }
});

router.get('/projects/:id/preview', async (req, res) => {
  const id = idOf(req.params.id); if (!id) return fail(res, 400, 'Invalid id');
  try {
    const r = await pool.query('SELECT id, project_number, title, status, is_draft FROM rd_projects WHERE id = $1', [id]);
    if (!r.rowCount) return fail(res, 404, 'Project not found');
    res.json({ success: true, project: r.rows[0], counts: (await countsFor(pool, [id])).get(id), confirm_text: r.rows[0].project_number || 'DELETE' });
  } catch (err) { console.error(err); fail(res, 500, 'Could not load the preview'); }
});

router.post('/projects/delete', async (req, res) => {
  const b = req.body || {}, reason = reasonOf(b);
  const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(idOf).filter(Boolean))];
  if (!ids.length) return fail(res, 400, 'Choose at least one project');
  if (ids.length > MAX_BULK) return fail(res, 400, `Remove at most ${MAX_BULK} projects at a time`);
  if (reason.length < 5) return fail(res, 400, 'Write why the data is being removed (at least 5 letters)');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rows = (await client.query('SELECT id, project_number, title, status FROM rd_projects WHERE id = ANY($1) FOR UPDATE', [ids])).rows;
    if (rows.length !== ids.length) { await client.query('ROLLBACK'); return fail(res, 404, 'One of the projects no longer exists. Reload the list.'); }
    const expected = rows.length === 1 ? (rows[0].project_number || 'DELETE') : `DELETE ${rows.length} PROJECTS`;
    if (String(b.confirm || '').trim() !== expected) { await client.query('ROLLBACK'); return fail(res, 400, `To confirm, type exactly: ${expected}`); }
    const counts = await countsFor(client, ids);
    await client.query('DELETE FROM rd_projects WHERE id = ANY($1)', [ids]);          // stages, tasks, trials, files, notes and the rest go with it
    for (const p of rows) {
      const c = counts.get(p.id);
      await audit(client, req, { action: 'admin.rd_project_delete', entity: 'rd_project', id: p.id, summary: `Removed project ${p.project_number || '(draft)'} "${p.title}": ${summarise(c)}`, before: { project_number: p.project_number, title: p.title, status: p.status, counts: c }, reason });
    }
    await client.query('COMMIT');
    res.json({ success: true, removed: rows.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('admin data delete failed:', err); fail(res, 500, 'Could not remove the projects. Nothing was removed.');
  } finally { client.release(); }
});

/** One task, one trial or one absence. A task's history and notes go with it; a trial's results, corrections and files go with it. */
async function removeOne(req, res, kind) {
  const id = idOf(req.params.id), reason = reasonOf(req.body);
  if (!id) return fail(res, 400, 'Invalid id');
  if (reason.length < 5) return fail(res, 400, 'Write why the data is being removed (at least 5 letters)');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let row, summary, before;
    if (kind === 'task') {
      row = (await client.query('SELECT t.id, t.title, t.status, p.project_number FROM rd_tasks t JOIN rd_projects p ON p.id = t.project_id WHERE t.id = $1 FOR UPDATE OF t', [id])).rows[0];
      if (row) { const h = (await client.query('SELECT COUNT(*)::int AS n FROM rd_task_history WHERE task_id = $1', [id])).rows[0].n; before = { title: row.title, status: row.status, history_entries: h }; summary = `Removed task "${row.title}" from ${row.project_number}`; await client.query('DELETE FROM rd_tasks WHERE id = $1', [id]); }
    } else if (kind === 'trial') {
      row = (await client.query('SELECT t.id, t.trial_no, t.outcome, p.project_number FROM rd_trials t JOIN rd_projects p ON p.id = t.project_id WHERE t.id = $1 FOR UPDATE OF t', [id])).rows[0];
      if (row) { const f = (await client.query('SELECT COUNT(*)::int AS n FROM rd_trial_attachments WHERE trial_id = $1', [id])).rows[0].n; before = { trial_no: row.trial_no, outcome: row.outcome, files: f }; summary = `Removed lab trial T${row.trial_no} from ${row.project_number} (${f} files)`; await client.query('DELETE FROM rd_trials WHERE id = $1', [id]); }
    } else {
      row = (await client.query('SELECT a.id, a.kind, a.from_date::text AS from_date, a.to_date::text AS to_date, u.name FROM rd_absences a JOIN users u ON u.id = a.user_id WHERE a.id = $1 FOR UPDATE OF a', [id])).rows[0];
      if (row) { before = { person: row.name, kind: row.kind, from: row.from_date, to: row.to_date }; summary = `Removed the ${row.kind} record of ${row.name} (${row.from_date} to ${row.to_date})`; await client.query('DELETE FROM rd_absences WHERE id = $1', [id]); }
    }
    if (!row) { await client.query('ROLLBACK'); return fail(res, 404, 'Not found'); }
    await audit(client, req, { action: `admin.rd_${kind}_delete`, entity: kind === 'absence' ? 'rd_absence' : 'rd_' + kind, id, summary, before, reason });
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('admin data delete failed:', err); fail(res, 500, 'Could not remove it. Nothing was removed.');
  } finally { client.release(); }
}
router.post('/tasks/:id/delete', (req, res) => removeOne(req, res, 'task'));
router.post('/trials/:id/delete', (req, res) => removeOne(req, res, 'trial'));
router.post('/absences/:id/delete', (req, res) => removeOne(req, res, 'absence'));

/** The record of sent emails and WhatsApp messages: older entries can be cleared. (The audit history cannot be cleared.) */
router.post('/notice-log/clear', async (req, res) => {
  const days = Number(req.body && req.body.older_than_days);
  if (!Number.isInteger(days) || days < 7 || days > 3650) return fail(res, 400, 'Choose how old the records must be (at least 7 days)');
  try {
    const r = await pool.query("DELETE FROM notice_log WHERE at < NOW() - ($1 || ' days')::interval", [String(days)]);
    await audit(pool, req, { action: 'admin.notice_log_clear', entity: 'notice_log', summary: `Cleared ${r.rowCount} sent-notice records older than ${days} days`, reason: `older than ${days} days` });
    res.json({ success: true, removed: r.rowCount });
  } catch (err) { console.error(err); fail(res, 500, 'Could not clear the records'); }
});

module.exports = router;
