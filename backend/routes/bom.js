// routes/bom.js - recipes (Bill of Materials) and material planning for branch requests.
//
//   GET    /api/bom/products                 recipes overview (one row per finished product)
//   GET    /api/bom/products/:id             the active recipe + its materials + version history
//   GET    /api/bom/materials                raw materials & packaging
//   POST   /api/bom/products                 (admin) add a finished product  [same as /api/catalog/products]
//   POST   /api/bom/materials                (admin) add a material
//   PUT    /api/bom/materials/:id            (admin) rename / change unit / category
//   PUT    /api/bom/lines                    (admin) set a material's quantity in a product's recipe
//   DELETE /api/bom/lines/:id                (admin) remove a material from the recipe
//   PUT    /api/bom/recipes/:productId       (admin) recipe settings: output qty, wastage, effective date
//   GET    /api/bom/plan                     approved branch requests and their planning state
//   GET    /api/bom/plan/:requestId          material requirement for one request (may be BLOCKED)
//   POST   /api/bom/plan/:requestId/draft-indent   create the production indent (refused while blocked)
//
// Recipes belong to a product ID and are versioned. A recipe that an approved plan has used is never edited
// in place: the first change creates a new version, so old plans keep the exact figures they were based on.

const express = require('express');
const { pool } = require('../database');
const { notify } = require('../notify');
const { audit } = require('../audit');
const { calcMaterials } = require('../planning');
const { createProduct } = require('./catalog');
const { fail, todayISO, stamp, nextNumber } = require('../utils');
const { requirePermission, requireRole } = require('../auth');
const { KEYS } = require('../permissions');
const router = express.Router();

const idOf = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

/** The recipe in force for a product today: the newest active version whose start date has arrived. */
async function activeRecipe(db, productId) {
  const r = await db.query(
    `SELECT id, version, effective_from, base_output_qty::float AS base_output_qty, base_output_unit, wastage_included, wastage_pct::float AS wastage_pct
       FROM recipe_versions WHERE product_id = $1 AND status = 'active' AND effective_from <= CURRENT_DATE
      ORDER BY version DESC LIMIT 1`, [productId]);
  return r.rows[0] || null;
}

async function recipeLines(db, recipeId) {
  const r = await db.query(
    `SELECT l.id, l.qty_per_unit::float AS qty_per_unit, m.id AS material_id, m.code, m.name, m.unit, m.category
       FROM bom_lines l JOIN raw_materials m ON m.id = l.material_id WHERE l.recipe_id = $1 ORDER BY m.name`, [recipeId]);
  return r.rows;
}

/**
 * The recipe an edit should be applied to. No recipe yet -> version 1. Active recipe already used by a plan ->
 * a new version (copy) that supersedes it. Otherwise the active version is edited in place.
 */
async function editableRecipe(db, productId, req) {
  const cur = await db.query(
    `SELECT id, version, base_output_qty, base_output_unit, wastage_included, wastage_pct
       FROM recipe_versions WHERE product_id = $1 AND status = 'active' ORDER BY version DESC LIMIT 1 FOR UPDATE`, [productId]);
  if (cur.rowCount === 0) {
    const maxV = await db.query('SELECT COALESCE(MAX(version), 0) AS v FROM recipe_versions WHERE product_id = $1', [productId]);
    const n = await db.query('INSERT INTO recipe_versions (product_id, version, created_by) VALUES ($1,$2,$3) RETURNING id, version',
      [productId, maxV.rows[0].v + 1, req.user.id]);
    return { id: n.rows[0].id, version: n.rows[0].version, created: true };
  }
  const used = await db.query(
    `SELECT 1 FROM material_plans mp WHERE jsonb_path_exists(mp.inputs, '$.items[*] ? (@.recipe_id == $rid)', jsonb_build_object('rid', $1::int)) LIMIT 1`, [cur.rows[0].id]);
  if (used.rowCount === 0) return { id: cur.rows[0].id, version: cur.rows[0].version, created: false };
  const c = cur.rows[0];
  await db.query("UPDATE recipe_versions SET status = 'retired' WHERE id = $1", [c.id]);
  const n = await db.query(
    `INSERT INTO recipe_versions (product_id, version, base_output_qty, base_output_unit, wastage_included, wastage_pct, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, version`,
    [productId, c.version + 1, c.base_output_qty, c.base_output_unit, c.wastage_included, c.wastage_pct, req.user.id]);
  await db.query('INSERT INTO bom_lines (product_id, material_id, qty_per_unit, recipe_id) SELECT product_id, material_id, qty_per_unit, $1 FROM bom_lines WHERE recipe_id = $2', [n.rows[0].id, c.id]);
  return { id: n.rows[0].id, version: n.rows[0].version, created: true, from_version: c.version };
}

