// routes/suppliers.js - suppliers: the list people pick from, and the screen where Purchase and the Manager add and edit them.
//   GET  /api/suppliers              active suppliers (fills the purchase order dropdown)
//   GET  /api/suppliers/list?q=&filter=all|off     every supplier with how many orders and payments it has (anyone who may view suppliers)
//   POST /api/suppliers              add a supplier                      (suppliers.manage)
//   PUT  /api/suppliers/:id          change a supplier, or switch it on or off   (suppliers.manage)
// Bank details are only ever sent to, or accepted from, people who hold field.supplier_bank. A switched-off supplier is no longer offered on
// new orders; old orders keep it. Removing a supplier is on Remove Data (and only while nothing uses it).
const express = require('express');
const { pool } = require('../database');
const { requirePermission } = require('../auth');
const { KEYS } = require('../permissions');
const { can, fieldAccess } = require('../access');
const { fail } = require('../utils');
const { audit } = require('../audit');
const router = express.Router();

const BANK = ['bank_name', 'account_number', 'ifsc_code'];
const idOf = (v) => (/^\d+$/.test(String(v)) && Number(v) > 0 ? Number(v) : null);
const tidy = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;

router.get('/', requirePermission(KEYS.SUPPLIERS_VIEW), async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, name, contact_person, phone, email, gst_number, bank_name, account_number, ifsc_code " +
      "FROM suppliers WHERE status = 'active' ORDER BY name"
    );
    const fa = fieldAccess(req.access);
    if (!fa.supplier_bank) result.rows.forEach(r => { delete r.bank_name; delete r.account_number; delete r.ifsc_code; });
    res.json({ success: true, suppliers: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load suppliers' });
  }
});

router.get('/list', requirePermission(KEYS.SUPPLIERS_VIEW), async (req, res) => {
  try {
    const q = tidy(req.query.q, 80), filter = req.query.filter === 'off' ? 'off' : 'all', fa = fieldAccess(req.access);
    const rows = (await pool.query(
      `SELECT s.id, s.name, s.contact_person, s.phone, s.email, s.gst_number, s.bank_name, s.account_number, s.ifsc_code, s.status, s.created_at::date::text AS created,
              (SELECT COUNT(*)::int FROM purchase_orders po WHERE po.supplier_id = s.id) AS orders, (SELECT COUNT(*)::int FROM payments y WHERE y.supplier_id = s.id) AS payments
         FROM suppliers s WHERE ($1 = '' OR s.name ILIKE '%' || $1 || '%' OR s.gst_number ILIKE '%' || $1 || '%' OR s.contact_person ILIKE '%' || $1 || '%' OR s.phone ILIKE '%' || $1 || '%')
          AND ($2 = 'all' OR s.status = 'inactive') ORDER BY s.name LIMIT 400`, [q, filter])).rows;
    if (!fa.supplier_bank) rows.forEach(r => BANK.forEach(k => { delete r[k]; }));
    const t = (await pool.query("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'inactive')::int AS off FROM suppliers")).rows[0];
    res.json({ success: true, suppliers: rows, totals: t, can_manage: can(req.access, KEYS.SUPPLIERS_MANAGE), can_bank: fa.supplier_bank });
  } catch (err) { console.error('suppliers list failed:', err); fail(res, 500, 'Could not load the suppliers'); }
});

