// digest.js - the morning message: what each R&D person has to do today, built from the same records as "My Day".
//
// Sent by calling POST /api/jobs/morning-digest once a day (see routes/jobs.js and docs/NOTICES.md). It is safe to call more than
// once: the day is claimed in job_runs, so nobody gets two. Nothing is sent when email and WhatsApp are not switched on, on Sundays,
// to people with no address, to people who switched the morning message off, or when there is nothing to say.
const { pool } = require('./database');
const R = require('./rd-logic');
const { emailOn, whatsappOn, reachable, deliver } = require('./notify');
const cover = require('./routes/rd-cover');

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
  const get = (uid) => { if (!people.has(uid)) people.set(uid, { overdue: [], today: [], tomorrow: [], sent_back: [], review: [], cover: [], lab: [], confirm: [], approve: [] }); return people.get(uid); };
  open.rows.forEach(r => { const d = String(r.due_date).slice(0, 10); get(r.uid)[d < today ? 'overdue' : d === today ? 'today' : 'tomorrow'].push({ ...r, due: d }); });
  back.rows.forEach(r => get(r.uid).sent_back.push(r));
  review.rows.forEach(r => get(r.uid).review.push(r));
  // lab projects they own (stage owner, else lead) whose current stage is a lab stage with no trial recorded, or none for 14 days
  const lab = await pool.query(`SELECT p.id, p.project_number, COALESCE(s.owner_user_id, p.lead_user_id) AS uid, s.stage_no,
        (SELECT COUNT(*)::int FROM rd_trials t WHERE t.project_id = p.id) AS n, (SELECT MAX(t.trial_date)::text FROM rd_trials t WHERE t.project_id = p.id) AS last
      FROM rd_projects p JOIN rd_stages s ON s.project_id = p.id AND s.stage_no = (SELECT MIN(x.stage_no) FROM rd_stages x WHERE x.project_id = p.id AND x.completed_at IS NULL)
     WHERE p.is_draft = FALSE AND p.status = ANY($1) AND s.stage_no = ANY($2) AND COALESCE(s.owner_user_id, p.lead_user_id) IS NOT NULL`, [R.ACTIVE_STATUSES, R.TRIAL_STAGES]);
  lab.rows.forEach(r => { const since = r.last ? R.daysBetween(r.last.slice(0, 10), today) : null; if (!r.n || since > 14) get(r.uid).lab.push({ ...r, since }); });
  // cover requests still waiting for the person's answer
  const pend = await pool.query(`SELECT a.cover_user_id AS uid, u.name, a.from_date::text AS from_date, a.to_date::text AS to_date FROM rd_absences a JOIN users u ON u.id = a.user_id WHERE a.cover_status = 'pending' AND a.ended_at IS NULL AND a.to_date >= $1 ORDER BY a.from_date`, [today]);
  pend.rows.forEach(r => get(r.uid).confirm.push(r));
  // absences waiting for approval go to everyone who may approve them (not the person away)
  const wait = await pool.query(`SELECT a.user_id, u.name, a.from_date::text AS from_date, a.to_date::text AS to_date, cu.name AS cover_name, a.cover_status FROM rd_absences a JOIN users u ON u.id = a.user_id JOIN users cu ON cu.id = a.cover_user_id WHERE a.approval_status = 'pending' AND a.ended_at IS NULL AND a.cover_status <> 'declined' AND a.to_date >= $1 ORDER BY a.from_date`, [today]);
  if (wait.rowCount) for (const uid of await cover.approverIds(pool)) wait.rows.filter(r => r.user_id !== uid).forEach(r => get(uid).approve.push(r));
  // people who are away today: what is due on their tasks also goes to whoever covers for them
  const away = await pool.query(`SELECT a.user_id, a.cover_user_id, u.name FROM rd_absences a JOIN users u ON u.id = a.user_id WHERE a.ended_at IS NULL AND a.from_date <= $1 AND a.to_date >= $1 AND a.approval_status = 'approved' AND a.cover_status = 'accepted'`, [today]);
  for (const a of away.rows) {
    const theirs = people.get(a.user_id); if (!theirs) continue;
    const mine = get(a.cover_user_id);
    ['sent_back', 'overdue', 'today', 'tomorrow'].forEach(k => theirs[k].forEach(x => mine.cover.push({ ...x, for_name: a.name, kind: k })));
  }
  return people;
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const dmy = (d) => R.dmy(String(d).slice(0, 10));
const lines = (list, fmt) => list.slice(0, MAX_LINES).map(x => '  - ' + fmt(x)).join('\n') + (list.length > MAX_LINES ? `\n  ...and ${list.length - MAX_LINES} more` : '');

