// routes/po.js - Purchase Order APIs.
//   POST   /api/po/create      create a PO (server calculates all amounts)
//   GET    /api/po             list all POs
//   GET    /api/po/:id         one PO with items, payments and GRNs
//   PUT    /api/po/:id/status  move PO status forward
//   DELETE /api/po/:id         delete a PO (only if not paid yet)

const express = require('express');
const { pool } = require('../database');
const { notify } = require('../notify');
const { fail, round2, isValidDate, stamp, todayISO, nextNumber } = require('../utils');
const { requirePermission } = require('../auth');
const { KEYS } = require('../permissions');
const router = express.Router();

// Order of statuses. A PO can only move FORWARD in this list.
// invoice_matched / variance_flagged / posted_to_tally are normally set automatically
// (by /api/invoice/match and /api/tally/sync), not through this manual dropdown.
const STATUS_FLOW = ['created', 'payment_pending', 'payment_done', 'in_transit', 'delivered',
                      'invoice_matched', 'variance_flagged', 'posted_to_tally', 'closed'];

// GST rates come from .env (default 9% + 9%)
const CGST_RATE = Number(process.env.CGST_RATE ?? 9);
const SGST_RATE = Number(process.env.SGST_RATE ?? 9);

/**
 * Checks the request body for POST /create.
 * Returns an error message string, or null when everything is valid.
 */
function validatePO(body) {
  if (!body || typeof body !== 'object') return 'Request body is missing';
  if (!Number.isInteger(Number(body.supplier_id)) || Number(body.supplier_id) <= 0) {
    return 'Please select a supplier';
  }
  if (body.delivery_date && !isValidDate(body.delivery_date)) {
    return 'Delivery date must be a valid date (YYYY-MM-DD)';
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return 'Add at least one item';
  }
  for (let i = 0; i < body.items.length; i++) {
    const it = body.items[i];
    const n = i + 1;
    if (!it.item_name || String(it.item_name).trim() === '') return `Item ${n}: name is required`;
    if (!it.unit || String(it.unit).trim() === '') return `Item ${n}: unit is required`;
    const qty = Number(it.quantity);
    const rate = Number(it.rate);
    if (!isFinite(qty) || qty <= 0) return `Item ${n}: quantity must be greater than 0`;
    if (!isFinite(rate) || rate <= 0) return `Item ${n}: rate must be greater than 0`;
  }
  return null;
}

// ------------------------------------------------------------
// POST /api/po/create
// ------------------------------------------------------------
router.post('/create', requirePermission(KEYS.PO_CREATE), async (req, res) => {
  const problem = validatePO(req.body);
  if (problem) return fail(res, 400, problem);

  const { supplier_id, delivery_date, notes, items } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); // all-or-nothing: PO header + items saved together

    // Supplier must exist and be active
    const sup = await client.query(
      "SELECT id FROM suppliers WHERE id = $1 AND status = 'active'", [supplier_id]);
    if (sup.rowCount === 0) {
      await client.query('ROLLBACK');
      return fail(res, 400, 'Supplier not found');
    }

    // Calculate line amounts and totals on the server (never trust the browser's maths)
    const lines = items.map((it) => ({
      item_name: String(it.item_name).trim(),
      quantity: Number(it.quantity),
      unit: String(it.unit).trim(),
      rate: Number(it.rate),
      hsn_code: it.hsn_code ? String(it.hsn_code).trim() : null,
      line_amount: round2(Number(it.quantity) * Number(it.rate))
    }));
    const subtotal = round2(lines.reduce((sum, l) => sum + l.line_amount, 0));
    const cgst = round2(subtotal * CGST_RATE / 100);
    const sgst = round2(subtotal * SGST_RATE / 100);
    const total = round2(subtotal + cgst + sgst);

    // PO number OXI-PO-YYYYMMDD-NNN (safe against two people saving at the same moment)
    const poNumber = await nextNumber(client, 'purchase_orders', 'po_number', `OXI-PO-${stamp(todayISO())}-`);

    const po = await client.query(
      `INSERT INTO purchase_orders
         (po_number, supplier_id, subtotal, cgst_amount, sgst_amount, igst_amount,
          total_amount, delivery_date, status, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, 0, $6, $7, 'created', $8, $9)
       RETURNING id, po_number, total_amount, status`,
      [poNumber, supplier_id, subtotal, cgst, sgst, total, delivery_date || null, notes || null, req.user.id]
    );
    const poId = po.rows[0].id;

    for (const l of lines) {
      await client.query(
        `INSERT INTO po_items (po_id, item_name, quantity, unit, rate, line_amount, hsn_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [poId, l.item_name, l.quantity, l.unit, l.rate, l.line_amount, l.hsn_code]
      );
    }

    await client.query('COMMIT');
    notify({ roles: ['accounts', 'store'], subject: 'New purchase order ' + po.rows[0].po_number, text: `Purchase order ${po.rows[0].po_number} was created (total Rs ${total}). Accounts: advance payment is due.`, path: 'po-detail.html?id=' + poId });
    res.status(201).json({
      success: true,
      po_id: poId,
      po_number: po.rows[0].po_number,
      subtotal, cgst_amount: cgst, sgst_amount: sgst,
      total_amount: total,
      status: po.rows[0].status
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Create PO failed:', err);
    fail(res, 500, 'Could not create PO');
  } finally {
    client.release();
  }
});

// ------------------------------------------------------------
// GET /api/po - list all POs, newest first
// ------------------------------------------------------------
router.get('/', requirePermission(KEYS.PO_VIEW), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT po.id, po.po_number, po.po_date, po.delivery_date, po.total_amount, po.status,
              s.name AS supplier_name,
              COALESCE((SELECT p.status FROM payments p WHERE p.po_id = po.id AND p.status <> 'failed'
                        ORDER BY p.id DESC LIMIT 1), 'none') AS payment_status,
              EXISTS (SELECT 1 FROM grn_notes g WHERE g.po_id = po.id AND g.status <> 'rejected') AS has_grn
         FROM purchase_orders po
         JOIN suppliers s ON s.id = po.supplier_id
        ORDER BY po.id DESC`
    );
    res.json({ success: true, count: result.rowCount, pos: result.rows });
  } catch (err) {
    console.error(err);
    fail(res, 500, 'Could not load POs');
  }
});

