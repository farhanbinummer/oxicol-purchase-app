// routes/catalog.js - finished-product master data.
//   GET    /api/catalog/products/search?q=     suggestions while typing (active products only)
//   GET    /api/catalog/products               full list with recipe status
//   POST   /api/catalog/products               (admin) add a product
//   PUT    /api/catalog/products/:id           (admin) edit name/category/pack size/active
//   POST   /api/catalog/products/:id/aliases   (admin) add an alias
//   DELETE /api/catalog/aliases/:id            (admin) remove an alias
//   GET    /api/catalog/unmapped               request items still waiting to be linked to a product
//   PUT    /api/catalog/map-item               link one request item to a product

const express = require('express');
const { pool } = require('../database');
const { fail } = require('../utils');
const { requirePermission, requireRole } = require('../auth');
const { branchScope, branchClause, inBranchScope } = require('../access');
const { KEYS } = require('../permissions');
const { audit } = require('../audit');
const { rankItems, normalize } = require('../catalog-search');
const router = express.Router();

const idOf = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const UNITS = ['Nos', 'Kg', 'Litre', 'Box', 'Drum'];

async function loadProducts(db, onlyActive) {
  const r = await db.query(
    `SELECT p.id, p.code, p.name, p.category, p.pack_size, p.base_unit, p.active,
            COALESCE((SELECT json_agg(a.alias ORDER BY a.alias) FROM product_aliases a WHERE a.product_id = p.id), '[]') AS aliases,
            EXISTS (SELECT 1 FROM recipe_versions v WHERE v.product_id = p.id AND v.status = 'active' AND v.effective_from <= CURRENT_DATE) AS has_recipe
       FROM products p ${onlyActive ? 'WHERE p.active' : ''} ORDER BY p.name`);
  return r.rows;
}

/** Shared by this route and the recipes page's "add product". Returns the new id. */
async function createProduct(db, { name, category, pack_size, base_unit }) {
  const r = await db.query(
    `INSERT INTO products (name, category, pack_size, base_unit) VALUES ($1,$2,$3,$4) RETURNING id`,
    [name, category || 'Finished goods', pack_size || null, base_unit || 'Nos']);
  const id = r.rows[0].id;
  await db.query("UPDATE products SET code = 'FG-' || LPAD(id::text, 4, '0') WHERE id = $1 AND code IS NULL", [id]);
  return id;
}

router.get('/products/search', requirePermission(KEYS.CATALOG_VIEW), async (req, res) => {
  try {
    const q = String(req.query.q || '').slice(0, 80);
    const items = await loadProducts(pool, true);
    const limit = Math.min(Number(req.query.limit) || 8, 20);
    const hits = q.trim() ? rankItems(items, q, limit) : items.slice(0, limit);
    res.json({ success: true, products: hits.map(({ id, code, name, category, pack_size, base_unit, has_recipe, matched_via }) =>
      ({ id, code, name, category, pack_size, base_unit, has_recipe, matched_via })) });
  } catch (err) { console.error(err); fail(res, 500, 'Could not search products'); }
});

router.get('/products', requirePermission(KEYS.CATALOG_VIEW), async (req, res) => {
  try { res.json({ success: true, products: await loadProducts(pool, false) }); }
  catch (err) { console.error(err); fail(res, 500, 'Could not load products'); }
});

router.post('/products', requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return fail(res, 400, 'Product name is required');
  if (b.base_unit && !UNITS.includes(b.base_unit)) return fail(res, 400, 'Unit must be one of: ' + UNITS.join(', '));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = await createProduct(client, { name, category: b.category && String(b.category).trim(), pack_size: b.pack_size && String(b.pack_size).trim(), base_unit: b.base_unit });
    await audit(client, req, { action: 'product.create', entity: 'product', id, summary: `Added product ${name}`, after: { name, category: b.category, pack_size: b.pack_size } });
    await client.query('COMMIT');
    res.status(201).json({ success: true, product_id: id });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return fail(res, 400, 'A product with that name already exists');
    console.error(err); fail(res, 500, 'Could not add product');
  } finally { client.release(); }
});

router.put('/products/:id', requireRole('admin'), async (req, res) => {
  const id = idOf(req.params.id), b = req.body || {};
  if (!id) return fail(res, 400, 'Invalid product id');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query('SELECT name, category, pack_size, active FROM products WHERE id = $1 FOR UPDATE', [id]);
    if (cur.rowCount === 0) { await client.query('ROLLBACK'); return fail(res, 404, 'Product not found'); }
    const next = {
      name: b.name !== undefined ? String(b.name).trim() : cur.rows[0].name,
      category: b.category !== undefined ? String(b.category).trim() : cur.rows[0].category,
      pack_size: b.pack_size !== undefined ? (String(b.pack_size).trim() || null) : cur.rows[0].pack_size,
      active: b.active !== undefined ? !!b.active : cur.rows[0].active
    };
    if (!next.name) { await client.query('ROLLBACK'); return fail(res, 400, 'Product name cannot be empty'); }
    await client.query('UPDATE products SET name=$1, category=$2, pack_size=$3, active=$4 WHERE id=$5', [next.name, next.category, next.pack_size, next.active, id]);
    await audit(client, req, { action: 'product.update', entity: 'product', id, summary: `Updated product ${next.name}`, before: cur.rows[0], after: next });
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return fail(res, 400, 'Another product already has that name');
    console.error(err); fail(res, 500, 'Could not update product');
  } finally { client.release(); }
});

