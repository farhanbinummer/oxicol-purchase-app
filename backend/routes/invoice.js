// routes/invoice.js - Invoice upload + 3-way match (PO vs GRN vs Invoice).
//   POST /api/invoice/upload        save invoice details for a PO (one invoice per PO)
//   GET  /api/invoice/:po_id        the invoice for a PO, plus its match history
//   POST /api/invoice/match/:invoice_id   run (or re-run) the 3-way match

const express = require('express');
const { pool } = require('../database');
const { fail, round2, isValidDate } = require('../utils');
const { requirePermission } = require('../auth');
const { KEYS } = require('../permissions');
const router = express.Router();

const CGST_RATE = Number(process.env.CGST_RATE ?? 9);
const SGST_RATE = Number(process.env.SGST_RATE ?? 9);
const EPSILON = 0.5; // rupees - amounts within this are treated as "the same"

// ------------------------------------------------------------
// POST /api/invoice/upload
// body: { po_id, invoice_number, invoice_date, invoice_amount, gst_number? }
// (File upload is out of scope this week - amounts are entered manually.)
// ------------------------------------------------------------
router.post('/upload', requirePermission(KEYS.INVOICE_UPLOAD), async (req, res) => {
  const b = req.body || {};
  const poId = Number(b.po_id);
  if (!Number.isInteger(poId) || poId <= 0) return fail(res, 400, 'Please select a PO');
  if (!b.invoice_number || !String(b.invoice_number).trim()) return fail(res, 400, 'Invoice number is required');
  if (!isValidDate(b.invoice_date)) return fail(res, 400, 'Invoice date must be a valid date (YYYY-MM-DD)');
  const amount = Number(b.invoice_amount);
  if (!isFinite(amount) || amount <= 0) return fail(res, 400, 'Invoice amount must be greater than 0');

  try {
    const po = await pool.query('SELECT id, po_number FROM purchase_orders WHERE id = $1', [poId]);
    if (po.rowCount === 0) return fail(res, 404, 'PO not found');

    const existing = await pool.query('SELECT id FROM purchase_invoices WHERE po_id = $1', [poId]);
    if (existing.rowCount > 0) return fail(res, 400, 'This PO already has an invoice uploaded');

    const r = await pool.query(
      `INSERT INTO purchase_invoices (invoice_number, po_id, invoice_date, invoice_amount, gst_number, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [String(b.invoice_number).trim(), poId, b.invoice_date, round2(amount),
       b.gst_number ? String(b.gst_number).trim() : null, req.user.id]);

    res.status(201).json({ success: true, invoice_id: r.rows[0].id, po_number: po.rows[0].po_number, status: 'uploaded' });
  } catch (err) {
    console.error('Upload invoice failed:', err);
    fail(res, 500, 'Could not save invoice');
  }
});

// ------------------------------------------------------------
// GET /api/invoice/:po_id
// ------------------------------------------------------------
router.get('/:po_id', requirePermission(KEYS.INVOICE_VIEW), async (req, res) => {
  const poId = Number(req.params.po_id);
  if (!Number.isInteger(poId) || poId <= 0) return fail(res, 400, 'Invalid PO id');
  try {
    const inv = await pool.query('SELECT * FROM purchase_invoices WHERE po_id = $1', [poId]);
    if (inv.rowCount === 0) return res.json({ success: true, invoice: null, matches: [] });
    const matches = await pool.query(
      'SELECT * FROM three_way_match WHERE invoice_id = $1 ORDER BY id DESC', [inv.rows[0].id]);
    res.json({ success: true, invoice: inv.rows[0], matches: matches.rows });
  } catch (err) {
    console.error(err);
    fail(res, 500, 'Could not load invoice');
  }
});

// ------------------------------------------------------------
// POST /api/invoice/match/:invoice_id
// Values the GRN at the PO's own rates and tax percentages, then compares
// PO total, that GRN value, and the invoice amount.
// ------------------------------------------------------------
router.post('/match/:invoice_id', requirePermission(KEYS.INVOICE_MATCH), async (req, res) => {
  const invoiceId = Number(req.params.invoice_id);
  if (!Number.isInteger(invoiceId) || invoiceId <= 0) return fail(res, 400, 'Invalid invoice id');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inv = await client.query('SELECT * FROM purchase_invoices WHERE id = $1 FOR UPDATE', [invoiceId]);
    if (inv.rowCount === 0) { await client.query('ROLLBACK'); return fail(res, 404, 'Invoice not found'); }
    const invoice = inv.rows[0];

    const po = await client.query('SELECT * FROM purchase_orders WHERE id = $1', [invoice.po_id]);
    const poRow = po.rows[0];

    const grn = await client.query(
      "SELECT id FROM grn_notes WHERE po_id = $1 AND status <> 'rejected' ORDER BY id DESC LIMIT 1", [invoice.po_id]);
    if (grn.rowCount === 0) {
      await client.query('ROLLBACK');
      return fail(res, 400, 'Create and approve a GRN for this PO before matching the invoice');
    }

    // Value what was actually received, at the PO's own rates - not what the invoice claims.
    const valued = await client.query(
      `SELECT COALESCE(SUM(gi.received_quantity * pi.rate), 0) AS subtotal
         FROM grn_items gi
         JOIN po_items pi ON pi.po_id = $2 AND pi.item_name = gi.item_name
        WHERE gi.grn_id = $1`, [grn.rows[0].id, invoice.po_id]);
    const grnSubtotal = round2(Number(valued.rows[0].subtotal));
    const grnTotal = round2(grnSubtotal * (1 + CGST_RATE / 100 + SGST_RATE / 100));

    const poTotal = round2(Number(poRow.total_amount));
    const invoiceTotal = round2(Number(invoice.invoice_amount));
    const varianceAmount = round2(invoiceTotal - grnTotal);

    let status, notes;
    if (Math.abs(invoiceTotal - poTotal) > EPSILON) {
      status = 'mismatch';
      notes = `Invoice amount (₹${invoiceTotal}) does not match the PO amount (₹${poTotal}).`;
    } else if (Math.abs(grnTotal - invoiceTotal) > EPSILON) {
      status = 'variance';
      notes = `Goods received are worth ₹${grnTotal}, but the invoice charges ₹${invoiceTotal} `
             + `(difference ₹${varianceAmount}). Check the received quantity against the invoice.`;
    } else {
      status = 'matched';
      notes = 'PO, goods received and invoice amount all agree.';
    }

    await client.query(
      `INSERT INTO three_way_match (invoice_id, po_id, po_total, grn_total, invoice_total, variance_amount, status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [invoiceId, invoice.po_id, poTotal, grnTotal, invoiceTotal, varianceAmount, status, notes]);

    await client.query('UPDATE purchase_invoices SET status = $1 WHERE id = $2', [status, invoiceId]);
    const poStatus = status === 'matched' ? 'invoice_matched' : 'variance_flagged';
    await client.query('UPDATE purchase_orders SET status = $1 WHERE id = $2', [poStatus, invoice.po_id]);

    await client.query('COMMIT');
    res.json({ success: true, status, po_total: poTotal, grn_total: grnTotal, invoice_total: invoiceTotal,
               variance_amount: varianceAmount, notes });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Invoice match failed:', err);
    fail(res, 500, 'Could not run 3-way match');
  } finally {
    client.release();
  }
});

module.exports = router;