router.get('/products', requirePermission(KEYS.PRODUCTION_INDENT_VIEW), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT p.id, p.code, p.name, p.active, v.version, COALESCE(c.n, 0)::int AS materials
         FROM products p
         LEFT JOIN LATERAL (SELECT id, version FROM recipe_versions WHERE product_id = p.id AND status = 'active' AND effective_from <= CURRENT_DATE ORDER BY version DESC LIMIT 1) v ON true
         LEFT JOIN LATERAL (SELECT COUNT(*) AS n FROM bom_lines WHERE recipe_id = v.id) c ON true
        ORDER BY p.name`);
    res.json({ success: true, products: r.rows });
  } catch (err) { console.error(err); fail(res, 500, 'Could not load recipes'); }
});

router.get('/products/:id', requirePermission(KEYS.PRODUCTION_INDENT_VIEW), async (req, res) => {
  const id = idOf(req.params.id);
  if (!id) return fail(res, 400, 'Invalid product id');
  try {
    const p = await pool.query('SELECT id, code, name FROM products WHERE id = $1', [id]);
    if (p.rowCount === 0) return fail(res, 404, 'Product not found');
    const recipe = await activeRecipe(pool, id);
    const versions = await pool.query('SELECT version, status, effective_from FROM recipe_versions WHERE product_id = $1 ORDER BY version DESC', [id]);
    res.json({ success: true, product: p.rows[0], recipe, lines: recipe ? await recipeLines(pool, recipe.id) : [], versions: versions.rows });
  } catch (err) { console.error(err); fail(res, 500, 'Could not load recipe'); }
});

router.get('/materials', requirePermission(KEYS.PRODUCTION_INDENT_VIEW), async (req, res) => {
  try {
    const r = await pool.query('SELECT id, code, name, unit, category, active FROM raw_materials ORDER BY name');
    res.json({ success: true, materials: r.rows });
  } catch (err) { console.error(err); fail(res, 500, 'Could not load materials'); }
});

// ---------- recipe editing: admin only ----------
router.post('/products', requireRole('admin'), async (req, res) => {
  const name = req.body && String(req.body.name || '').trim();
  if (!name) return fail(res, 400, 'Product name is required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = await createProduct(client, { name });
    await audit(client, req, { action: 'product.create', entity: 'product', id, summary: `Added product ${name}` });
    await client.query('COMMIT');
    res.status(201).json({ success: true, product_id: id });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return fail(res, 400, 'A product with that name already exists');
    console.error(err); fail(res, 500, 'Could not add product');
  } finally { client.release(); }
});

router.post('/materials', requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  const code = String(b.code || '').trim(), name = String(b.name || '').trim(), unit = String(b.unit || 'Kg').trim();
  const category = b.category ? String(b.category).trim() : (unit === 'Nos' ? 'Packaging' : 'Raw material');
  if (!code || !name) return fail(res, 400, 'Material code and name are required');
  try {
    const r = await pool.query('INSERT INTO raw_materials (code, name, unit, category) VALUES ($1,$2,$3,$4) RETURNING id', [code, name, unit, category]);
    await audit(pool, req, { action: 'material.create', entity: 'material', id: r.rows[0].id, summary: `Added material ${code} ${name} (${unit})` });
    res.status(201).json({ success: true, material_id: r.rows[0].id });
  } catch (err) {
    if (err.code === '23505') return fail(res, 400, 'That material code already exists');
    console.error(err); fail(res, 500, 'Could not add material');
  }
});

router.put('/materials/:id', requireRole('admin'), async (req, res) => {
  const id = idOf(req.params.id); const b = req.body || {};
  if (!id) return fail(res, 400, 'Invalid material id');
  const name = b.name ? String(b.name).trim() : null, unit = b.unit ? String(b.unit).trim() : null, category = b.category ? String(b.category).trim() : null;
  if (!name && !unit && !category) return fail(res, 400, 'Nothing to change');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query('SELECT name, unit, category FROM raw_materials WHERE id = $1 FOR UPDATE', [id]);
    if (cur.rowCount === 0) { await client.query('ROLLBACK'); return fail(res, 404, 'Material not found'); }
    await client.query('UPDATE raw_materials SET name = COALESCE($1, name), unit = COALESCE($2, unit), category = COALESCE($3, category) WHERE id = $4', [name, unit, category, id]);
    await audit(client, req, { action: 'material.update', entity: 'material', id, summary: `Updated material ${cur.rows[0].name}`, before: cur.rows[0], after: { name, unit, category } });
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); console.error(err); fail(res, 500, 'Could not update material'); }
  finally { client.release(); }
});

router.put('/lines', requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  const product_id = idOf(b.product_id), material_id = idOf(b.material_id), qty = Number(b.qty_per_unit);
  if (!product_id || !material_id) return fail(res, 400, 'Product and material are required');
  if (!isFinite(qty) || qty <= 0) return fail(res, 400, 'Quantity per unit must be greater than 0');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const p = await client.query('SELECT name FROM products WHERE id = $1', [product_id]);
    const m = await client.query('SELECT name FROM raw_materials WHERE id = $1', [material_id]);
    if (p.rowCount === 0 || m.rowCount === 0) { await client.query('ROLLBACK'); return fail(res, 400, 'Unknown product or material'); }
    const rec = await editableRecipe(client, product_id, req);
    const old = await client.query('SELECT qty_per_unit::float AS q FROM bom_lines WHERE recipe_id = $1 AND material_id = $2', [rec.id, material_id]);
    await client.query(
      `INSERT INTO bom_lines (product_id, material_id, qty_per_unit, recipe_id) VALUES ($1,$2,$3,$4)
       ON CONFLICT (recipe_id, material_id) DO UPDATE SET qty_per_unit = EXCLUDED.qty_per_unit`, [product_id, material_id, qty, rec.id]);
    await audit(client, req, {
      action: 'recipe.line_set', entity: 'product', id: product_id,
      summary: `${p.rows[0].name} v${rec.version}: ${m.rows[0].name} = ${qty}` + (rec.created && rec.from_version ? ` (new version, was v${rec.from_version})` : ''),
      before: old.rowCount ? { qty_per_unit: old.rows[0].q } : null, after: { qty_per_unit: qty }
    });
    await client.query('COMMIT');
    res.json({ success: true, version: rec.version, new_version: !!(rec.created && rec.from_version) });
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); console.error(err); fail(res, 500, 'Could not save recipe line'); }
  finally { client.release(); }
});

router.delete('/lines/:id', requireRole('admin'), async (req, res) => {
  const id = idOf(req.params.id);
  if (!id) return fail(res, 400, 'Invalid line id');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ln = await client.query(
      `SELECT l.material_id, l.qty_per_unit::float AS q, v.product_id, p.name AS product, m.name AS material
         FROM bom_lines l JOIN recipe_versions v ON v.id = l.recipe_id JOIN products p ON p.id = v.product_id JOIN raw_materials m ON m.id = l.material_id WHERE l.id = $1`, [id]);
    if (ln.rowCount === 0) { await client.query('ROLLBACK'); return fail(res, 404, 'Recipe line not found'); }
    const rec = await editableRecipe(client, ln.rows[0].product_id, req);
    await client.query('DELETE FROM bom_lines WHERE recipe_id = $1 AND material_id = $2', [rec.id, ln.rows[0].material_id]);
    await audit(client, req, { action: 'recipe.line_remove', entity: 'product', id: ln.rows[0].product_id, summary: `${ln.rows[0].product} v${rec.version}: removed ${ln.rows[0].material}`, before: { qty_per_unit: ln.rows[0].q } });
    await client.query('COMMIT');
    res.json({ success: true, version: rec.version });
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); console.error(err); fail(res, 500, 'Could not remove recipe line'); }
  finally { client.release(); }
});

router.put('/recipes/:productId', requireRole('admin'), async (req, res) => {
  const productId = idOf(req.params.productId), b = req.body || {};
  if (!productId) return fail(res, 400, 'Invalid product id');
  const out = b.base_output_qty === undefined ? null : Number(b.base_output_qty);
  const pct = b.wastage_pct === undefined ? null : Number(b.wastage_pct);
  if (out !== null && (!isFinite(out) || out <= 0)) return fail(res, 400, 'Output quantity must be greater than 0');
  if (pct !== null && (!isFinite(pct) || pct < 0)) return fail(res, 400, 'Wastage cannot be negative');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rec = await editableRecipe(client, productId, req);
    const before = (await client.query('SELECT base_output_qty::float AS base_output_qty, wastage_included, wastage_pct::float AS wastage_pct, effective_from FROM recipe_versions WHERE id = $1', [rec.id])).rows[0];
    await client.query(
      `UPDATE recipe_versions SET base_output_qty = COALESCE($1, base_output_qty), wastage_included = COALESCE($2, wastage_included),
              wastage_pct = COALESCE($3, wastage_pct), effective_from = COALESCE($4, effective_from) WHERE id = $5`,
      [out, b.wastage_included === undefined ? null : !!b.wastage_included, pct, b.effective_from || null, rec.id]);
    await audit(client, req, { action: 'recipe.settings', entity: 'product', id: productId, summary: `Recipe v${rec.version} settings changed`, before, after: b });
    await client.query('COMMIT');
    res.json({ success: true, version: rec.version });
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); console.error(err); fail(res, 500, 'Could not save recipe settings'); }
  finally { client.release(); }
});

// ---------- material planning ----------
router.get('/plan', requirePermission(KEYS.PRODUCTION_INDENT_VIEW), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT b.id, b.request_number, b.branch, b.priority, b.delivery_needed_by, b.planned_indent_id, i.indent_number,
              (SELECT COUNT(*)::int FROM branch_request_items x WHERE x.request_id = b.id) AS items,
              (SELECT COUNT(*)::int FROM branch_request_items x WHERE x.request_id = b.id AND x.product_id IS NULL) AS unlinked
         FROM branch_stock_requests b LEFT JOIN production_indents i ON i.id = b.planned_indent_id
        WHERE b.status = 'approved' OR b.planned_indent_id IS NOT NULL
        ORDER BY (b.planned_indent_id IS NOT NULL), (b.priority = 'urgent') DESC, b.delivery_needed_by NULLS LAST, b.id DESC`);
    res.json({ success: true, requests: r.rows });
  } catch (err) { console.error(err); fail(res, 500, 'Could not load requests to plan'); }
});

