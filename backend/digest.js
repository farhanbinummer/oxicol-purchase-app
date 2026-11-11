// digest.js - the morning message: what each R&D person has to do today, built from the same records as "My Day".
//
// Sent by calling POST /api/jobs/morning-digest once a day (see routes/jobs.js and docs/NOTICES.md). It is safe to call more than
// once: the day is claimed in job_runs, so nobody gets two. Nothing is sent when email and WhatsApp are not switched on, on Sundays,
// to people with no address, to people who switched the morning message off, or when there is nothing to say.
const { pool } = require('./database');
const R = require('./rd-logic');
const { emailOn, whatsappOn, reachable, deliver } = require('./notify');

const MAX_LINES = 5;
const LIVE = "p.is_draft = FALSE AND p.status NOT IN ('Completed', 'Rejected')";

/** Everything worth saying to each person today, keyed by user id. */
async function gather(today) {
  const tomorrow = R.addDays(today, 1);
  const [open, back, review] = await Promise.all([
    pool.query(
      `SELECT t.assignee_id AS uid, t.id, t.title, t.due_date, p.project_number FROM rd_tasks t JOIN rd_projects p ON p.id = t.project_id
        WHERE t.assignee_id IS NOT NULL AND t.status IN ('todo', 'in_progress', 'blocked') AND ${LIVE} AND t.due_date IS NOT NULL AND t.due_date <= $1 ORDER BY t.due_date, t.id`, [tomorrow]),
    pool.query(
      `SELECT t.assignee_id AS uid, t.id, t.title, t.review_note, p.project_number FROM rd_tasks t JOIN rd_projects p ON p.id = t.project_id
        WHERE t.assignee_id IS NOT NULL AND t.status = 'in_progress' AND t.review_note IS NOT NULL AND ${LIVE} ORDER BY t.id`),
    pool.query(
      `SELECT x.uid, x.id, x.title, x.project_number FROM (
          SELECT t.created_by AS uid, t.id, t.title, p.project_number, t.assignee_id FROM rd_tasks t JOIN rd_projects p ON p.id = t.project_id
           WHERE t.status = 'in_review' AND t.created_by IS NOT NULL AND ${LIVE}
          UNION
          SELECT COALESCE(rs.owner_user_id, p.lead_user_id), t.id, t.title, p.project_number, t.assignee_id FROM rd_tasks t JOIN rd_projects p ON p.id = t.project_id
            JOIN rd_stages rs ON rs.project_id = t.project_id AND rs.stage_no = t.stage_no
           WHERE t.status = 'in_review' AND t.stage_no IS NOT NULL AND ${LIVE}) x
        WHERE x.uid IS NOT NULL AND x.uid IS DISTINCT FROM x.assignee_id ORDER BY x.id`)
  ]);
  const people = new Map();
  const get = (uid) => { if (!people.has(uid)) people.set(uid, { overdue: [], today: [], tomorrow: [], sent_back: [], review: [] }); return people.get(uid); };
  open.rows.forEach(r => { const d = String(r.due_date).slice(0, 10); get(r.uid)[d < today ? 'overdue' : d === today ? 'today' : 'tomorrow'].push({ ...r, due: d }); });
  back.rows.forEach(r => get(r.uid).sent_back.push(r));
  review.rows.forEach(r => get(r.uid).review.push(r));
  return people;
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const dmy = (d) => R.dmy(String(d).slice(0, 10));
const lines = (list, fmt) => list.slice(0, MAX_LINES).map(x => '  - ' + fmt(x)).join('\n') + (list.length > MAX_LINES ? `\n  ...and ${list.length - MAX_LINES} more` : '');

/** The message for one person, or null when there is nothing to say. */
function compose(name, d, today) {
  const n = d.overdue.length + d.today.length + d.tomorrow.length + d.sent_back.length + d.review.length;
  if (!n) return null;
  const bits = [];
  if (d.sent_back.length) bits.push(plural(d.sent_back.length, 'piece') + ' of work sent back');
  if (d.review.length) bits.push(plural(d.review.length, 'piece') + ' of work waiting for your review');
  if (d.overdue.length) bits.push(plural(d.overdue.length, 'task') + ' overdue');
  if (d.today.length) bits.push(plural(d.today.length, 'task') + ' due today');
  if (d.tomorrow.length) bits.push(plural(d.tomorrow.length, 'task') + ' due tomorrow');
  const sections = [];
  if (d.sent_back.length) sections.push('Sent back to you:\n' + lines(d.sent_back, x => `${x.title} (${x.project_number}): ${x.review_note}`));
  if (d.review.length) sections.push('Waiting for your review:\n' + lines(d.review, x => `${x.title} (${x.project_number})`));
  if (d.overdue.length) sections.push('Overdue:\n' + lines(d.overdue, x => `${x.title} (${x.project_number}), was due ${dmy(x.due)}`));
  if (d.today.length) sections.push('Due today:\n' + lines(d.today, x => `${x.title} (${x.project_number})`));
  if (d.tomorrow.length) sections.push('Due tomorrow:\n' + lines(d.tomorrow, x => `${x.title} (${x.project_number})`));
  const subject = `Your day: ${bits.slice(0, 2).join(', ')}`;
  const text = `Good morning ${String(name).split(' ')[0]}. Today is ${dmy(today)}. You have ${bits.join(', ')}.\n\n${sections.join('\n\n')}`;
  return { subject, text };
}

/** Sends (or, with dryRun, only prepares) today's message to everyone who should get one. */
async function morningDigest({ dryRun, force } = {}) {
  const today = R.todayIST();
  if (new Date(today + 'T00:00:00Z').getUTCDay() === 0 && !force) return { skipped: 'It is Sunday: no morning message is sent.' };
  if (!emailOn() && !whatsappOn()) return { skipped: 'Email and WhatsApp are not switched on, so nothing can be sent.' };
  if (!dryRun) {
    const claim = await pool.query(
      `INSERT INTO job_runs (name, last_run) VALUES ('morning-digest', $1) ON CONFLICT (name) DO UPDATE SET last_run = EXCLUDED.last_run WHERE job_runs.last_run < EXCLUDED.last_run RETURNING 1`, [today]);
    if (!claim.rowCount) return { skipped: 'Today\'s morning message was already sent.' };
  }
  const data = await gather(today), who = await reachable([...data.keys()], 'morning');
  const out = { date: today, dry_run: !!dryRun, people_with_work: data.size, reachable: who.length, sent: 0, would_send: [] };
  for (const u of who) {
    const m = compose(u.name, data.get(u.id), today); if (!m) continue;
    if (dryRun) { out.would_send.push({ user_id: u.id, name: u.name, subject: m.subject, text: m.text }); continue; }
    const channels = await deliver(u, { kind: 'morning', subject: m.subject, text: m.text, path: 'my-day.html' });
    if (channels.length) out.sent += 1;
  }
  return out;
}

module.exports = { morningDigest, compose, gather };
