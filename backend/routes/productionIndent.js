// routes/productionIndent.js - Production Raw Material Indent APIs.
//   POST   /api/production-indent/create
//   GET    /api/production-indent           (?status=pending)
//   GET    /api/production-indent/:id
//   PUT    /api/production-indent/:id         only the person who raised it, and only while it is still "pending"
//   PUT    /api/production-indent/:id/approve
//   DELETE /api/production-indent/:id        only while still "pending"

const express = require('express');
const { pool } = require('../database');
const { notify } = require('../notify');
const { fail, isValidDate, todayISO, stamp, nextNumber } = require('../utils');
const { requirePermission } = require('../auth');
const { resolveMaterials } = require('../materials');
const { KEYS } = require('../permissions');
const { can } = require('../access');
const { audit } = require('../audit');
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
    const mats = await resolveMaterials(client, items);          // a chosen raw material brings its list name, so it is always spelt the same way
    if (mats.error) { await client.query('ROLLBACK'); return fail(res, 400, mats.error); }
    const indentNumber = await nextNumber(client, 'production_indents', 'indent_number', `IND-${stamp(todayISO())}-`);
    const r = await client.query(
      'INSERT INTO production_indents (indent_number, production_head, created_by) VALUES ($1, $2, $3) RETURNING id',
      [indentNumber, String(production_head).trim(), req.user.id]);
    const id = r.rows[0].id;
    for (const it of items) {
      await client.query(
        `INSERT INTO production_indent_items (indent_id, item_name, quantity, unit, required_by, priority)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, (it.material_id && mats.map.get(Number(it.material_id)) ? mats.map.get(Number(it.material_id)).name : String(it.item_name).trim()), Number(it.quantity), String(it.unit).trim(),
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
    // the person who raised it may change it until it is approved (nobody else, administrators included)
    const canEdit = r.rows[0].status === 'pending' && r.rows[0].created_by === req.user.id && can(req.access, KEYS.PRODUCTION_INDENT_CREATE);
    res.json({ success: true, indent: r.rows[0], items: items.rows, linked_pos: po.rows, can_edit: canEdit });
  } catch (err) {
    console.error(err);
    fail(res, 500, 'Could not load production indent');
  }
});

// ------------------------------------------------------------
// PUT /api/production-indent/:id - the person who raised it may change it, but only until it is approved.
// body: { production_head, items: [...same as create...], version }   version = the edit_count they opened it at
// The items are replaced as a whole. The approver is told, and an approver who had the old version open must reload before approving.
// ------------------------------------------------------------
router.put('/:id', requirePermission(KEYS.PRODUCTION_INDENT_CREATE), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid indent id');
  const problem = validate(req.body);
  if (problem) return fail(res, 400, problem);
  const { production_head, items } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = (await client.query('SELECT * FROM production_indents WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) { await client.query('ROLLBACK'); return fail(res, 404, 'Production indent not found'); }
    if (cur.created_by !== req.user.id) { await client.query('ROLLBACK'); return fail(res, 403, 'Only the person who raised this request can change it'); }
    if (cur.status !== 'pending') { await client.query('ROLLBACK'); return fail(res, 409, `This request is already "${cur.status}", so it can no longer be changed. Ask the approver if something is wrong.`); }
    if (req.body.version !== undefined && Number(req.body.version) !== cur.edit_count) { await client.query('ROLLBACK'); return fail(res, 409, 'This request was changed since you opened it. Reload to see the latest version.'); }
    const mats = await resolveMaterials(client, items);
    if (mats.error) { await client.query('ROLLBACK'); return fail(res, 400, mats.error); }
    const old = (await client.query('SELECT item_name, quantity::float AS quantity, unit, to_char(required_by, \'YYYY-MM-DD\') AS required_by, priority FROM production_indent_items WHERE indent_id = $1 ORDER BY id', [id])).rows;
    const fresh = items.map(it => ({ item_name: it.material_id && mats.map.get(Number(it.material_id)) ? mats.map.get(Number(it.material_id)).name : String(it.item_name).trim(), quantity: Number(it.quantity), unit: String(it.unit).trim(), required_by: it.required_by || null, priority: it.priority || 'normal' }));
    await client.query('DELETE FROM production_indent_items WHERE indent_id = $1', [id]);
    for (const it of fresh) {
      await client.query('INSERT INTO production_indent_items (indent_id, item_name, quantity, unit, required_by, priority) VALUES ($1,$2,$3,$4,$5,$6)', [id, it.item_name, it.quantity, it.unit, it.required_by, it.priority]);
    }
    const up = (await client.query('UPDATE production_indents SET production_head = $1, edit_count = edit_count + 1, edited_at = NOW() WHERE id = $2 RETURNING edit_count', [String(production_head).trim(), id])).rows[0];
    await audit(client, req, { action: 'indent.edit', entity: 'production_indent', id, summary: `${cur.indent_number} changed by its requester before approval (${old.length} item${old.length === 1 ? '' : 's'} before, ${fresh.length} after)`,
      before: { production_head: cur.production_head, items: old }, after: { production_head: String(production_head).trim(), items: fresh } });
    await client.query('COMMIT');
    notify({ roles: ['store'], subject: 'Production request changed: ' + cur.indent_number, text: `${req.user.name} changed production request ${cur.indent_number} before approval. Please look at it again before approving.`, path: 'production-indent-detail.html?id=' + id });
    res.json({ success: true, indent_id: id, edit_count: up.edit_count });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Edit production indent failed:', err);
    fail(res, 500, 'Could not save the changes. Nothing was changed.');
  } finally { client.release(); }
});

router.put('/:id/approve', requirePermission(KEYS.PRODUCTION_INDENT_APPROVE), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid indent id');
  try {
    const seen = req.body && req.body.version !== undefined && req.body.version !== null ? Number(req.body.version) : null;     // the version the approver was looking at
    const cur = await pool.query('SELECT status, indent_number, edit_count FROM production_indents WHERE id = $1', [id]);
    if (cur.rowCount === 0) return fail(res, 404, 'Production indent not found');
    if (cur.rows[0].status !== 'pending') {
      return fail(res, 400, `Only "pending" indents can be approved (this one is "${cur.rows[0].status}")`);
    }
    if (seen !== null && seen !== cur.rows[0].edit_count) return fail(res, 409, 'The person who raised this request changed it after you opened it. Reload to see the new version, then approve it.');
    // one statement: it only approves the version that was seen, and only while it is still pending (an edit and an approval at the same moment cannot both win)
    const up = await pool.query("UPDATE production_indents SET status = 'approved' WHERE id = $1 AND status = 'pending' AND ($2::int IS NULL OR edit_count = $2) RETURNING id", [id, seen]);
    if (!up.rowCount) return fail(res, 409, 'This request was changed or decided at the same moment. Reload and look again.');
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