/** Checks the fields that were sent. Returns { error, status } or { set }. Only fields present in the body are returned. */
function clean(b, access, creating) {
  const set = {}, fa = fieldAccess(access);
  if (b.name !== undefined || creating) { const n = tidy(b.name, 150); if (!n) return { error: 'The supplier name is required' }; set.name = n; }
  if (b.contact_person !== undefined) set.contact_person = tidy(b.contact_person, 100) || null;
  if (b.phone !== undefined) { const p = tidy(b.phone, 20); if (p && (!/^[0-9+()\- ]+$/.test(p) || p.replace(/\D/g, '').length < 7)) return { error: 'The phone number can only have digits, spaces, + - ( ) and needs at least 7 digits' }; set.phone = p || null; }
  if (b.email !== undefined) { const e = tidy(b.email, 150).toLowerCase(); if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return { error: 'That email address does not look right' }; set.email = e || null; }
  if (b.gst_number !== undefined) { const g = tidy(b.gst_number, 20).toUpperCase().replace(/\s/g, ''); if (g && !GSTIN.test(g)) return { error: 'The GST number must be 15 characters, like 32ABCDE1234F1Z5' }; set.gst_number = g || null; }
  const sentBank = BANK.filter(k => b[k] !== undefined && String(b[k]).trim() !== '');
  if ((sentBank.length || BANK.some(k => b[k] !== undefined)) && !fa.supplier_bank) { if (sentBank.length) return { error: 'You do not have access to bank details', status: 403 }; }
  if (fa.supplier_bank) {
    if (b.bank_name !== undefined) set.bank_name = tidy(b.bank_name, 100) || null;
    if (b.account_number !== undefined) { const a = tidy(b.account_number, 30).replace(/\s/g, ''); if (a && !/^[A-Za-z0-9]{6,30}$/.test(a)) return { error: 'The account number needs 6 to 30 letters or digits' }; set.account_number = a || null; }
    if (b.ifsc_code !== undefined) { const i = tidy(b.ifsc_code, 15).toUpperCase().replace(/\s/g, ''); if (i && !IFSC.test(i)) return { error: 'The IFSC code must be 11 characters, like SBIN0001234' }; set.ifsc_code = i || null; }
  }
  if (b.active !== undefined) { if (typeof b.active !== 'boolean') return { error: 'Active must be true or false' }; set.status = b.active ? 'active' : 'inactive'; }
  return { set };
}
const needManage = requirePermission(KEYS.SUPPLIERS_MANAGE);
async function clash(db, set, exceptId) {
  if (set.name !== undefined) { const r = (await db.query('SELECT id FROM suppliers WHERE lower(name) = lower($1) AND id IS DISTINCT FROM $2 LIMIT 1', [set.name, exceptId || null])).rows[0]; if (r) return 'A supplier with that name already exists'; }
  if (set.gst_number) { const r = (await db.query('SELECT name FROM suppliers WHERE gst_number = $1 AND id IS DISTINCT FROM $2 LIMIT 1', [set.gst_number, exceptId || null])).rows[0]; if (r) return `That GST number already belongs to ${r.name}`; }
  return null;
}
const mask = (v) => (v ? '****' + String(v).slice(-4) : null);
/** What goes in the audit history: bank details are noted as changed, never stored in full. */
const auditView = (o) => { const x = { ...o }; if (x.account_number !== undefined) x.account_number = mask(x.account_number); return x; };

router.post('/', needManage, async (req, res) => {
  const c = clean(req.body || {}, req.access, true); if (c.error) return fail(res, c.status || 400, c.error);
  const set = { status: 'active', ...c.set };
  try {
    const bad = await clash(pool, set); if (bad) return fail(res, 409, bad);
    const cols = Object.keys(set), r = await pool.query(`INSERT INTO suppliers (${cols.join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING id`, cols.map(k => set[k]));
    await audit(pool, req, { action: 'supplier.create', entity: 'supplier', id: r.rows[0].id, summary: `Added supplier ${set.name}`, after: auditView(set) });
    res.status(201).json({ success: true, id: r.rows[0].id });
  } catch (err) {
    if (err.code === '23505') return fail(res, 409, 'That GST number is already used by another supplier');
    console.error('supplier create failed:', err); fail(res, 500, 'Could not add the supplier');
  }
});

router.put('/:id', needManage, async (req, res) => {
  const id = idOf(req.params.id); if (!id) return fail(res, 400, 'Invalid supplier id');
  const c = clean(req.body || {}, req.access, false); if (c.error) return fail(res, c.status || 400, c.error);
  const keys = Object.keys(c.set); if (!keys.length) return fail(res, 400, 'Nothing to change');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = (await client.query('SELECT * FROM suppliers WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) { await client.query('ROLLBACK'); return fail(res, 404, 'Supplier not found'); }
    const changed = keys.filter(k => String(c.set[k] == null ? '' : c.set[k]) !== String(cur[k] == null ? '' : cur[k]));
    if (!changed.length) { await client.query('ROLLBACK'); return fail(res, 400, 'Nothing was changed'); }
    const set = {}; changed.forEach(k => { set[k] = c.set[k]; });
    const bad = await clash(client, set, id); if (bad) { await client.query('ROLLBACK'); return fail(res, 409, bad); }
    await client.query(`UPDATE suppliers SET ${changed.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${changed.length + 1}`, [...changed.map(k => set[k]), id]);
    const before = {}; changed.forEach(k => { before[k] = cur[k]; });
    await audit(client, req, { action: set.status === 'inactive' ? 'supplier.off' : set.status === 'active' && cur.status === 'inactive' ? 'supplier.on' : 'supplier.update', entity: 'supplier', id,
      summary: `${cur.name}: changed ${changed.join(', ')}`, before: auditView(before), after: auditView(set) });
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return fail(res, 409, 'That GST number is already used by another supplier');
    console.error('supplier update failed:', err); fail(res, 500, 'Could not save the change');
  } finally { client.release(); }
});

module.exports = router;
