// routes/bom.js - Bill of Materials + material planning for branch requests.
//   GET    /api/bom/product-names        product names for pick-lists (any signed-in user)
//   GET    /api/bom/products             recipes overview
//   GET    /api/bom/products/:id         one recipe with its materials
//   GET    /api/bom/materials            all raw materials
//   POST   /api/bom/products             (admin) add a product
//   POST   /api/bom/materials            (admin) add a raw material
//   PUT    /api/bom/materials/:id        (admin) rename / change unit
//   PUT    /api/bom/lines                (admin) set qty of a material in a recipe (adds it if new)
//   DELETE /api/bom/lines/:id            (admin) remove a material from a recipe
//   GET    /api/bom/plan                 approved branch requests waiting to be planned
//   GET    /api/bom/plan/:requestId      raw materials needed for one request
//   POST   /api/bom/plan/:requestId/draft-indent   turn that need into a production indent

const express = require('express');
const { pool } = require('../database');
const { notify } = require('../notify');
const { fail, todayISO, stamp, nextNumber } = require('../utils');
const { requirePermission, requireRole } = require('../auth');
const { KEYS } = require('../permissions');
const router = express.Router();

const round6 = (n) => Number(n.toFixed(6));
const idOf = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

router.get('/product-names', async (req, res) => {
  try {
    const r = await pool.query('SELECT id, name FROM products WHERE active ORDER BY name');
    res.json({ success: true, products: r.rows });
  } catch (err) { console.error(err); fail(res, 500, 'Could not load products'); }
});

