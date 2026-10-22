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
  // A branch login can only ever raise a request for its OWN branch, whatever the form sends.
  const branch = req.user.role === 'branch' ? req.user.branch : req.body.branch;
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
    // A branch login only ever sees its own branch's requests.
    if (req.user.role === 'branch') { params.push(req.user.branch); clauses.push(`branch = $${params.length}`); }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    const result = await pool.query(
      `SELECT * FROM branch_stock_requests ${where} ORDER BY id DESC`, params);
    res.json({ success: true, count: result.rowCount, requests: result.rows });
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
    if (req.user.role === 'branch' && r.rows[0].branch !== req.user.branch) {
      return fail(res, 403, 'That request belongs to a different branch');
    }
    const items = await pool.query(
      `SELECT i.*, p.code AS product_code, p.pack_size FROM branch_request_items i LEFT JOIN products p ON p.id = i.product_id WHERE i.request_id = $1 ORDER BY i.id`, [id]);
    const po = await pool.query(
      `SELECT po.id, po.po_number FROM po_source_links l
         JOIN purchase_orders po ON po.id = l.po_id
        WHERE l.source_type = 'branch' AND l.source_id = $1`, [id]);
    res.json({ success: true, request: r.rows[0], items: items.rows, linked_pos: po.rows });
  } catch (err) {
    console.error(err);
    fail(res, 500, 'Could not load branch request');
  }
});

router.put('/:id/approve', requirePermission(KEYS.BRANCH_REQUEST_APPROVE), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid request id');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query('SELECT status, request_number, branch FROM branch_stock_requests WHERE id = $1 FOR UPDATE', [id]);
    if (cur.rowCount === 0) { await client.query('ROLLBACK'); return fail(res, 404, 'Branch request not found'); }
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
    if (req.user.role === 'branch' && cur.rows[0].branch !== req.user.branch) {
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