async function planFor(db, requestId) {
  const rq = await db.query(
    `SELECT b.id, b.request_number, b.branch, b.priority, b.status, b.delivery_needed_by, b.planned_indent_id, i.indent_number
       FROM branch_stock_requests b LEFT JOIN production_indents i ON i.id = b.planned_indent_id WHERE b.id = $1`, [requestId]);
  if (rq.rowCount === 0) return null;
  const rows = await db.query(
    `SELECT i.id AS item_id, i.item_name, i.quantity::float AS quantity, i.product_id, p.name AS product_name
       FROM branch_request_items i LEFT JOIN products p ON p.id = i.product_id WHERE i.request_id = $1 ORDER BY i.id`, [requestId]);
  const items = [];
  for (const it of rows.rows) {
    let recipe = null;
    if (it.product_id) {
      const a = await activeRecipe(db, it.product_id);
      if (a) recipe = { ...a, lines: await recipeLines(db, a.id) };
    }
    items.push({ ...it, recipe });
  }
  return { request: rq.rows[0], ...calcMaterials(items) };
}

router.get('/plan/:requestId', requirePermission(KEYS.PRODUCTION_INDENT_VIEW), async (req, res) => {
  const id = idOf(req.params.requestId);
  if (!id) return fail(res, 400, 'Invalid request id');
  try {
    const d = await planFor(pool, id);
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
    const d = await planFor(client, id);
    if (!d) { await client.query('ROLLBACK'); return fail(res, 404, 'Branch request not found'); }
    if (d.request.planned_indent_id) { await client.query('ROLLBACK'); return fail(res, 400, `Already planned as ${d.request.indent_number}`); }
    if (d.request.status === 'po_raised') { await client.query('ROLLBACK'); return fail(res, 400, 'This request is already part of a purchase order, so planning it again would buy the same stock twice.'); }
    if (d.request.status !== 'approved') { await client.query('ROLLBACK'); return fail(res, 400, 'Only approved requests can be planned'); }
    if (!d.complete) {
      await client.query('ROLLBACK');
      const names = d.blocked.map(b => `${b.item_name} (${b.reason_text.toLowerCase()})`).join('; ');
      return fail(res, 409, 'Planning blocked: ' + (names || 'no materials could be calculated') + '. Fix these first.');
    }
    const number = await nextNumber(client, 'production_indents', 'indent_number', `IND-${stamp(todayISO())}-`);
    const head = req.user.name || 'Production';
    const ind = await client.query(
      'INSERT INTO production_indents (indent_number, production_head, created_by) VALUES ($1,$2,$3) RETURNING id',
      [number, `${head} (for ${d.request.request_number})`.slice(0, 100), req.user.id]);
    const priority = d.request.priority === 'urgent' ? 'urgent' : 'normal';
    for (const t of d.totals) {
      const qty = Math.max(0.001, Math.ceil(Number((t.qty * 1000).toFixed(6))) / 1000);
      await client.query(
        `INSERT INTO production_indent_items (indent_id, item_name, quantity, unit, required_by, priority) VALUES ($1,$2,$3,$4,$5,$6)`,
        [ind.rows[0].id, t.name, qty, t.unit, d.request.delivery_needed_by || null, priority]);
    }
    const inputs = {
      calculated_at: new Date().toISOString(), basis: d.basis, basis_note: d.basis_note,
      items: d.items.map(i => ({ item_id: i.item_id, product_id: i.product_id, product: i.product, quantity: i.quantity,
        recipe_id: i.recipe.id, recipe_version: i.recipe.version, base_output_qty: i.recipe.base_output_qty,
        wastage_included: i.recipe.wastage_included, wastage_pct: i.recipe.wastage_pct })),
      totals: d.totals
    };
    // inputs.items[].recipe_id is what editableRecipe() checks to know a recipe version has been used.
    await client.query('INSERT INTO material_plans (request_id, indent_id, basis, inputs, created_by) VALUES ($1,$2,$3,$4,$5)',
      [id, ind.rows[0].id, d.basis, JSON.stringify(inputs), req.user.id]);
    await client.query('UPDATE branch_stock_requests SET planned_indent_id = $1 WHERE id = $2', [ind.rows[0].id, id]);
    await audit(client, req, { action: 'plan.draft_indent', entity: 'branch_request', id,
      summary: `${d.request.request_number} planned into ${number} (${d.totals.length} materials, gross requirement)`, after: { indent_id: ind.rows[0].id } });
    await client.query('COMMIT');
    notify({ roles: ['store'], subject: 'New production indent ' + number,
      text: `Production indent ${number} was drafted from ${d.request.request_number} and needs approval.`,
      path: 'production-indent-detail.html?id=' + ind.rows[0].id });
    res.status(201).json({ success: true, indent_id: ind.rows[0].id, indent_number: number, materials: d.totals.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Draft indent failed:', err); fail(res, 500, 'Could not create the indent');
  } finally { client.release(); }
});

module.exports = router;