router.post('/products/:id/aliases', requireRole('admin'), async (req, res) => {
  const id = idOf(req.params.id);
  const alias = String((req.body && req.body.alias) || '').trim();
  const norm = normalize(alias);
  if (!id) return fail(res, 400, 'Invalid product id');
  if (norm.length < 2) return fail(res, 400, 'Alias must have at least 2 letters or digits');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const p = await client.query('SELECT name FROM products WHERE id = $1', [id]);
    if (p.rowCount === 0) { await client.query('ROLLBACK'); return fail(res, 404, 'Product not found'); }
    const r = await client.query('INSERT INTO product_aliases (product_id, alias, alias_norm) VALUES ($1,$2,$3) RETURNING id', [id, alias, norm]);
    await audit(client, req, { action: 'product.alias_add', entity: 'product', id, summary: `Alias "${alias}" added to ${p.rows[0].name}` });
    await client.query('COMMIT');
    res.status(201).json({ success: true, alias_id: r.rows[0].id });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return fail(res, 400, 'That alias already points to a product');
    console.error(err); fail(res, 500, 'Could not add alias');
  } finally { client.release(); }
});

router.delete('/aliases/:id', requireRole('admin'), async (req, res) => {
  const id = idOf(req.params.id);
  if (!id) return fail(res, 400, 'Invalid alias id');
  try {
    const r = await pool.query('DELETE FROM product_aliases WHERE id = $1 RETURNING product_id, alias', [id]);
    if (r.rowCount === 0) return fail(res, 404, 'Alias not found');
    await audit(pool, req, { action: 'product.alias_remove', entity: 'product', id: r.rows[0].product_id, summary: `Alias "${r.rows[0].alias}" removed` });
    res.json({ success: true });
  } catch (err) { console.error(err); fail(res, 500, 'Could not remove alias'); }
});

// ---------- legacy mapping review ----------
router.get('/unmapped', requirePermission(KEYS.CATALOG_MAP_ITEMS), async (req, res) => {
  try {
    const scopeParams = [];
    const scoped = branchClause(branchScope(req.access, KEYS.CATALOG_MAP_ITEMS), 'b.branch', scopeParams);
    const r = await pool.query(
      `SELECT i.id AS item_id, i.item_name, i.quantity::float AS quantity, i.unit,
              b.id AS request_id, b.request_number, b.branch, b.status
         FROM branch_request_items i JOIN branch_stock_requests b ON b.id = i.request_id
        WHERE i.mapping_status = 'needs_review' AND i.product_id IS NULL${scoped} ORDER BY b.id DESC, i.id`, scopeParams);
    const products = await loadProducts(pool, true);
    const items = r.rows.map(row => ({
      ...row,
      suggestions: rankItems(products, row.item_name, 5).map(({ id, code, name, pack_size }) => ({ id, code, name, pack_size }))
    }));
    res.json({ success: true, items });
  } catch (err) { console.error(err); fail(res, 500, 'Could not load items to review'); }
});

router.put('/map-item', requirePermission(KEYS.CATALOG_MAP_ITEMS), async (req, res) => {
  const item_id = idOf(req.body && req.body.item_id), product_id = idOf(req.body && req.body.product_id);
  if (!item_id || !product_id) return fail(res, 400, 'Choose both the request item and the product');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const it = await client.query(
      `SELECT i.id, i.item_name, i.product_id, b.request_number, b.branch FROM branch_request_items i
         JOIN branch_stock_requests b ON b.id = i.request_id WHERE i.id = $1 FOR UPDATE OF i`, [item_id]);
    if (it.rowCount === 0) { await client.query('ROLLBACK'); return fail(res, 404, 'Request item not found'); }
    if (!inBranchScope(branchScope(req.access, KEYS.CATALOG_MAP_ITEMS), it.rows[0].branch)) { await client.query('ROLLBACK'); return fail(res, 403, 'That request belongs to a different branch'); }
    const p = await client.query('SELECT id, code, name FROM products WHERE id = $1 AND active', [product_id]);
    if (p.rowCount === 0) { await client.query('ROLLBACK'); return fail(res, 400, 'That product is not active or does not exist'); }
    await client.query("UPDATE branch_request_items SET product_id = $1, mapping_status = 'mapped' WHERE id = $2", [product_id, item_id]);
    await audit(client, req, {
      action: 'request_item.map', entity: 'branch_request_item', id: item_id,
      summary: `${it.rows[0].request_number}: "${it.rows[0].item_name}" linked to ${p.rows[0].code} ${p.rows[0].name}`,
      before: { product_id: it.rows[0].product_id }, after: { product_id }
    });
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err); fail(res, 500, 'Could not link the item');
  } finally { client.release(); }
});

module.exports = router;
module.exports.createProduct = createProduct;
module.exports.loadProducts = loadProducts;