router.get('/products', requirePermission(KEYS.PRODUCTION_INDENT_VIEW), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT p.id, p.name, p.active, COUNT(l.id)::int AS materials
         FROM products p LEFT JOIN bom_lines l ON l.product_id = p.id
        GROUP BY p.id ORDER BY p.name`);
    res.json({ success: true, products: r.rows });
  } catch (err) { console.error(err); fail(res, 500, 'Could not load recipes'); }
});

router.get('/products/:id', requirePermission(KEYS.PRODUCTION_INDENT_VIEW), async (req, res) => {
  const id = idOf(req.params.id);
  if (!id) return fail(res, 400, 'Invalid product id');
  try {
    const p = await pool.query('SELECT id, name FROM products WHERE id = $1', [id]);
    if (p.rowCount === 0) return fail(res, 404, 'Product not found');
    const lines = await pool.query(
      `SELECT l.id, l.qty_per_unit::float AS qty_per_unit, m.id AS material_id, m.code, m.name, m.unit
         FROM bom_lines l JOIN raw_materials m ON m.id = l.material_id
        WHERE l.product_id = $1 ORDER BY m.name`, [id]);
    res.json({ success: true, product: p.rows[0], lines: lines.rows });
  } catch (err) { console.error(err); fail(res, 500, 'Could not load recipe'); }
});

router.get('/materials', requirePermission(KEYS.PRODUCTION_INDENT_VIEW), async (req, res) => {
  try {
    const r = await pool.query('SELECT id, code, name, unit FROM raw_materials ORDER BY name');
    res.json({ success: true, materials: r.rows });
  } catch (err) { console.error(err); fail(res, 500, 'Could not load materials'); }
});

// ---------- recipe editing: admin only ----------
router.post('/products', requireRole('admin'), async (req, res) => {
  const name = req.body && String(req.body.name || '').trim();
  if (!name) return fail(res, 400, 'Product name is required');
  try {
    const r = await pool.query('INSERT INTO products (name) VALUES ($1) RETURNING id', [name]);
    res.status(201).json({ success: true, product_id: r.rows[0].id });
  } catch (err) {
    if (err.code === '23505') return fail(res, 400, 'A product with that name already exists');
    console.error(err); fail(res, 500, 'Could not add product');
  }
});

router.post('/materials', requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  const code = String(b.code || '').trim(), name = String(b.name || '').trim(), unit = String(b.unit || 'Kg').trim();
  if (!code || !name) return fail(res, 400, 'Material code and name are required');
  try {
    const r = await pool.query('INSERT INTO raw_materials (code, name, unit) VALUES ($1,$2,$3) RETURNING id', [code, name, unit]);
    res.status(201).json({ success: true, material_id: r.rows[0].id });
  } catch (err) {
    if (err.code === '23505') return fail(res, 400, 'That material code already exists');
    console.error(err); fail(res, 500, 'Could not add material');
  }
});

router.put('/materials/:id', requireRole('admin'), async (req, res) => {
  const id = idOf(req.params.id); const b = req.body || {};
  if (!id) return fail(res, 400, 'Invalid material id');
  const name = b.name ? String(b.name).trim() : null, unit = b.unit ? String(b.unit).trim() : null;
  if (!name && !unit) return fail(res, 400, 'Nothing to change');
  try {
    const r = await pool.query('UPDATE raw_materials SET name = COALESCE($1, name), unit = COALESCE($2, unit) WHERE id = $3 RETURNING id', [name, unit, id]);
    if (r.rowCount === 0) return fail(res, 404, 'Material not found');
    res.json({ success: true });
  } catch (err) { console.error(err); fail(res, 500, 'Could not update material'); }
});

router.put('/lines', requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  const product_id = idOf(b.product_id), material_id = idOf(b.material_id), qty = Number(b.qty_per_unit);
  if (!product_id || !material_id) return fail(res, 400, 'Product and material are required');
  if (!isFinite(qty) || qty <= 0) return fail(res, 400, 'Quantity per unit must be greater than 0');
  try {
    await pool.query(
      `INSERT INTO bom_lines (product_id, material_id, qty_per_unit) VALUES ($1,$2,$3)
       ON CONFLICT (product_id, material_id) DO UPDATE SET qty_per_unit = EXCLUDED.qty_per_unit`,
      [product_id, material_id, qty]);
    res.json({ success: true });
  } catch (err) {
    if (err.code === '23503') return fail(res, 400, 'Unknown product or material');
    console.error(err); fail(res, 500, 'Could not save recipe line');
  }
});

router.delete('/lines/:id', requireRole('admin'), async (req, res) => {
  const id = idOf(req.params.id);
  if (!id) return fail(res, 400, 'Invalid line id');
  try {
    const r = await pool.query('DELETE FROM bom_lines WHERE id = $1', [id]);
    if (r.rowCount === 0) return fail(res, 404, 'Recipe line not found');
    res.json({ success: true });
  } catch (err) { console.error(err); fail(res, 500, 'Could not remove recipe line'); }
});

// ---------- material planning ----------
router.get('/plan', requirePermission(KEYS.PRODUCTION_INDENT_VIEW), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT b.id, b.request_number, b.branch, b.priority, b.delivery_needed_by, b.planned_indent_id,
              i.indent_number, (SELECT COUNT(*)::int FROM branch_request_items x WHERE x.request_id = b.id) AS items
         FROM branch_stock_requests b LEFT JOIN production_indents i ON i.id = b.planned_indent_id
        WHERE b.status IN ('approved', 'po_raised')
        ORDER BY (b.planned_indent_id IS NOT NULL), (b.priority = 'urgent') DESC, b.delivery_needed_by NULLS LAST, b.id DESC`);
    res.json({ success: true, requests: r.rows });
  } catch (err) { console.error(err); fail(res, 500, 'Could not load requests to plan'); }
});

