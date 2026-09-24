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

const emailOn = () => !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
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
  const params = [roles];
  let sql = "SELECT name, email, phone FROM users WHERE active AND role = ANY($1) AND (email IS NOT NULL OR phone IS NOT NULL)";
  if (branch) { params.push(branch); sql += " AND (role <> 'branch' OR branch = $2)"; }
  return (await pool.query(sql, params)).rows;
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

module.exports = { notify, ensureSchema, emailOn, whatsappOn };
