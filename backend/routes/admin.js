// routes/admin.js - administrator-only pages: audit history and system/integration status.
//   GET /api/admin/audit?entity=&q=&page=&per=     who did what, newest first
//   GET /api/admin/system                          database, alert channels, accounting integration state
// Both are hardcoded to admin on purpose (like user management), not editable in the permissions matrix.
// Nothing here ever returns a secret: only whether a setting is present.

const express = require('express');
const { pool, testConnection } = require('../database');
const { fail } = require('../utils');
const { emailOn, whatsappOn } = require('../notify');
const router = express.Router();

router.get('/audit', async (req, res) => {
  try {
    const per = Math.min(Math.max(Number(req.query.per) || 25, 5), 100);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const clauses = [], params = [];
    if (req.query.entity) { params.push(String(req.query.entity)); clauses.push(`entity = $${params.length}`); }
    if (req.query.q) { params.push('%' + String(req.query.q).trim() + '%'); clauses.push(`(summary ILIKE $${params.length} OR actor_name ILIKE $${params.length} OR action ILIKE $${params.length})`); }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    const total = await pool.query(`SELECT COUNT(*)::int AS n FROM audit_log ${where}`, params);
    const rows = await pool.query(
      `SELECT id, at, actor_name, actor_role, action, entity, entity_id, summary, before_data, after_data, reason
         FROM audit_log ${where} ORDER BY at DESC, id DESC LIMIT ${per} OFFSET ${(page - 1) * per}`, params);
    const entities = await pool.query('SELECT DISTINCT entity FROM audit_log ORDER BY entity');
    res.json({ success: true, total: total.rows[0].n, page, per, entries: rows.rows, entities: entities.rows.map(r => r.entity) });
  } catch (err) { console.error(err); fail(res, 500, 'Could not load audit history'); }
});

router.get('/system', async (req, res) => {
  const out = { success: true, checked_at: new Date().toISOString() };
  const t0 = Date.now();
  try { await testConnection(); out.database = { ok: true, latency_ms: Date.now() - t0 }; }
  catch (err) { out.database = { ok: false, error: err.message || String(err.code || 'unreachable') }; }
  out.alerts = {
    email: emailOn() ? 'configured' : 'not configured',
    whatsapp: whatsappOn() ? 'configured' : 'not configured',
    setup: 'Email needs SMTP_HOST, SMTP_USER and SMTP_PASS. WhatsApp needs WHATSAPP_TOKEN and WHATSAPP_PHONE_ID. Set them in the hosting environment, never in code.'
  };
  out.accounting = {
    system: 'Tally',
    state: 'test_mode',
    label: 'Test mode',
    detail: 'The Tally action only writes a local log. Nothing is sent to Tally, so exported entries are not accounting records.',
    setup: 'A real connection needs a reachable TallyPrime server (address and company name) and agreed ledger mappings.'
  };
  try {
    const m = await pool.query('SELECT name, applied_at FROM app_migrations ORDER BY applied_at, name');
    out.migrations = m.rows;
  } catch (err) { out.migrations = []; }
  res.json(out);
});

module.exports = router;
