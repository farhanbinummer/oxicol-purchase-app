// notify.js - email + WhatsApp alerts for key events ("your request was approved" etc).
//
// Both channels are OPTIONAL and switch on by environment variables. With nothing configured,
// notify() does nothing, so the app runs exactly as before. A failed alert is only logged -
// it can never make the request that triggered it fail.
//
//   Email (any SMTP account, e.g. Gmail with an App Password):
//     SMTP_HOST, SMTP_PORT (default 587), SMTP_USER, SMTP_PASS, SMTP_FROM (optional)
//   WhatsApp (Meta WhatsApp Cloud API):
//     WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, and optionally WHATSAPP_TEMPLATE
//     (an approved template with ONE body variable; without it, plain text is sent, which
//      WhatsApp only delivers to people who messaged your number in the last 24 hours)
//   APP_URL (optional): base link put in messages, e.g. https://oxicol-purchase-app.onrender.com

const nodemailer = require('nodemailer');
const { pool } = require('./database');

// NOTIFY_TEST_MODE=1 (used only by the automated tests) records what WOULD be sent instead of sending anything.
const testMode = () => process.env.NOTIFY_TEST_MODE === '1';
const emailOn = () => testMode() || !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
const whatsappOn = () => !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID);

let transporter = null;
function mailer() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
  }
  return transporter;
}

// Adds the contact columns the first time the server starts (safe to run every time).
async function ensureSchema() {
  await pool.query(`ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email VARCHAR(150),
    ADD COLUMN IF NOT EXISTS phone VARCHAR(20)`);
  await pool.query("ALTER TABLE branch_stock_requests ADD COLUMN IF NOT EXISTS priority VARCHAR(10) NOT NULL DEFAULT 'normal'");
}

async function recipients(roles, branch) {
  // A person is a recipient when ANY role they hold is listed. When the alert is about one branch, a role that
  // is limited to branches only counts if one of those branches is the one concerned.
  const r = await pool.query(
    `SELECT u.name, u.email, u.phone FROM users u
      WHERE u.active AND (u.email IS NOT NULL OR u.phone IS NOT NULL)
        AND EXISTS (
          SELECT 1 FROM user_roles ur
           WHERE ur.user_id = u.id AND ur.role = ANY($1)
             AND ($2::text IS NULL
                  OR NOT (ur.role = 'branch' OR EXISTS (SELECT 1 FROM user_scopes s WHERE s.user_id = u.id AND s.role = ur.role AND s.scope_type = 'branch'))
                  OR EXISTS (SELECT 1 FROM user_scopes s WHERE s.user_id = u.id AND s.role = ur.role AND s.scope_type = 'branch' AND s.scope_value = $2)))`,
    [roles, branch || null]);
  return r.rows;
}

async function sendEmail(to, subject, text) {
  await mailer().sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text });
}

