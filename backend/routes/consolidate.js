// routes/consolidate.js - merge branch requests + production indents into one PO.
//   GET  /api/consolidate/all          pending/approved requests, grouped by item
//   POST /api/consolidate/create-po    create the PO and link the sources to it

const express = require('express');
const { pool } = require('../database');
const { notify } = require('../notify');
const { fail, round2, isValidDate, stamp, todayISO, nextNumber } = require('../utils');
const { requirePermission } = require('../auth');
const { KEYS } = require('../permissions');
const router = express.Router();

const CGST_RATE = Number(process.env.CGST_RATE ?? 9);
const SGST_RATE = Number(process.env.SGST_RATE ?? 9);
const OPEN = "('pending','approved')"; // request/indent statuses not yet turned into a PO

// ------------------------------------------------------------
// GET /api/consolidate/all
// ------------------------------------------------------------
router.get('/all', requirePermission(KEYS.CONSOLIDATE_VIEW), async (req, res) => {
  try {
    const branchReqs = await pool.query(
      `SELECT r.id, r.request_number, r.branch, r.requested_by, r.status,
              json_agg(json_build_object('item_name', i.item_name, 'quantity', i.quantity, 'unit', i.unit)
                       ORDER BY i.id) AS items
         FROM branch_stock_requests r JOIN branch_request_items i ON i.request_id = r.id
        WHERE r.status IN ${OPEN}
        GROUP BY r.id ORDER BY r.id`);

    const indents = await pool.query(
      `SELECT d.id, d.indent_number, d.production_head, d.status,
              json_agg(json_build_object('item_name', i.item_name, 'quantity', i.quantity, 'unit', i.unit)
                       ORDER BY i.id) AS items
         FROM production_indents d JOIN production_indent_items i ON i.indent_id = d.id
        WHERE d.status IN ${OPEN}
        GROUP BY d.id ORDER BY d.id`);

    // Group every open item by (name, unit) so 3 branches wanting Paint Thinner become one line.
    const totals = new Map(); // key "name||unit" -> { item_name, unit, total_quantity, sources: [] }
    const add = (item_name, quantity, unit, sourceType, sourceId, sourceNumber) => {
      const key = item_name.toLowerCase() + '||' + unit.toLowerCase();
      if (!totals.has(key)) totals.set(key, { item_name, unit, total_quantity: 0, sources: [] });
      const row = totals.get(key);
      row.total_quantity = round2(row.total_quantity + Number(quantity));
      row.sources.push({ type: sourceType, source_id: sourceId, source_number: sourceNumber, quantity: Number(quantity) });
    };
    branchReqs.rows.forEach(r => r.items.forEach(i => add(i.item_name, i.quantity, i.unit, 'branch', r.id, r.request_number)));
    indents.rows.forEach(d => d.items.forEach(i => add(i.item_name, i.quantity, i.unit, 'production', d.id, d.indent_number)));

    res.json({
      success: true,
      branch_requests: branchReqs.rows,
      production_indents: indents.rows,
      consolidated_items: [...totals.values()]
    });
  } catch (err) {
    console.error(err);
    fail(res, 500, 'Could not load consolidated orders');
  }
});

