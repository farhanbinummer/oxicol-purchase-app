// routes/notices.js - each person's choices about email and WhatsApp notices, and (for administrators) a record of what was sent.
//   GET /api/notices/prefs   my choices, where messages go, and whether each channel is switched on
//   PUT /api/notices/prefs   { instant, morning }
//   GET /api/notices/log     administrator: the latest 100 messages tried, newest first
const express = require('express');
const { pool } = require('../database');
const { fail } = require('../utils');
const { emailOn, whatsappOn, testMode } = require('../notify');

const router = express.Router();
const mask = (v, kind) => (!v ? null : kind === 'email' ? v.replace(/^(.).*(@.*)$/, '$1***$2') : String(v).replace(/.(?=.{3})/g, '*'));

router.get('/prefs', async (req, res) => {
  try {
    const r = await pool.query('SELECT u.email, u.phone, COALESCE(p.instant, TRUE) AS instant, COALESCE(p.morning, TRUE) AS morning FROM users u LEFT JOIN notice_prefs p ON p.user_id = u.id WHERE u.id = $1', [req.user.id]);
    const x = r.rows[0] || {};
    res.json({ success: true, instant: x.instant !== false, morning: x.morning !== false, email: mask(x.email, 'email'), phone: mask(x.phone, 'phone'),
      channels: { email: emailOn() && !testMode(), whatsapp: whatsappOn() } });
  } catch (err) { console.error(err); fail(res, 500, 'Could not load your notice settings'); }
});

router.put('/prefs', async (req, res) => {
  const b = req.body || {};
  if (typeof b.instant !== 'boolean' || typeof b.morning !== 'boolean') return fail(res, 400, 'Say yes or no for each kind of notice');
  try {
    await pool.query('INSERT INTO notice_prefs (user_id, instant, morning) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO UPDATE SET instant = EXCLUDED.instant, morning = EXCLUDED.morning', [req.user.id, b.instant, b.morning]);
    res.json({ success: true, instant: b.instant, morning: b.morning });
  } catch (err) { console.error(err); fail(res, 500, 'Could not save your notice settings'); }
});

router.get('/log', async (req, res) => {
  if (!req.access.isAdmin) return fail(res, 403, 'Only an administrator can see this');
  try {
    const r = await pool.query('SELECT l.id, l.at, l.channel, l.kind, l.subject, l.status, l.error, l.to_address, u.name FROM notice_log l LEFT JOIN users u ON u.id = l.user_id ORDER BY l.id DESC LIMIT 100');
    res.json({ success: true, log: r.rows.map(x => ({ ...x, to_address: mask(x.to_address, x.channel === 'email' ? 'email' : 'phone') })) });
  } catch (err) { console.error(err); fail(res, 500, 'Could not load the log'); }
});

module.exports = router;
