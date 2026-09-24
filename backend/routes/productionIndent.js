// routes/productionIndent.js - Production Raw Material Indent APIs.
//   POST   /api/production-indent/create
//   GET    /api/production-indent           (?status=pending)
//   GET    /api/production-indent/:id
//   PUT    /api/production-indent/:id/approve
//   DELETE /api/production-indent/:id        only while still "pending"

const express = require('express');
const { pool } = require('../database');
const { notify } = require('../notify');
const { fail, isValidDate, todayISO, stamp, nextNumber } = require('../utils');
const { requirePermission } = require('../auth');
const { KEYS } = require('../permissions');
const router = express.Router();

const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

function validate(body) {
  if (!body || typeof body !== 'object') return 'Request body is missing';
  if (!body.production_head || !String(body.production_head).trim()) return 'Production head name is required';
  if (!Array.isArray(body.items) || body.items.length === 0) return 'Add at least one chemical';
  for (let i = 0; i < body.items.length; i++) {
    const it = body.items[i];
    if (!it.item_name || !String(it.item_name).trim()) return `Item ${i + 1}: name is required`;
    if (!it.unit || !String(it.unit).trim()) return `Item ${i + 1}: unit is required`;
    if (!isFinite(Number(it.quantity)) || Number(it.quantity) <= 0) {
      return `Item ${i + 1}: quantity must be greater than 0`;
    }
    if (it.required_by && !isValidDate(it.required_by)) return `Item ${i + 1}: required-by date is invalid`;
    if (it.priority && !PRIORITIES.includes(it.priority)) {
      return `Item ${i + 1}: priority must be one of ${PRIORITIES.join(', ')}`;
    }
  }
  return null;
}

router.post('/create', requirePermission(KEYS.PRODUCTION_INDENT_CREATE), async (req, res) => {
  const problem = validate(req.body);
  if (problem) return fail(res, 400, problem);
  const { production_head, items } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const indentNumber = await nextNumber(client, 'production_indents', 'indent_number', `IND-${stamp(todayISO())}-`);
    const r = await client.query(
      'INSERT INTO production_indents (indent_number, production_head, created_by) VALUES ($1, $2, $3) RETURNING id',
      [indentNumber, String(production_head).trim(), req.user.id]);
    const id = r.rows[0].id;
    for (const it of items) {
      await client.query(
        `INSERT INTO production_indent_items (indent_id, item_name, quantity, unit, required_by, priority)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, String(it.item_name).trim(), Number(it.quantity), String(it.unit).trim(),
         it.required_by || null, it.priority || 'normal']);
    }
    await client.query('COMMIT');
    notify({ roles: ['store'], subject: 'New production indent ' + indentNumber, text: `New production indent ${indentNumber} needs approval.`, path: 'production-indent-detail.html?id=' + id });
    res.status(201).json({ success: true, indent_id: id, indent_number: indentNumber, status: 'pending' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Create production indent failed:', err);
    fail(res, 500, 'Could not save production indent');
  } finally {
    client.release();
  }
});

router.get('/', requirePermission(KEYS.PRODUCTION_INDENT_VIEW), async (req, res) => {
  try {
    const clauses = [];
    const params = [];
    if (req.query.status) { params.push(req.query.status); clauses.push(`status = $${params.length}`); }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    const result = await pool.query(`SELECT * FROM production_indents ${where} ORDER BY id DESC`, params);
    res.json({ success: true, count: result.rowCount, indents: result.rows });
  } catch (err) {
    console.error(err);
    fail(res, 500, 'Could not load production indents');
  }
});

router.get('/:id', requirePermission(KEYS.PRODUCTION_INDENT_VIEW), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid indent id');
  try {
    const r = await pool.query('SELECT * FROM production_indents WHERE id = $1', [id]);
    if (r.rowCount === 0) return fail(res, 404, 'Production indent not found');
    const items = await pool.query('SELECT * FROM production_indent_items WHERE indent_id = $1 ORDER BY id', [id]);
    const po = await pool.query(
      `SELECT po.id, po.po_number FROM po_source_links l
         JOIN purchase_orders po ON po.id = l.po_id
        WHERE l.source_type = 'production' AND l.source_id = $1`, [id]);
    res.json({ success: true, indent: r.rows[0], items: items.rows, linked_pos: po.rows });
  } catch (err) {
    console.error(err);
    fail(res, 500, 'Could not load production indent');
  }
});

router.put('/:id/approve', requirePermission(KEYS.PRODUCTION_INDENT_APPROVE), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid indent id');
  try {
    const cur = await pool.query('SELECT status, indent_number FROM production_indents WHERE id = $1', [id]);
    if (cur.rowCount === 0) return fail(res, 404, 'Production indent not found');
    if (cur.rows[0].status !== 'pending') {
      return fail(res, 400, `Only "pending" indents can be approved (this one is "${cur.rows[0].status}")`);
    }
    await pool.query("UPDATE production_indents SET status = 'approved' WHERE id = $1", [id]);
    notify({ roles: ['production', 'purchase'], subject: 'Indent approved', text: `Production indent ${cur.rows[0].indent_number} was approved and is ready for purchase planning.`, path: 'production-indent-detail.html?id=' + id });
    res.json({ success: true, indent_id: id, status: 'approved' });
  } catch (err) {
    console.error(err);
    fail(res, 500, 'Could not approve indent');
  }
});

router.delete('/:id', requirePermission(KEYS.PRODUCTION_INDENT_DELETE), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid indent id');
  try {
    const cur = await pool.query('SELECT status FROM production_indents WHERE id = $1', [id]);
    if (cur.rowCount === 0) return fail(res, 404, 'Production indent not found');
    if (cur.rows[0].status !== 'pending') return fail(res, 400, 'Only "pending" indents can be deleted');
    await pool.query('DELETE FROM production_indents WHERE id = $1', [id]); // items cascade
    res.json({ success: true, deleted_indent_id: id });
  } catch (err) {
    console.error(err);
    fail(res, 500, 'Could not delete indent');
  }
});

module.exports = router;