// ------------------------------------------------------------
// GET /api/po/:id - one PO with supplier, items, payments and GRNs
// ------------------------------------------------------------
router.get('/:id', requirePermission(KEYS.PO_VIEW), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid PO id');
  try {
    const po = await pool.query(
      `SELECT po.*, s.name AS supplier_name, s.contact_person, s.phone,
              s.bank_name, s.account_number, s.ifsc_code
         FROM purchase_orders po
         JOIN suppliers s ON s.id = po.supplier_id
        WHERE po.id = $1`, [id]);
    if (po.rowCount === 0) return fail(res, 404, 'PO not found');

    const items = await pool.query('SELECT * FROM po_items WHERE po_id = $1 ORDER BY id', [id]);
    const payments = await pool.query('SELECT * FROM payments WHERE po_id = $1 ORDER BY id', [id]);
    const grns = await pool.query('SELECT * FROM grn_notes WHERE po_id = $1 ORDER BY id', [id]);

    res.json({ success: true, po: po.rows[0], items: items.rows,
               payments: payments.rows, grns: grns.rows });
  } catch (err) {
    console.error(err);
    fail(res, 500, 'Could not load PO');
  }
});

// ------------------------------------------------------------
// PUT /api/po/:id/status - body: { "status": "payment_pending" }
// Only forward moves are allowed (created -> ... -> closed).
// ------------------------------------------------------------
router.put('/:id/status', requirePermission(KEYS.PO_UPDATE_STATUS), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid PO id');
  const newStatus = req.body && req.body.status;
  if (!STATUS_FLOW.includes(newStatus)) {
    return fail(res, 400, 'Status must be one of: ' + STATUS_FLOW.join(', '));
  }
  try {
    const cur = await pool.query('SELECT status FROM purchase_orders WHERE id = $1', [id]);
    if (cur.rowCount === 0) return fail(res, 404, 'PO not found');

    const from = STATUS_FLOW.indexOf(cur.rows[0].status);
    const to = STATUS_FLOW.indexOf(newStatus);
    if (to <= from) {
      return fail(res, 400, `Cannot move PO from "${cur.rows[0].status}" to "${newStatus}"`);
    }
    await pool.query('UPDATE purchase_orders SET status = $1 WHERE id = $2', [newStatus, id]);
    res.json({ success: true, po_id: id, status: newStatus });
  } catch (err) {
    console.error(err);
    fail(res, 500, 'Could not update status');
  }
});

// ------------------------------------------------------------
// DELETE /api/po/:id - only if no payment or GRN exists for it
// ------------------------------------------------------------
router.delete('/:id', requirePermission(KEYS.PO_DELETE), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid PO id');
  try {
    const cur = await pool.query('SELECT status FROM purchase_orders WHERE id = $1', [id]);
    if (cur.rowCount === 0) return fail(res, 404, 'PO not found');

    const pay = await pool.query('SELECT 1 FROM payments WHERE po_id = $1 LIMIT 1', [id]);
    const grn = await pool.query('SELECT 1 FROM grn_notes WHERE po_id = $1 LIMIT 1', [id]);
    if (pay.rowCount > 0 || grn.rowCount > 0 ||
        !['created', 'payment_pending'].includes(cur.rows[0].status)) {
      return fail(res, 400, 'Cannot delete: this PO already has a payment or goods receipt');
    }
    await pool.query('DELETE FROM purchase_orders WHERE id = $1', [id]); // items cascade
    res.json({ success: true, deleted_po_id: id });
  } catch (err) {
    console.error(err);
    fail(res, 500, 'Could not delete PO');
  }
});

module.exports = router;