// Works out the raw materials for a request: each item that matches a product name
// (ignoring case and extra spaces) is multiplied through that product's recipe.
async function materialsFor(db, requestId) {
  const rq = await db.query(
    `SELECT b.id, b.request_number, b.branch, b.priority, b.status, b.delivery_needed_by, b.planned_indent_id, i.indent_number
       FROM branch_stock_requests b LEFT JOIN production_indents i ON i.id = b.planned_indent_id WHERE b.id = $1`, [requestId]);
  if (rq.rowCount === 0) return null;
  const items = await db.query('SELECT item_name, quantity::float AS quantity, unit FROM branch_request_items WHERE request_id = $1 ORDER BY id', [requestId]);
  const out = { request: rq.rows[0], items: [], totals: [], unmatched: [] };
  const totals = new Map();
  for (const it of items.rows) {
    const p = await db.query('SELECT id, name FROM products WHERE active AND LOWER(TRIM(name)) = LOWER(TRIM($1))', [it.item_name]);
    if (p.rowCount === 0) { out.unmatched.push(it.item_name); out.items.push({ ...it, product: null, lines: [] }); continue; }
    const lines = await db.query(
      `SELECT m.id AS material_id, m.code, m.name, m.unit, l.qty_per_unit::float AS qty_per_unit
         FROM bom_lines l JOIN raw_materials m ON m.id = l.material_id WHERE l.product_id = $1 ORDER BY m.name`, [p.rows[0].id]);
    const detail = lines.rows.map(l => ({ ...l, needed: round6(l.qty_per_unit * it.quantity) }));
    detail.forEach(l => {
      const t = totals.get(l.material_id) || { material_id: l.material_id, code: l.code, name: l.name, unit: l.unit, qty: 0 };
      t.qty = round6(t.qty + l.needed); totals.set(l.material_id, t);
    });
    out.items.push({ ...it, product: p.rows[0].name, lines: detail });
  }
  out.totals = [...totals.values()].sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

router.get('/plan/:requestId', requirePermission(KEYS.PRODUCTION_INDENT_VIEW), async (req, res) => {
  const id = idOf(req.params.requestId);
  if (!id) return fail(res, 400, 'Invalid request id');
  try {
    const d = await materialsFor(pool, id);
    if (!d) return fail(res, 404, 'Branch request not found');
    res.json({ success: true, ...d });
  } catch (err) { console.error(err); fail(res, 500, 'Could not calculate materials'); }
});

router.post('/plan/:requestId/draft-indent', requirePermission(KEYS.PRODUCTION_INDENT_CREATE), async (req, res) => {
  const id = idOf(req.params.requestId);
  if (!id) return fail(res, 400, 'Invalid request id');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM branch_stock_requests WHERE id = $1 FOR UPDATE', [id]);
    const d = await materialsFor(client, id);
    if (!d) { await client.query('ROLLBACK'); return fail(res, 404, 'Branch request not found'); }
    if (!['approved', 'po_raised'].includes(d.request.status)) { await client.query('ROLLBACK'); return fail(res, 400, 'Only approved requests can be planned'); }
    if (d.request.planned_indent_id) { await client.query('ROLLBACK'); return fail(res, 400, `Already planned as ${d.request.indent_number}`); }
    if (d.totals.length === 0) { await client.query('ROLLBACK'); return fail(res, 400, 'None of this request\'s items has a recipe, so there is nothing to plan'); }

    const number = await nextNumber(client, 'production_indents', 'indent_number', `IND-${stamp(todayISO())}-`);
    const head = (req.user && req.user.name) || 'Production';
    const ind = await client.query(
      'INSERT INTO production_indents (indent_number, production_head, created_by) VALUES ($1,$2,$3) RETURNING id',
      [number, `${head} (for ${d.request.request_number})`.slice(0, 100), req.user.id]);
    const priority = d.request.priority === 'urgent' ? 'urgent' : 'normal';
    for (const t of d.totals) {
      const qty = Math.max(0.001, Math.ceil(round6(t.qty * 1000)) / 1000);
      await client.query(
        `INSERT INTO production_indent_items (indent_id, item_name, quantity, unit, required_by, priority)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [ind.rows[0].id, t.name, qty, t.unit, d.request.delivery_needed_by || null, priority]);
    }
    await client.query('UPDATE branch_stock_requests SET planned_indent_id = $1 WHERE id = $2', [ind.rows[0].id, id]);
    await client.query('COMMIT');
    notify({ roles: ['store'], subject: 'New production indent ' + number,
      text: `Production indent ${number} was drafted from ${d.request.request_number} and needs approval.`,
      path: 'production-indent-detail.html?id=' + ind.rows[0].id });
    res.status(201).json({ success: true, indent_id: ind.rows[0].id, indent_number: number, materials: d.totals.length, unmatched: d.unmatched });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Draft indent failed:', err); fail(res, 500, 'Could not create the indent');
  } finally { client.release(); }
});

module.exports = router;
