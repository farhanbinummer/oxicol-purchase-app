// routes/consolidate.js - merge branch requests + production indents into one PO.
//   GET  /api/consolidate/all          pending/approved requests, grouped by item
//   POST /api/consolidate/create-po    create the PO and link the sources to it

const express = require('express');
const { pool } = require('../database');
const { notify } = require('../notify');
const { audit } = require('../audit');
const { fail, round2, isValidDate, stamp, todayISO, nextNumber } = require('../utils');
const { requirePermission } = require('../auth');
const { KEYS } = require('../permissions');
const { branchScope, branchClause } = require('../access');
const { taxMode, taxLines, validOverride, cleanRate } = require('../tax');
const router = express.Router();

// Only APPROVED demand can be purchased. Pending requests/indents have not been signed off yet.
const OPEN = "('approved')";

// ------------------------------------------------------------
// GET /api/consolidate/all
// ------------------------------------------------------------
router.get('/all', requirePermission(KEYS.CONSOLIDATE_VIEW), async (req, res) => {
  try {
    const scopeParams = [];
    const scoped = branchClause(branchScope(req.access, KEYS.CONSOLIDATE_VIEW), 'r.branch', scopeParams);
    const branchReqs = await pool.query(
      `SELECT r.id, r.request_number, r.branch, r.requested_by, r.status,
              json_agg(json_build_object('item_name', i.item_name, 'quantity', i.quantity, 'unit', i.unit)
                       ORDER BY i.id) AS items
         FROM branch_stock_requests r JOIN branch_request_items i ON i.request_id = r.id AND i.ordered_in_po IS NULL
        WHERE r.status IN ${OPEN} AND r.planned_indent_id IS NULL${scoped}
        GROUP BY r.id ORDER BY r.id`, scopeParams);

    // A request planned into a production indent is bought through that indent's raw materials. Listing it here
    // as well would buy the same demand twice, so it is held back (and shown so nobody wonders where it went).
    const heldBack = await pool.query(
      `SELECT r.id, r.request_number, r.branch, i.indent_number FROM branch_stock_requests r
         JOIN production_indents i ON i.id = r.planned_indent_id WHERE r.status = 'approved'${scoped} ORDER BY r.id`, scopeParams);

    const indents = await pool.query(
      `SELECT d.id, d.indent_number, d.production_head, d.status,
              json_agg(json_build_object('item_name', i.item_name, 'quantity', i.quantity, 'unit', i.unit)
                       ORDER BY i.id) AS items
         FROM production_indents d JOIN production_indent_items i ON i.indent_id = d.id AND i.ordered_in_po IS NULL
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
      held_back: heldBack.rows,
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
// Creates the PO (same maths as /api/po/create). The lines it buys are marked as ordered; a request/indent turns "po_raised" once all its lines are.
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
    if (cleanRate(it.gst_rate) === undefined) return fail(res, 400, `Item ${i + 1}: GST rate must be one of 0, 0.25, 3, 5, 12, 18 or 28 (or blank for 18)`);
  }
  const branchIds = Array.isArray(b.branch_request_ids) ? b.branch_request_ids.map(Number).filter(Number.isInteger) : [];
  const indentIds = Array.isArray(b.production_indent_ids) ? b.production_indent_ids.map(Number).filter(Number.isInteger) : [];
  if (branchIds.length === 0 && indentIds.length === 0) {
    return fail(res, 400, 'Select at least one branch request or production indent to consolidate');
  }
  // Every request being bought must belong to a branch this person may reach.
  const buyScope = branchScope(req.access, KEYS.CONSOLIDATE_CREATE_PO);
  if (buyScope !== null && branchIds.length) {
    const own = await pool.query('SELECT id, branch FROM branch_stock_requests WHERE id = ANY($1)', [branchIds]);
    if (own.rows.some(r => !buyScope.includes(r.branch))) return fail(res, 403, 'One of those requests belongs to a branch you are not assigned to');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const sup = await client.query("SELECT id, gst_number FROM suppliers WHERE id = $1 AND status = 'active'", [b.supplier_id]);
    if (sup.rowCount === 0) { await client.query('ROLLBACK'); return fail(res, 400, 'Supplier not found'); }

    const lines = b.items.map(it => ({
      item_name: String(it.item_name).trim(), quantity: Number(it.quantity), unit: String(it.unit).trim(),
      rate: Number(it.rate), gst_rate: cleanRate(it.gst_rate), line_amount: round2(Number(it.quantity) * Number(it.rate))
    }));
    const subtotal = round2(lines.reduce((s, l) => s + l.line_amount, 0));
    // an item with no rate typed takes the GST rate of the raw material of the same name, when the list has one
    const missing = lines.filter(l => l.gst_rate === null);
    if (missing.length) {
      const mr = (await client.query('SELECT lower(name) AS n, gst_rate::float AS r FROM raw_materials WHERE lower(name) = ANY($1) AND gst_rate IS NOT NULL', [missing.map(l => l.item_name.toLowerCase())])).rows;
      for (const l of missing) { const m = mr.find(x => x.n === l.item_name.toLowerCase()); if (m && cleanRate(m.r) !== undefined) l.gst_rate = cleanRate(m.r); }
    }
    const { cgst, sgst, igst, total } = taxLines(lines.map(l => ({ amount: l.line_amount, rate: l.gst_rate })), taxMode(sup.rows[0].gst_number, validOverride(b.tax_type)));   // IGST for another state's supplier
    const poNumber = await nextNumber(client, 'purchase_orders', 'po_number', `OXI-PO-${stamp(todayISO())}-`);

    const po = await client.query(
      `INSERT INTO purchase_orders
         (po_number, supplier_id, subtotal, cgst_amount, sgst_amount, igst_amount, total_amount, delivery_date, status, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$10,$6,$7,'created',$8,$9) RETURNING id, po_number, total_amount`,
      [poNumber, b.supplier_id, subtotal, cgst, sgst, total, b.delivery_date || null,
       b.notes ? String(b.notes).trim() : 'Consolidated from branch requests / production indents', req.user.id, igst]);
    const poId = po.rows[0].id;

    for (const l of lines) {
      await client.query(
        'INSERT INTO po_items (po_id, item_name, quantity, unit, rate, line_amount, gst_rate) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [poId, l.item_name, l.quantity, l.unit, l.rate, l.line_amount, l.gst_rate]);
    }

    // Mark the lines this order buys (matched by item name and unit) and link their requests. A request becomes "po_raised"
    // only when every one of its lines is on an order; otherwise it stays approved and its other lines stay open.
    const bought = new Set(lines.map(l => l.item_name.toLowerCase() + '||' + l.unit.toLowerCase()));
    const SRC = { branch: { ids: branchIds, head: 'branch_stock_requests', lines: 'branch_request_items', fk: 'request_id', label: 'Branch request' },
                  production: { ids: indentIds, head: 'production_indents', lines: 'production_indent_items', fk: 'indent_id', label: 'Production indent' } };
    for (const type of ['branch', 'production']) {
      const S = SRC[type];
      for (const id of S.ids) {
        const h = (await client.query(`SELECT status${type === 'branch' ? ', request_number, planned_indent_id' : ''} FROM ${S.head} WHERE id = $1 FOR UPDATE`, [id])).rows[0];
        if (type === 'branch' && h && h.planned_indent_id) {
          await client.query('ROLLBACK');
          return fail(res, 400, `${h.request_number} was planned into a production indent. Buy its raw materials through that indent - buying the request as well would count the same demand twice.`);
        }
        if (!h || h.status !== 'approved') { await client.query('ROLLBACK'); return fail(res, 400, `${S.label} ${id} is not an approved, open ${type === 'branch' ? 'request' : 'indent'}${h ? ` (it is "${h.status}")` : ''}`); }
        const open = (await client.query(`SELECT id, item_name, unit FROM ${S.lines} WHERE ${S.fk} = $1 AND ordered_in_po IS NULL`, [id])).rows;
        const mine = open.filter(l => bought.has(l.item_name.toLowerCase() + '||' + l.unit.toLowerCase()));
        if (mine.length === 0) { await client.query('ROLLBACK'); return fail(res, 400, `${S.label} ${id} has nothing in this order: tick only the sources whose items you are buying`); }
        await client.query(`UPDATE ${S.lines} SET ordered_in_po = $1 WHERE id = ANY($2)`, [poId, mine.map(l => l.id)]);
        if (mine.length === open.length) await client.query(`UPDATE ${S.head} SET status = 'po_raised' WHERE id = $1`, [id]);
        await client.query('INSERT INTO po_source_links (po_id, source_type, source_id) VALUES ($1,$2,$3)', [poId, type, id]);
      }
    }

    await audit(client, req, { action: 'po.create_consolidated', entity: 'purchase_order', id: poId, summary: `${po.rows[0].po_number} created from ${branchIds.length} request(s) and ${indentIds.length} indent(s)`, after: { branch_request_ids: branchIds, production_indent_ids: indentIds, total: Number(po.rows[0].total_amount) } });
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