/** The message for one person, or null when there is nothing to say. */
function compose(name, d, today) {
  d.cover = d.cover || []; d.lab = d.lab || []; d.confirm = d.confirm || []; d.approve = d.approve || [];
  const n = d.overdue.length + d.today.length + d.tomorrow.length + d.sent_back.length + d.review.length + d.cover.length + d.lab.length + d.confirm.length + d.approve.length;
  if (!n) return null;
  const bits = [];
  if (d.sent_back.length) bits.push(plural(d.sent_back.length, 'piece') + ' of work sent back');
  if (d.review.length) bits.push(plural(d.review.length, 'piece') + ' of work waiting for your review');
  if (d.overdue.length) bits.push(plural(d.overdue.length, 'task') + ' overdue');
  if (d.today.length) bits.push(plural(d.today.length, 'task') + ' due today');
  if (d.tomorrow.length) bits.push(plural(d.tomorrow.length, 'task') + ' due tomorrow');
  if (d.cover.length) bits.push(plural(d.cover.length, 'task') + ' to cover for ' + [...new Set(d.cover.map(x => x.for_name))].join(' and '));
  if (d.approve.length) bits.unshift(plural(d.approve.length, 'absence') + ' waiting for your approval');
  if (d.confirm.length) bits.unshift(plural(d.confirm.length, 'request') + ' to confirm that you can cover');
  if (d.lab.length) bits.push(plural(d.lab.length, 'lab project') + ' needing a trial');
  const sections = [];
  if (d.sent_back.length) sections.push('Sent back to you:\n' + lines(d.sent_back, x => `${x.title} (${x.project_number}): ${x.review_note}`));
  if (d.review.length) sections.push('Waiting for your review:\n' + lines(d.review, x => `${x.title} (${x.project_number})`));
  if (d.overdue.length) sections.push('Overdue:\n' + lines(d.overdue, x => `${x.title} (${x.project_number}), was due ${dmy(x.due)}`));
  if (d.today.length) sections.push('Due today:\n' + lines(d.today, x => `${x.title} (${x.project_number})`));
  if (d.tomorrow.length) sections.push('Due tomorrow:\n' + lines(d.tomorrow, x => `${x.title} (${x.project_number})`));
  if (d.cover.length) sections.push('Covering for a colleague who is away:\n' + lines(d.cover, x => `${x.title} (${x.project_number}) for ${x.for_name}${x.kind === 'overdue' ? ', was due ' + dmy(x.due) : x.kind === 'today' ? ', due today' : x.kind === 'tomorrow' ? ', due tomorrow' : ', sent back'}`));
  if (d.approve.length) sections.push('Absences waiting for your approval (open Away and cover):\n' + lines(d.approve, x => `${x.name}: ${dmy(x.from_date)} to ${dmy(x.to_date)}, cover ${x.cover_name} (${x.cover_status === 'accepted' ? 'confirmed' : 'not confirmed yet'})`));
  if (d.confirm.length) sections.push('Please confirm you can cover (open Away and cover):\n' + lines(d.confirm, x => `${x.name}: ${dmy(x.from_date)} to ${dmy(x.to_date)}`));
  if (d.lab.length) sections.push('Lab trials to record:\n' + lines(d.lab, x => `${x.project_number}: ${x.n ? 'last trial ' + plural(x.since, 'day') + ' ago' : 'no trial recorded yet'} (stage ${x.stage_no})`));
  const subject = `Your day: ${bits.slice(0, 2).join(', ')}`;
  const text = `Today is ${dmy(today)}. Here is what is on your plate: ${bits.join(', ')}.\n\n${sections.join('\n\n')}`;
  return { subject, text };
}

/** Sends (or, with dryRun, only prepares) today's message to everyone who should get one. */
// The morning message is only sent between 06:00 and 11:00 India time. GitHub's free timer can start a job hours late; a late call is
// skipped (and does not use up the day) rather than sending "good morning" in the afternoon.
const MORNING_FROM = 6, MORNING_UNTIL = 11;
const istHour = (nowMs) => new Date((nowMs == null ? Date.now() : nowMs) + 330 * 60000).getUTCHours();
const inMorningWindow = (nowMs) => { const h = istHour(nowMs); return h >= MORNING_FROM && h < MORNING_UNTIL; };

async function morningDigest({ dryRun, force, nowMs } = {}) {
  const today = R.todayIST(nowMs);
  if (new Date(today + 'T00:00:00Z').getUTCDay() === 0 && !force) return { skipped: 'It is Sunday: no morning message is sent.' };
  if (!force && !dryRun && !inMorningWindow(nowMs)) return { skipped: `It is outside the morning window (${MORNING_FROM}:00 to ${MORNING_UNTIL}:00 India time), so nothing was sent today.` };
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

module.exports = { morningDigest, compose, gather, inMorningWindow };
