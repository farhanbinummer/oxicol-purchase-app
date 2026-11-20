// routes/branchRequest.js - Branch Stock Request APIs.
//   POST   /api/branch-request/create   branch asks HQ for stock
//   GET    /api/branch-request          list all requests (?status=pending)
//   GET    /api/branch-request/:id      one request with items and its PO (if raised)
//   PUT    /api/branch-request/:id/approve
//   DELETE /api/branch-request/:id      only while still "pending"

const express = require('express');
const { pool } = require('../database');
const { notify } = require('../notify');
const { audit } = require('../audit');
const { fail, isValidDate, todayISO, stamp, nextNumber } = require('../utils');
const { requirePermission } = require('../auth');
const { KEYS } = require('../permissions');
const { branchScope, inBranchScope, can } = require('../access');
const D = require('../delivery');
const router = express.Router();

const BRANCHES = ['Kannur', 'Thrissur', 'Trivandrum', 'Ernakulam'];

function validate(body) {
  if (!body || typeof body !== 'object') return 'Request body is missing';
  if (!BRANCHES.includes(body.branch)) return 'Branch must be one of: ' + BRANCHES.join(', ');
  if (body.delivery_needed_by && !isValidDate(body.delivery_needed_by)) {
    return 'Delivery needed by must be a valid date (YYYY-MM-DD)';
  }
  if (body.priority && !['normal', 'urgent'].includes(body.priority)) return 'Priority must be normal or urgent';
  if (!Array.isArray(body.items) || body.items.length === 0) return 'Add at least one item';
  for (let i = 0; i < body.items.length; i++) {
    const it = body.items[i];
    if (!Number.isInteger(Number(it.product_id)) || Number(it.product_id) <= 0) return `Item ${i + 1}: pick a product from the list`;
    if (!isFinite(Number(it.quantity)) || Number(it.quantity) <= 0) {
      return `Item ${i + 1}: quantity must be greater than 0`;
    }
  }
  const ids = body.items.map(it => Number(it.product_id));
  const dupe = ids.findIndex((v, i) => ids.indexOf(v) !== i);
  if (dupe >= 0) return `Item ${dupe + 1} repeats a product already listed - change its quantity instead`;
  return null;
}