// ------------------------------------------------------------
// POST /api/consolidate/create-po
// body: { supplier_id, delivery_date, notes, branch_request_ids:[], production_indent_ids:[],
//         items: [{ item_name, quantity, unit, rate }] }
// Creates the PO (same maths as /api/po/create) and marks every listed request/indent "po_raised".
// ------------------------------------------------------------
router.post('/create-po', requirePermission(KEYS.CONSOLIDATE_CREATE_PO), async (req, res) => {
  const b = req.body || {};
  if (!Number.isInteger(Number(b.supplier_id)) || Number(b.supplier_id) <= 0) {
    return fail(res, 400, 'Please select a supplier');
  }
  if (b.delivery_date && !isValidDate(b.delivery_date)) return fail(res, 400, 'Delivery date is invalid');
  if (!Array.isArray(b.items) || b.items.length === 0) return fail(res, 400, 'Add at least one item');
  for (let i = 0; i < b.items.length; i++) {
    const it = b.items[i];
    if (!it.item_name || !String(it.item_name).trim()) return fail(res, 400, `Item ${i + 1}: name is required`);
    if (!it.unit || !String(it.unit).trim()) return fail(res, 400, `Item ${i + 1}: unit is required`);
    if (!isFinite(Number(it.quantity)) || Number(it.quantity) <= 0) return fail(res, 400, `Item ${i + 1}: quantity must be greater than 0`);
    if (!isFinite(Number(it.rate)) || Number(it.rate) <= 0) return fail(res, 400, `Item ${i + 1}: rate must be greater than 0`);
  }
  const branchIds = Array.isArray(b.branch_request_ids) ? b.branch_request_ids.map(Number).filter(Number.isInteger) : [];
  const indentIds = Array.isArray(b.production_indent_ids) ? b.production_indent_ids.map(Number).filter(Number.isInteger) : [];
  if (branchIds.length === 0 && indentIds.length === 0) {
    return fail(res, 400, 'Select at least one branch request or production indent to consolidate');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const sup = await client.query("SELECT id FROM suppliers WHERE id = $1 AND status = 'active'", [b.supplier_id]);
    if (sup.rowCount === 0) { await client.query('ROLLBACK'); return fail(res, 400, 'Supplier not found'); }

    const lines = b.items.map(it => ({
      item_name: String(it.item_name).trim(), quantity: Number(it.quantity), unit: String(it.unit).trim(),
      rate: Number(it.rate), line_amount: round2(Number(it.quantity) * Number(it.rate))
    }));
    const subtotal = round2(lines.reduce((s, l) => s + l.line_amount, 0));
    const cgst = round2(subtotal * CGST_RATE / 100);
    const sgst = round2(subtotal * SGST_RATE / 100);
    const total = round2(subtotal + cgst + sgst);
    const poNumber = await nextNumber(client, 'purchase_orders', 'po_number', `OXI-PO-${stamp(todayISO())}-`);

    const po = await client.query(
      `INSERT INTO purchase_orders
         (po_number, supplier_id, subtotal, cgst_amount, sgst_amount, igst_amount, total_amount, delivery_date, status, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,0,$6,$7,'created',$8,$9) RETURNING id, po_number, total_amount`,
      [poNumber, b.supplier_id, subtotal, cgst, sgst, total, b.delivery_date || null,
       b.notes ? String(b.notes).trim() : 'Consolidated from branch requests / production indents', req.user.id]);
    const poId = po.rows[0].id;

    for (const l of lines) {
      await client.query(
        'INSERT INTO po_items (po_id, item_name, quantity, unit, rate, line_amount) VALUES ($1,$2,$3,$4,$5,$6)',
        [poId, l.item_name, l.quantity, l.unit, l.rate, l.line_amount]);
    }

    // Link and close out every source that fed this PO.
    for (const id of branchIds) {
      const r = await client.query(
        "UPDATE branch_stock_requests SET status = 'po_raised' WHERE id = $1 AND status IN ('pending','approved') RETURNING id", [id]);
      if (r.rowCount === 0) { await client.query('ROLLBACK'); return fail(res, 400, `Branch request ${id} is not open for consolidation`); }
      await client.query("INSERT INTO po_source_links (po_id, source_type, source_id) VALUES ($1,'branch',$2)", [poId, id]);
    }
    for (const id of indentIds) {
      const r = await client.query(
        "UPDATE production_indents SET status = 'po_raised' WHERE id = $1 AND status IN ('pending','approved') RETURNING id", [id]);
      if (r.rowCount === 0) { await client.query('ROLLBACK'); return fail(res, 400, `Production indent ${id} is not open for consolidation`); }
      await client.query("INSERT INTO po_source_links (po_id, source_type, source_id) VALUES ($1,'production',$2)", [poId, id]);
    }

    await client.query('COMMIT');
    notify({ roles: ['accounts', 'store'], subject: 'New purchase order ' + po.rows[0].po_number, text: `Purchase order ${po.rows[0].po_number} was created from consolidated requests. Accounts: advance payment is due.`, path: 'po-detail.html?id=' + poId });
    res.status(201).json({
      success: true, po_id: poId, po_number: po.rows[0].po_number, total_amount: Number(po.rows[0].total_amount),
      branch_requests_linked: branchIds.length, production_indents_linked: indentIds.length
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Consolidate create-po failed:', err);
    fail(res, 500, 'Could not create PO from consolidated requests');
  } finally {
    client.release();
  }
});

module.exports = router;
