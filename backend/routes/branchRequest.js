// routes/branchRequest.js - Branch Stock Request APIs.
//   POST   /api/branch-request/create   branch asks HQ for stock
//   GET    /api/branch-request          list all requests (?status=pending)
//   GET    /api/branch-request/:id      one request with items and its PO (if raised)
//   PUT    /api/branch-request/:id/approve
//   DELETE /api/branch-request/:id      only while still "pending"

const express = require('express');
const { pool } = require('../database');
const { fail, isValidDate, todayISO, stamp, nextNumber } = require('../utils');
const { requirePermission } = require('../auth');
const { KEYS } = require('../permissions');
const router = express.Router();

const BRANCHES = ['Kannur', 'Thrissur', 'Trivandrum', 'Ernakulam'];

function validate(body) {
  if (!body || typeof body !== 'object') return 'Request body is missing';
  if (!BRANCHES.includes(body.branch)) return 'Branch must be one of: ' + BRANCHES.join(', ');
  if (!body.requested_by || !String(body.requested_by).trim()) return 'Requested by is required';
  if (body.delivery_needed_by && !isValidDate(body.delivery_needed_by)) {
    return 'Delivery needed by must be a valid date (YYYY-MM-DD)';
  }
  if (!Array.isArray(body.items) || body.items.length === 0) return 'Add at least one item';
  for (let i = 0; i < body.items.length; i++) {
    const it = body.items[i];
    if (!it.item_name || !String(it.item_name).trim()) return `Item ${i + 1}: name is required`;
    if (!it.unit || !String(it.unit).trim()) return `Item ${i + 1}: unit is required`;
    if (!isFinite(Number(it.quantity)) || Number(it.quantity) <= 0) {
      return `Item ${i + 1}: quantity must be greater than 0`;
    }
  }
  return null;
}

router.post('/create', requirePermission(KEYS.BRANCH_REQUEST_CREATE), async (req, res) => {
  const problem = validate(req.body);
  if (problem) return fail(res, 400, problem);
  // A branch login can only ever raise a request for its OWN branch, whatever the form sends.
  const branch = req.user.role === 'branch' ? req.user.branch : req.body.branch;
  const { requested_by, delivery_needed_by, items } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reqNumber = await nextNumber(client, 'branch_stock_requests', 'request_number', `REQ-${stamp(todayISO())}-`);
    const r = await client.query(
      `INSERT INTO branch_stock_requests (request_number, branch, requested_by, delivery_needed_by, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [reqNumber, branch, String(requested_by).trim(), delivery_needed_by || null, req.user.id]);
    const id = r.rows[0].id;
    for (const it of items) {
      await client.query(
        'INSERT INTO branch_request_items (request_id, item_name, quantity, unit) VALUES ($1,$2,$3,$4)',
        [id, String(it.item_name).trim(), Number(it.quantity), String(it.unit).trim()]);
    }
    await client.query('COMMIT');
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
    const items = await pool.query('SELECT * FROM branch_request_items WHERE request_id = $1 ORDER BY id', [id]);
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
  try {
    const cur = await pool.query('SELECT status FROM branch_stock_requests WHERE id = $1', [id]);
    if (cur.rowCount === 0) return fail(res, 404, 'Branch request not found');
    if (cur.rows[0].status !== 'pending') {
      return fail(res, 400, `Only "pending" requests can be approved (this one is "${cur.rows[0].status}")`);
    }
    await pool.query("UPDATE branch_stock_requests SET status = 'approved' WHERE id = $1", [id]);
    res.json({ success: true, request_id: id, status: 'approved' });
  } catch (err) {
    console.error(err);
    fail(res, 500, 'Could not approve request');
  }
});

router.delete('/:id', requirePermission(KEYS.BRANCH_REQUEST_DELETE), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid request id');
  try {
    const cur = await pool.query('SELECT status, branch FROM branch_stock_requests WHERE id = $1', [id]);
    if (cur.rowCount === 0) return fail(res, 404, 'Branch request not found');
    if (req.user.role === 'branch' && cur.rows[0].branch !== req.user.branch) {
      return fail(res, 403, 'That request belongs to a different branch');
    }
    if (cur.rows[0].status !== 'pending') {
      return fail(res, 400, 'Only "pending" requests can be deleted');
    }
    await pool.query('DELETE FROM branch_stock_requests WHERE id = $1', [id]); // items cascade
    res.json({ success: true, deleted_request_id: id });
  } catch (err) {
    console.error(err);
    fail(res, 500, 'Could not delete request');
  }
});

module.exports = router;