router.post('/create', requirePermission(KEYS.BRANCH_REQUEST_CREATE), async (req, res) => {
  const problem = validate(req.body);
  if (problem) return fail(res, 400, problem);
  // Someone limited to one branch can only ever raise a request for that branch, whatever the form sends;
  // someone covering several must name one of them; someone unrestricted names any branch.
  const createScope = branchScope(req.access, KEYS.BRANCH_REQUEST_CREATE);
  let branch = req.body.branch;
  if (createScope !== null) {
    if (createScope.length === 1) branch = createScope[0];
    else if (!createScope.includes(branch)) return fail(res, 403, 'You may only raise requests for the branches you are assigned to');
  }
  const { delivery_needed_by, items } = req.body;
  // Who asked is the signed-in person - never a typed name.
  const requestedBy = req.user.name;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Products come from the catalogue by ID. The name and unit are copied from it (units are controlled).
    const ids = items.map(it => Number(it.product_id));
    const prods = await client.query('SELECT id, name, base_unit FROM products WHERE id = ANY($1) AND active', [ids]);
    const byId = new Map(prods.rows.map(p => [p.id, p]));
    const missing = ids.findIndex(i => !byId.has(i));
    if (missing >= 0) { await client.query('ROLLBACK'); return fail(res, 400, `Item ${missing + 1}: that product is not in the catalogue or is no longer active`); }
    const reqNumber = await nextNumber(client, 'branch_stock_requests', 'request_number', `REQ-${stamp(todayISO())}-`);
    const r = await client.query(
      `INSERT INTO branch_stock_requests (request_number, branch, requested_by, delivery_needed_by, created_by, priority)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [reqNumber, branch, requestedBy, delivery_needed_by || null, req.user.id, req.body.priority || 'normal']);
    const id = r.rows[0].id;
    for (const it of items) {
      const p = byId.get(Number(it.product_id));
      await client.query(
        "INSERT INTO branch_request_items (request_id, item_name, quantity, unit, product_id, mapping_status) VALUES ($1,$2,$3,$4,$5,'mapped')",
        [id, p.name, Number(it.quantity), p.base_unit, p.id]);
    }
    await audit(client, req, { action: 'request.create', entity: 'branch_request', id, summary: `${reqNumber} raised for ${branch} (${items.length} item${items.length === 1 ? '' : 's'})`, after: { branch, priority: req.body.priority || 'normal', items: items.map(it => ({ product_id: Number(it.product_id), quantity: Number(it.quantity) })) } });
    await client.query('COMMIT');
    notify({ roles: ['store'], subject: 'New branch request ' + reqNumber, text: `New ${req.body.priority === 'urgent' ? 'URGENT ' : ''}stock request ${reqNumber} from ${branch} needs approval.`, path: 'branch-request-detail.html?id=' + id });
    res.status(201).json({ success: true, request_id: id, request_number: reqNumber, status: 'pending' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Create branch request failed:', err);
    fail(res, 500, 'Could not save branch request');
  } finally {
    client.release();
  }
});

router.get('/', requirePermission(KEYS.BRANCH_REQUEST_VIEW), async (req, res) => {
  try {
    const clauses = [];
    const params = [];
    if (req.query.status) { params.push(req.query.status); clauses.push(`status = $${params.length}`); }
    // Only the branches this person is assigned to (everyone, when they are not limited to any).
    const scope = branchScope(req.access, KEYS.BRANCH_REQUEST_VIEW);
    if (scope !== null) {
      if (scope.length === 0) clauses.push('FALSE');
      else { params.push(scope); clauses.push(`branch = ANY($${params.length})`); }
    }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    const result = await pool.query(
      `SELECT * FROM branch_stock_requests ${where} ORDER BY id DESC`, params);
    const dl = await D.deliveryFor(pool, result.rows.map(r => r.id));
    const rows = result.rows.map(r => { const d = dl.get(r.id); return { ...r, delivery: { state: d.state, text: D.deliveryText(d), requested: d.requested, received: d.received, has_problem: d.has_problem } }; });
    res.json({ success: true, count: result.rowCount, requests: rows });
  } catch (err) {
    console.error(err);
    fail(res, 500, 'Could not load branch requests');
  }
});

router.get('/:id', requirePermission(KEYS.BRANCH_REQUEST_VIEW), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid request id');
  try {
    const r = await pool.query('SELECT * FROM branch_stock_requests WHERE id = $1', [id]);
    if (r.rowCount === 0) return fail(res, 404, 'Branch request not found');
    if (!inBranchScope(branchScope(req.access, KEYS.BRANCH_REQUEST_VIEW), r.rows[0].branch)) {
      return fail(res, 403, 'That request belongs to a different branch');
    }
    const items = await pool.query(
      `SELECT i.*, p.code AS product_code, p.pack_size FROM branch_request_items i LEFT JOIN products p ON p.id = i.product_id WHERE i.request_id = $1 ORDER BY i.id`, [id]);
    const po = await pool.query(
      `SELECT po.id, po.po_number FROM po_source_links l
         JOIN purchase_orders po ON po.id = l.po_id
        WHERE l.source_type = 'branch' AND l.source_id = $1`, [id]);
    const dl = (await D.deliveryFor(pool, [id])).get(id);
    const receipts = await pool.query(
      `SELECT r.id, r.received_by_name AS by, r.received_at AS at, r.note, r.is_final,
              COALESCE(json_agg(json_build_object('item_id', ri.request_item_id, 'qty', ri.qty::float, 'damaged_qty', ri.damaged_qty::float) ORDER BY ri.id) FILTER (WHERE ri.id IS NOT NULL), '[]') AS lines
         FROM branch_receipts r LEFT JOIN branch_receipt_items ri ON ri.receipt_id = r.id WHERE r.request_id = $1 GROUP BY r.id ORDER BY r.id`, [id]);
    const confirmScope = branchScope(req.access, KEYS.BRANCH_REQUEST_CONFIRM);
    const canConfirm = can(req.access, KEYS.BRANCH_REQUEST_CONFIRM) && inBranchScope(confirmScope, r.rows[0].branch) && D.canStillConfirm(r.rows[0].status, dl.state);
    res.json({ success: true, request: r.rows[0], items: items.rows, linked_pos: po.rows,
      delivery: { state: dl.state, text: D.deliveryText(dl), requested: dl.requested, received: dl.received, damaged: dl.damaged, has_problem: dl.has_problem, lines: dl.lines, receipts: receipts.rows, can_confirm: canConfirm } });
  } catch (err) {
    console.error(err);
    fail(res, 500, 'Could not load branch request');
  }
});

// ------------------------------------------------------------
// POST /api/branch-request/:id/receipts - the branch confirms what arrived
// body: { items: [{ item_id, qty, damaged_qty }], note, final }   (final = "nothing more is coming")
// Quantities are checked against what is still expected, in one transaction with the request locked, so two confirmations at once
// can never receive more than was requested. Nothing on the request itself is changed.
// ------------------------------------------------------------
router.post('/:id/receipts', requirePermission(KEYS.BRANCH_REQUEST_CONFIRM), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid request id');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = (await client.query('SELECT id, status, branch, request_number FROM branch_stock_requests WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!r) { await client.query('ROLLBACK'); return fail(res, 404, 'Branch request not found'); }
    if (!inBranchScope(branchScope(req.access, KEYS.BRANCH_REQUEST_CONFIRM), r.branch)) { await client.query('ROLLBACK'); return fail(res, 403, 'That request belongs to a different branch'); }
    if (!D.CONFIRMABLE_STATUS.includes(r.status)) { await client.query('ROLLBACK'); return fail(res, 409, r.status === 'pending' ? 'This request has not been approved yet, so nothing can have arrived.' : 'This request was not approved, so there is nothing to confirm.'); }
    const now = (await client.query(
      `SELECT i.id, i.item_name, i.quantity::float AS quantity, COALESCE((SELECT SUM(ri.qty) FROM branch_receipt_items ri WHERE ri.request_item_id = i.id), 0)::float AS received
         FROM branch_request_items i WHERE i.request_id = $1 ORDER BY i.id`, [id])).rows;
    const before = (await D.deliveryFor(client, [id])).get(id);
    if (!D.canStillConfirm(r.status, before.state)) { await client.query('ROLLBACK'); return fail(res, 409, before.state === 'complete' ? 'Everything on this request has already been confirmed as received.' : 'This request was already closed.'); }
    const v = D.validateReceipt(req.body, now);
    if (v.error) { await client.query('ROLLBACK'); return fail(res, 400, v.error); }
    const rec = (await client.query('INSERT INTO branch_receipts (request_id, received_by, received_by_name, note, is_final) VALUES ($1,$2,$3,$4,$5) RETURNING id', [id, req.user.id, req.user.name, v.note || null, v.final])).rows[0];
    for (const l of v.lines) await client.query('INSERT INTO branch_receipt_items (receipt_id, request_item_id, qty, damaged_qty) VALUES ($1,$2,$3,$4)', [rec.id, l.item_id, l.qty, l.damaged_qty]);
    const after = (await D.deliveryFor(client, [id])).get(id);
    await audit(client, req, { action: 'request.delivery', entity: 'branch_request', id, summary: `${r.request_number} (${r.branch}): ${D.deliveryText(after)}${v.lines.some(l => l.damaged_qty > 0) ? ', damage reported' : ''}${v.final && after.state !== 'complete' ? ', branch says nothing more is coming' : ''}`,
      before: { state: before.state, received: before.received }, after: { state: after.state, received: after.received, damaged: after.damaged }, reason: v.note || undefined });
    await client.query('COMMIT');
    if (after.has_problem) {
      notify({ roles: ['manager', 'purchase'], subject: 'Branch reports a delivery problem', text: `${r.branch} confirmed delivery for ${r.request_number}: ${D.deliveryText(after)}${after.damaged > 0 ? ', ' + after.damaged + ' damaged' : ''}.${v.note ? ' Note: ' + v.note : ''}`, path: 'branch-request-detail.html?id=' + id });
    }
    res.status(201).json({ success: true, receipt_id: rec.id, state: after.state, text: D.deliveryText(after) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('branch receipt failed:', err); fail(res, 500, 'Could not save the confirmation. Nothing was saved.');
  } finally { client.release(); }
});

router.put('/:id/approve', requirePermission(KEYS.BRANCH_REQUEST_APPROVE), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid request id');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query('SELECT status, request_number, branch FROM branch_stock_requests WHERE id = $1 FOR UPDATE', [id]);
    if (cur.rowCount === 0) { await client.query('ROLLBACK'); return fail(res, 404, 'Branch request not found'); }
    if (!inBranchScope(branchScope(req.access, KEYS.BRANCH_REQUEST_APPROVE), cur.rows[0].branch)) {
      await client.query('ROLLBACK');
      return fail(res, 403, 'That request belongs to a branch you are not assigned to');
    }
    if (cur.rows[0].status !== 'pending') {
      await client.query('ROLLBACK');
      return fail(res, 400, `Only "pending" requests can be approved (this one is "${cur.rows[0].status}")`);
    }
    await client.query("UPDATE branch_stock_requests SET status = 'approved' WHERE id = $1", [id]);
    await audit(client, req, { action: 'request.approve', entity: 'branch_request', id, summary: `${cur.rows[0].request_number} approved`, before: { status: 'pending' }, after: { status: 'approved' } });
    await client.query('COMMIT');
    notify({ roles: ['branch', 'purchase', 'production'], branch: cur.rows[0].branch, subject: 'Request approved', text: `Stock request ${cur.rows[0].request_number} (${cur.rows[0].branch}) was approved. Production: open Material planning to see the raw materials needed.`, path: 'material-plan.html?id=' + id });
    res.json({ success: true, request_id: id, status: 'approved' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    fail(res, 500, 'Could not approve request');
  } finally { client.release(); }
});

router.delete('/:id', requirePermission(KEYS.BRANCH_REQUEST_DELETE), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid request id');
  try {
    const cur = await pool.query('SELECT status, branch, request_number FROM branch_stock_requests WHERE id = $1', [id]);
    if (cur.rowCount === 0) return fail(res, 404, 'Branch request not found');
    if (!inBranchScope(branchScope(req.access, KEYS.BRANCH_REQUEST_DELETE), cur.rows[0].branch)) {
      return fail(res, 403, 'That request belongs to a different branch');
    }
    if (cur.rows[0].status !== 'pending') {
      return fail(res, 400, 'Only "pending" requests can be deleted');
    }
    await pool.query('DELETE FROM branch_stock_requests WHERE id = $1', [id]); // items cascade
    await audit(pool, req, { action: 'request.delete', entity: 'branch_request', id, summary: `${cur.rows[0].request_number} deleted while pending`, before: { status: 'pending', branch: cur.rows[0].branch } });
    res.json({ success: true, deleted_request_id: id });
  } catch (err) {
    console.error(err);
    fail(res, 500, 'Could not delete request');
  }
});

module.exports = router;