async function sendWhatsApp(to, text) {
  const number = String(to).replace(/[^0-9]/g, '');
  const body = process.env.WHATSAPP_TEMPLATE
    ? { messaging_product: 'whatsapp', to: number, type: 'template', template: {
        name: process.env.WHATSAPP_TEMPLATE, language: { code: 'en' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: text.slice(0, 900) }] }] } }
    : { messaging_product: 'whatsapp', to: number, type: 'text', text: { body: text } };
  const res = await fetch(`https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.WHATSAPP_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('WhatsApp API ' + res.status + ' ' + (await res.text()).slice(0, 200));
}

/**
 * notify({ roles: ['store'], branch: 'Kannur', subject, text, path: 'branch-request-detail.html?id=3' })
 * `branch` limits Branch-role recipients to that branch's logins (other roles are unaffected).
 * Returns immediately - sending happens in the background.
 */
function notify({ roles, branch, subject, text, path }) {
  if (!emailOn() && !whatsappOn()) return;
  (async () => {
    const link = process.env.APP_URL && path ? `\n${process.env.APP_URL.replace(/\/$/, '')}/${path}` : '';
    const message = `Oxicol: ${text}${link}`;
    const people = await recipients(roles, branch);
    for (const p of people) {
      if (emailOn() && p.email) {
        await sendEmail(p.email, 'Oxicol - ' + subject, `Hello ${p.name},\n\n${text}${link}\n\n- Oxicol Purchase App`)
          .catch(e => console.error('Email alert failed for', p.name + ':', e.message));
      }
      if (whatsappOn() && p.phone) {
        await sendWhatsApp(p.phone, message)
          .catch(e => console.error('WhatsApp alert failed for', p.name + ':', e.message));
      }
    }
  })().catch(e => console.error('Alert failed:', e.message));
}

// ---------------------------------------------------------------------------------------------------------------------
// Notices to named people (R&D tasks, reviews, the morning message). Each person chooses (notice_prefs, both on by default),
// and every attempt is written to notice_log, so "did they get it?" has an answer. A failure is logged and never reaches the caller.
// ---------------------------------------------------------------------------------------------------------------------
async function logNotice(u, channel, kind, subject, body, to, status, error) {
  await pool.query('INSERT INTO notice_log (user_id, channel, kind, subject, body, to_address, status, error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [u.id, channel, kind, subject, String(body).slice(0, 4000), to, status, error ? String(error).slice(0, 400) : null]).catch(e => console.error('notice log failed:', e.message));
}

/** Sends one notice to one person on every channel that is switched on and that they have an address for. Returns what happened. */
async function deliver(u, { kind, subject, text, path, which }) {
  const link = process.env.APP_URL && path ? `\n${process.env.APP_URL.replace(/\/$/, '')}/${path}` : '';
  const out = [];
  if (emailOn() && u.email) {
    const body = `Hello ${u.name},\n\n${text}${link}\n\n- Oxicol`;
    if (testMode()) { await logNotice(u, 'email', kind, subject, body, u.email, 'test'); out.push('email'); }
    else { try { await sendEmail(u.email, 'Oxicol - ' + subject, body); await logNotice(u, 'email', kind, subject, body, u.email, 'sent'); out.push('email'); } catch (e) { console.error('Email notice failed for', u.name + ':', e.message); await logNotice(u, 'email', kind, subject, body, u.email, 'failed', e.message); } }
  }
  if (whatsappOn() && u.phone && !testMode()) {
    const body = `Oxicol: ${text}${link}`;
    try { await sendWhatsApp(u.phone, body); await logNotice(u, 'whatsapp', kind, subject, body, u.phone, 'sent'); out.push('whatsapp'); } catch (e) { await logNotice(u, 'whatsapp', kind, subject, body, u.phone, 'failed', e.message); }
  }
  return out;
}

/** People (by id) who are active, have an address, and have not switched this kind of notice off. */
async function reachable(ids, which) {
  if (!ids.length) return [];
  const col = which === 'morning' ? 'morning' : 'instant';
  const r = await pool.query(
    `SELECT u.id, u.name, u.email, u.phone FROM users u LEFT JOIN notice_prefs p ON p.user_id = u.id
      WHERE u.id = ANY($1) AND u.active AND (u.email IS NOT NULL OR u.phone IS NOT NULL) AND COALESCE(p.${col}, TRUE)`, [ids]);
  return r.rows;
}

/** Tells these people about something that just happened. Returns at once; sending happens in the background and can never fail the caller. */
function notifyUsers(ids, { kind, subject, text, path }) {
  if (!emailOn() && !whatsappOn()) return;
  const unique = [...new Set(ids.filter(Boolean))];
  (async () => { for (const u of await reachable(unique, 'instant')) await deliver(u, { kind, subject, text, path }); })()
    .catch(e => console.error('Notice failed:', e.message));
}
/** The same, for everyone holding a role. */
function notifyRole(role, exceptId, msg) {
  if (!emailOn() && !whatsappOn()) return;
  pool.query('SELECT DISTINCT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id WHERE u.active AND ur.role = $1 AND u.id <> $2', [role, exceptId || 0])
    .then(r => notifyUsers(r.rows.map(x => x.id), msg)).catch(e => console.error('Notice failed:', e.message));
}

module.exports = { notify, notifyUsers, notifyRole, deliver, reachable, ensureSchema, emailOn, whatsappOn, testMode };
