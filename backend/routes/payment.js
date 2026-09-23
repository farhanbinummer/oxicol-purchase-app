// routes/payment.js - 100% advance payment APIs.
//   POST /api/payment/advance      record an advance payment for a PO
//   GET  /api/payment/po/:po_id    payment(s) for one PO
//   GET  /api/payment              all payments + outstanding advances
//   PUT  /api/payment/:id/approve  approve a payment that was saved as "initiated"

const express = require('express');
const { pool } = require('../database');
const { fail, todayISO, isValidDate, stamp, nextNumber } = require('../utils');
const { requirePermission } = require('../auth');
const { KEYS } = require('../permissions');
const router = express.Router();

// ------------------------------------------------------------
// POST /api/payment/advance
// body: { po_id, payment_date?, utr_number, approved, approved_by?, notes? }
//   approved = true  -> payment "confirmed", PO becomes payment_done
//   approved = false -> payment "initiated", PO becomes payment_pending
//                       (approve it later with PUT /api/payment/:id/approve)
// The amount is NOT taken from the browser: it is always the PO total from the database.
// ------------------------------------------------------------
router.post('/advance', requirePermission(KEYS.PAYMENT_CREATE), async (req, res) => {
  const b = req.body || {};

  const poId = Number(b.po_id);
  if (!Number.isInteger(poId) || poId <= 0) return fail(res, 400, 'Please select a PO');

  const utr = String(b.utr_number || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6,30}$/.test(utr)) {
    return fail(res, 400, 'UTR number is required (6-30 letters/numbers, no spaces)');
  }

  const paymentDate = b.payment_date || todayISO();
  if (!isValidDate(paymentDate)) return fail(res, 400, 'Payment date must be a valid date (YYYY-MM-DD)');

  const approved = b.approved === true || b.approved === 'true';
  const approvedBy = b.approved_by ? String(b.approved_by).trim() : null;
  const notes = b.notes ? String(b.notes).trim() : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // FOR UPDATE locks this PO row so two people cannot pay the same PO at once.
    const po = await client.query(
      'SELECT id, po_number, supplier_id, total_amount, status FROM purchase_orders WHERE id = $1 FOR UPDATE',
      [poId]);
    if (po.rowCount === 0) { await client.query('ROLLBACK'); return fail(res, 404, 'PO not found'); }
    const p = po.rows[0];

    if (!['created', 'payment_pending'].includes(p.status)) {
      await client.query('ROLLBACK');
      return fail(res, 400, `Cannot record payment: PO is already "${p.status}"`);
    }
    // One advance per PO (failed payments do not count, so they can be retried).
    const existing = await client.query(
      "SELECT payment_id FROM payments WHERE po_id = $1 AND status <> 'failed' LIMIT 1", [poId]);
    if (existing.rowCount > 0) {
      await client.query('ROLLBACK');
      return fail(res, 400, `This PO already has a payment (${existing.rows[0].payment_id})`);
    }

    const paymentId = await nextNumber(client, 'payments', 'payment_id', `PAY-${stamp(paymentDate)}-`);
    const status = approved ? 'confirmed' : 'initiated';

    await client.query(
      `INSERT INTO payments
         (payment_id, po_id, supplier_id, payment_date, amount, payment_mode,
          utr_number, approved_by, status, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, 'bank_transfer', $6, $7, $8, $9, $10)`,
      [paymentId, poId, p.supplier_id, paymentDate, p.total_amount, utr, approvedBy, status, notes, req.user.id]);

    await client.query('UPDATE purchase_orders SET status = $1 WHERE id = $2',
      [approved ? 'payment_done' : 'payment_pending', poId]);

    await client.query('COMMIT');
    res.status(201).json({
      success: true,
      payment_id: paymentId,
      po_number: p.po_number,
      amount: Number(p.total_amount),
      utr,
      status
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') { // unique violation -> the UTR already exists
      return fail(res, 400, 'This UTR number is already recorded for another payment');
    }
    console.error('Record payment failed:', err);
    fail(res, 500, 'Could not record payment');
  } finally {
    client.release();
  }
});

// ------------------------------------------------------------
// GET /api/payment/po/:po_id - payments of one PO and its payment status
// ------------------------------------------------------------
router.get('/po/:po_id', requirePermission(KEYS.PAYMENT_VIEW_BY_PO), async (req, res) => {
  const poId = Number(req.params.po_id);
  if (!Number.isInteger(poId) || poId <= 0) return fail(res, 400, 'Invalid PO id');
  try {
    const po = await pool.query(
      'SELECT id, po_number, total_amount FROM purchase_orders WHERE id = $1', [poId]);
    if (po.rowCount === 0) return fail(res, 404, 'PO not found');

    const pays = await pool.query('SELECT * FROM payments WHERE po_id = $1 ORDER BY id', [poId]);
    const live = pays.rows.filter(p => p.status !== 'failed');
    res.json({
      success: true,
      po_number: po.rows[0].po_number,
      po_total: po.rows[0].total_amount,
      payment_status: live.length ? live[live.length - 1].status : 'none',
      payments: pays.rows
    });
  } catch (err) {
    console.error(err);
    fail(res, 500, 'Could not load payments');
  }
});

// ------------------------------------------------------------
// GET /api/payment - all payments, newest first, plus summary numbers
//   total_paid           = confirmed payments
//   outstanding_advances = confirmed payments whose PO has no GRN yet
//                          (money paid to suppliers but goods not received/matched)
// ------------------------------------------------------------
router.get('/', requirePermission(KEYS.PAYMENT_VIEW_ALL), async (req, res) => {
  try {
    const list = await pool.query(
      `SELECT p.*, po.po_number, s.name AS supplier_name,
              EXISTS (SELECT 1 FROM grn_notes g WHERE g.po_id = p.po_id AND g.status <> 'rejected') AS grn_done
         FROM payments p
         JOIN purchase_orders po ON po.id = p.po_id
         JOIN suppliers s ON s.id = p.supplier_id
        ORDER BY p.id DESC`);

    const confirmed = list.rows.filter(p => p.status === 'confirmed');
    const sum = (rows) => rows.reduce((t, p) => t + Number(p.amount), 0);
    const outstanding = confirmed.filter(p => !p.grn_done);

    res.json({
      success: true,
      count: list.rowCount,
      total_paid: Math.round(sum(confirmed) * 100) / 100,
      outstanding_advances: Math.round(sum(outstanding) * 100) / 100,
      outstanding_count: outstanding.length,
      payments: list.rows
    });
  } catch (err) {
    console.error(err);
    fail(res, 500, 'Could not load payments');
  }
});

// ------------------------------------------------------------
// PUT /api/payment/:id/approve - body (optional): { approved_by }
// Turns an "initiated" payment into "confirmed" and marks the PO payment_done.
// ------------------------------------------------------------
router.put('/:id/approve', requirePermission(KEYS.PAYMENT_APPROVE), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid payment id');
  const approvedBy = req.body && req.body.approved_by ? String(req.body.approved_by).trim() : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query('SELECT id, po_id, status FROM payments WHERE id = $1 FOR UPDATE', [id]);
    if (cur.rowCount === 0) { await client.query('ROLLBACK'); return fail(res, 404, 'Payment not found'); }
    if (cur.rows[0].status !== 'initiated') {
      await client.query('ROLLBACK');
      return fail(res, 400, `Only "initiated" payments can be approved (this one is "${cur.rows[0].status}")`);
    }
    await client.query(
      "UPDATE payments SET status = 'confirmed', approved_by = COALESCE($1, approved_by) WHERE id = $2",
      [approvedBy, id]);
    await client.query(
      "UPDATE purchase_orders SET status = 'payment_done' WHERE id = $1 AND status IN ('created','payment_pending')",
      [cur.rows[0].po_id]);
    await client.query('COMMIT');
    res.json({ success: true, payment_id: id, status: 'confirmed' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    fail(res, 500, 'Could not approve payment');
  } finally {
    client.release();
  }
});

module.exports = router;
