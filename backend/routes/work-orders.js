// routes/work-orders.js - production batches.
//   GET  /api/work-orders/products        products that have a usable recipe
//   GET  /api/work-orders/preview?product_id=&qty=   what a batch would need, against what is in store
//   GET  /api/work-orders                 list (?status= &q=)
//   POST /api/work-orders                 plan a batch { product_id, planned_qty, planned_date, notes }
//   GET  /api/work-orders/:id             one batch with its materials
//   PUT  /api/work-orders/:id             change a planned batch { planned_qty, planned_date, notes }
//   POST /api/work-orders/:id/issue       Stores issues the materials { lines?: [{ material_id, qty }] }  (taken out of stock)
//   POST /api/work-orders/:id/complete    Production records what was made { finished_qty, finished_on, result_notes }
//   POST /api/work-orders/:id/qc          Quality check { passed, notes }
//   POST /api/work-orders/:id/cancel      { reason }  a planned batch just stops; an issued one puts its materials back in stock
// Flow: planned -> issued -> completed -> qc_passed | qc_failed ; cancelled from planned or issued.
const express = require('express');
const { pool } = require('../database');
const { fail, isValidDate, todayISO, nextNumber } = require('../utils');
const { requirePermission } = require('../auth');
const { KEYS } = require('../permissions');
const { can } = require('../access');
const { audit } = require('../audit');
const { notify } = require('../notify');
const { calcMaterials } = require('../planning');
const { balances, move, round3 } = require('../stock');
const bom = require('./bom');
const router = express.Router();

const idOf = (req) => { const n = Number(req.params.id); return Number.isInteger(n) && n > 0 ? n : 0; };
const fy = (d = new Date()) => { const y = d.getFullYear() % 100, m = d.getMonth() + 1, a = m >= 4 ? y : y - 1; return String(a).padStart(2, '0') + '-' + String((a + 1) % 100).padStart(2, '0'); };

/** What `qty` of a product needs, from its recipe in force. { error } or { recipe, materials: [{ material_id, code, name, unit, qty }] } */
async function needs(db, productId, qty) {
  const p = (await db.query('SELECT id, name FROM products WHERE id = $1', [productId])).rows[0];
  if (!p) return { error: 'Product not found' };
  const recipe = await bom.activeRecipe(db, productId);
  if (!recipe) return { error: `${p.name} has no active recipe yet. Ask the Administrator to add one in Recipes.` };
  const lines = await bom.recipeLines(db, recipe.id);
  if (!lines.length) return { error: `The recipe of ${p.name} has no materials.` };
  const c = calcMaterials([{ item_id: 1, item_name: p.name, product_id: p.id, product_name: p.name, quantity: qty, recipe: { ...recipe, lines } }]);
  return { product: p, recipe, materials: c.totals };
}

router.get('/products', requirePermission(KEYS.WORK_ORDER_VIEW), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT DISTINCT ON (p.id) p.id, p.name, r.base_output_qty::float AS base_output_qty, r.base_output_unit AS unit
         FROM products p JOIN recipe_versions r ON r.product_id = p.id AND r.status = 'active' AND r.effective_from <= CURRENT_DATE
        WHERE EXISTS (SELECT 1 FROM bom_lines l WHERE l.recipe_id = r.id) ORDER BY p.id, r.version DESC`);
    res.json({ success: true, products: r.rows.sort((a, b) => a.name.localeCompare(b.name)) });
  } catch (e) { console.error(e); fail(res, 500, 'Could not load products'); }
});

router.get('/preview', requirePermission(KEYS.WORK_ORDER_VIEW), async (req, res) => {
  const pid = Number(req.query.product_id), qty = Number(req.query.qty);
  if (!Number.isInteger(pid) || pid <= 0 || !isFinite(qty) || qty <= 0) return fail(res, 400, 'Choose a product and a quantity');
  try {
    const n = await needs(pool, pid, qty); if (n.error) return fail(res, 400, n.error);
    const bal = await balances(pool, n.materials.map(m => m.material_id));
    res.json({ success: true, unit: n.recipe.base_output_unit, recipe_version: n.recipe.version, materials: n.materials.map(m => { const on = bal.get(m.material_id) || 0; return { ...m, on_hand: on, short: round3(Math.max(0, m.qty - on)) }; }) });
  } catch (e) { console.error(e); fail(res, 500, 'Could not work out the materials'); }
});

router.get('/', requirePermission(KEYS.WORK_ORDER_VIEW), async (req, res) => {
  try {
    const status = String(req.query.status || ''), q = String(req.query.q || '').trim();
    const r = await pool.query(
      `SELECT w.id, w.batch_number, w.status, w.planned_qty::float AS planned_qty, w.unit, w.planned_date::text AS planned_date, w.finished_qty::float AS finished_qty, w.created_by_name, w.created_at::date::text AS created, p.name AS product_name
         FROM work_orders w JOIN products p ON p.id = w.product_id
        WHERE ($1 = '' OR w.status = ANY(string_to_array($1, ','))) AND ($2 = '' OR w.batch_number ILIKE '%' || $2 || '%' OR p.name ILIKE '%' || $2 || '%')
        ORDER BY w.id DESC LIMIT 300`, [status, q]);
    res.json({ success: true, work_orders: r.rows });
  } catch (e) { console.error(e); fail(res, 500, 'Could not load work orders'); }
});

router.post('/', requirePermission(KEYS.WORK_ORDER_CREATE), async (req, res) => {
  const b = req.body || {}, pid = Number(b.product_id), qty = Number(b.planned_qty);
  if (!Number.isInteger(pid) || pid <= 0) return fail(res, 400, 'Choose a product');
  if (!isFinite(qty) || qty <= 0) return fail(res, 400, 'The quantity to make must be greater than 0');
  if (b.planned_date && !isValidDate(b.planned_date)) return fail(res, 400, 'The planned date is not a valid date');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const n = await needs(client, pid, qty); if (n.error) { await client.query('ROLLBACK'); return fail(res, 400, n.error); }
    const number = await nextNumber(client, 'work_orders', 'batch_number', `BT-${fy()}-`);
    const w = (await client.query(
      `INSERT INTO work_orders (batch_number, product_id, recipe_id, planned_qty, unit, planned_date, notes, created_by, created_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [number, pid, n.recipe.id, round3(qty), n.recipe.base_output_unit || 'Nos', b.planned_date || null, b.notes ? String(b.notes).trim() : null, req.user.id, req.user.name || null])).rows[0];
    for (const m of n.materials) await client.query('INSERT INTO work_order_materials (wo_id, material_id, planned_qty, unit) VALUES ($1,$2,$3,$4)', [w.id, m.material_id, m.qty, m.unit]);
    await audit(client, req, { action: 'work_order.create', entity: 'work_order', id: w.id, summary: `${number}: ${round3(qty)} ${n.recipe.base_output_unit} of ${n.product.name}` });
    await client.query('COMMIT');
    notify({ roles: ['store'], subject: 'New batch to issue materials for: ' + number, text: `${number} (${round3(qty)} ${n.recipe.base_output_unit} of ${n.product.name}) is planned. Stores: please issue the raw materials.`, path: 'work-order.html?id=' + w.id });
    res.status(201).json({ success: true, id: w.id, batch_number: number });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); console.error(e); fail(res, 500, 'Could not plan the batch'); } finally { client.release(); }
});

async function load(db, id, req) {
  const w = (await db.query(
    `SELECT w.*, w.planned_qty::float AS planned_qty_n, w.finished_qty::float AS finished_qty_n, w.planned_date::text AS planned_date_s, w.finished_on::text AS finished_on_s, p.name AS product_name, r.version AS recipe_version
       FROM work_orders w JOIN products p ON p.id = w.product_id LEFT JOIN recipe_versions r ON r.id = w.recipe_id WHERE w.id = $1`, [id])).rows[0];
  if (!w) return null;
  const mats = (await db.query(
    `SELECT x.id, x.material_id, m.code, m.name, x.unit, x.planned_qty::float AS planned_qty, x.issued_qty::float AS issued_qty FROM work_order_materials x JOIN raw_materials m ON m.id = x.material_id WHERE x.wo_id = $1 ORDER BY m.name`, [id])).rows;
  const bal = await balances(db, mats.map(m => m.material_id));
  const st = w.status;
  return {
    work_order: { id: w.id, batch_number: w.batch_number, status: st, product_id: w.product_id, product_name: w.product_name, recipe_version: w.recipe_version, planned_qty: w.planned_qty_n, unit: w.unit, planned_date: w.planned_date_s, notes: w.notes,
      finished_qty: w.finished_qty_n, finished_on: w.finished_on_s, result_notes: w.result_notes, yield_pct: w.finished_qty_n != null ? Math.round(w.finished_qty_n / w.planned_qty_n * 1000) / 10 : null,
      qc_notes: w.qc_notes, qc_by_name: w.qc_by_name, qc_at: w.qc_at, cancel_reason: w.cancel_reason,
      created_by_name: w.created_by_name, created_at: w.created_at, issued_by_name: w.issued_by_name, issued_at: w.issued_at, completed_by_name: w.completed_by_name, completed_at: w.completed_at },
    materials: mats.map(m => ({ ...m, on_hand: bal.get(m.material_id) || 0 })),
    can: {
      edit: st === 'planned' && can(req.access, KEYS.WORK_ORDER_CREATE), cancel: ['planned', 'issued'].includes(st) && can(req.access, KEYS.WORK_ORDER_CREATE),
      issue: st === 'planned' && can(req.access, KEYS.WORK_ORDER_ISSUE), complete: st === 'issued' && can(req.access, KEYS.WORK_ORDER_COMPLETE), qc: st === 'completed' && can(req.access, KEYS.WORK_ORDER_QC)
    }
  };
}

router.get('/:id', requirePermission(KEYS.WORK_ORDER_VIEW), async (req, res) => {
  const id = idOf(req); if (!id) return fail(res, 400, 'Invalid work order id');
  try { const d = await load(pool, id, req); if (!d) return fail(res, 404, 'Work order not found'); res.json({ success: true, ...d }); }
  catch (e) { console.error(e); fail(res, 500, 'Could not load the work order'); }
});

router.put('/:id', requirePermission(KEYS.WORK_ORDER_CREATE), async (req, res) => {
  const id = idOf(req); if (!id) return fail(res, 400, 'Invalid work order id');
  const b = req.body || {}, qty = b.planned_qty === undefined ? null : Number(b.planned_qty);
  if (qty !== null && (!isFinite(qty) || qty <= 0)) return fail(res, 400, 'The quantity to make must be greater than 0');
  if (b.planned_date && !isValidDate(b.planned_date)) return fail(res, 400, 'The planned date is not a valid date');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const w = (await client.query('SELECT * FROM work_orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!w) { await client.query('ROLLBACK'); return fail(res, 404, 'Work order not found'); }
    if (w.status !== 'planned') { await client.query('ROLLBACK'); return fail(res, 400, 'Only a planned batch can be changed (materials are already issued, or it is finished)'); }
    const newQty = qty === null ? Number(w.planned_qty) : round3(qty);
    const n = await needs(client, w.product_id, newQty); if (n.error) { await client.query('ROLLBACK'); return fail(res, 400, n.error); }
    await client.query('UPDATE work_orders SET planned_qty = $1, planned_date = $2, notes = $3, recipe_id = $4, unit = $5 WHERE id = $6',
      [newQty, b.planned_date === undefined ? w.planned_date : (b.planned_date || null), b.notes === undefined ? w.notes : (b.notes ? String(b.notes).trim() : null), n.recipe.id, n.recipe.base_output_unit || w.unit, id]);
    await client.query('DELETE FROM work_order_materials WHERE wo_id = $1', [id]);
    for (const m of n.materials) await client.query('INSERT INTO work_order_materials (wo_id, material_id, planned_qty, unit) VALUES ($1,$2,$3,$4)', [id, m.material_id, m.qty, m.unit]);
    await audit(client, req, { action: 'work_order.edit', entity: 'work_order', id, summary: `${w.batch_number} changed: ${newQty}`, before: { planned_qty: Number(w.planned_qty) }, after: { planned_qty: newQty } });
    await client.query('COMMIT'); res.json({ success: true });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); console.error(e); fail(res, 500, 'Could not change the batch'); } finally { client.release(); }
});

router.post('/:id/issue', requirePermission(KEYS.WORK_ORDER_ISSUE), async (req, res) => {
  const id = idOf(req); if (!id) return fail(res, 400, 'Invalid work order id');
  const given = Array.isArray((req.body || {}).lines) ? req.body.lines : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const w = (await client.query('SELECT * FROM work_orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!w) { await client.query('ROLLBACK'); return fail(res, 404, 'Work order not found'); }
    if (w.status !== 'planned') { await client.query('ROLLBACK'); return fail(res, 400, 'Materials can only be issued for a planned batch (this one is ' + w.status + ')'); }
    const mats = (await client.query('SELECT x.id, x.material_id, x.planned_qty::float AS planned_qty, m.name, x.unit FROM work_order_materials x JOIN raw_materials m ON m.id = x.material_id WHERE x.wo_id = $1 ORDER BY x.material_id', [id])).rows;
    const qtyFor = new Map(mats.map(m => [m.material_id, round3(m.planned_qty)]));
    if (given) for (const l of given) {
      const mid = Number(l.material_id), q = Number(l.qty);
      if (!qtyFor.has(mid)) { await client.query('ROLLBACK'); return fail(res, 400, 'One of the materials is not part of this batch'); }
      if (!isFinite(q) || q < 0) { await client.query('ROLLBACK'); return fail(res, 400, 'Issued quantities must be 0 or more'); }
      qtyFor.set(mid, round3(q));
    }
    if (![...qtyFor.values()].some(q => q > 0)) { await client.query('ROLLBACK'); return fail(res, 400, 'Issue at least one material'); }
    await client.query('SELECT id FROM raw_materials WHERE id = ANY($1) ORDER BY id FOR UPDATE', [mats.map(m => m.material_id)]);    // two issues at once cannot both take the same stock
    const bal = await balances(client, mats.map(m => m.material_id));
    const short = mats.filter(m => qtyFor.get(m.material_id) > (bal.get(m.material_id) || 0) + 1e-9).map(m => ({ material_id: m.material_id, name: m.name, unit: m.unit, wanted: qtyFor.get(m.material_id), in_store: bal.get(m.material_id) || 0 }));
    if (short.length) { await client.query('ROLLBACK'); return res.status(409).json({ success: false, error: 'Not enough in store: ' + short.map(s => `${s.name} (need ${s.wanted}, have ${s.in_store} ${s.unit || ''})`).join('; '), shortages: short }); }
    for (const m of mats) {
      const q = qtyFor.get(m.material_id);
      await client.query('UPDATE work_order_materials SET issued_qty = $1 WHERE id = $2', [q, m.id]);
      if (q > 0) await move(client, req, { material_id: m.material_id, qty: -q, kind: 'issue', ref_type: 'work_order', ref_id: id, note: w.batch_number });
    }
    await client.query("UPDATE work_orders SET status = 'issued', issued_at = NOW(), issued_by_name = $1 WHERE id = $2", [req.user.name || null, id]);
    await audit(client, req, { action: 'work_order.issue', entity: 'work_order', id, summary: `${w.batch_number}: materials issued (${mats.length})`, after: { lines: mats.map(m => ({ material_id: m.material_id, qty: qtyFor.get(m.material_id) })) } });
    await client.query('COMMIT');
    notify({ roles: ['production'], subject: 'Materials issued for ' + w.batch_number, text: `Stores issued the materials for ${w.batch_number}. Production can start the batch.`, path: 'work-order.html?id=' + id });
    res.json({ success: true });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); console.error(e); fail(res, 500, 'Could not issue the materials'); } finally { client.release(); }
});

router.post('/:id/complete', requirePermission(KEYS.WORK_ORDER_COMPLETE), async (req, res) => {
  const id = idOf(req); if (!id) return fail(res, 400, 'Invalid work order id');
  const b = req.body || {}, qty = Number(b.finished_qty), on = b.finished_on || todayISO();
  if (b.finished_qty === '' || b.finished_qty === undefined || !isFinite(qty) || qty <= 0) return fail(res, 400, 'Enter the quantity that was made (greater than 0)');
  if (!isValidDate(on)) return fail(res, 400, 'The finish date is not a valid date');
  try {
    const w = (await pool.query("UPDATE work_orders SET status = 'completed', finished_qty = $1, finished_on = $2, result_notes = $3, completed_at = NOW(), completed_by_name = $4 WHERE id = $5 AND status = 'issued' RETURNING batch_number, planned_qty::float AS planned",
      [round3(qty), on, b.result_notes ? String(b.result_notes).trim() : null, req.user.name || null, id])).rows[0];
    if (!w) { const c = (await pool.query('SELECT status FROM work_orders WHERE id = $1', [id])).rows[0]; return c ? fail(res, 400, 'Only a batch whose materials were issued can be completed (this one is ' + c.status + ')') : fail(res, 404, 'Work order not found'); }
    await audit(pool, req, { action: 'work_order.complete', entity: 'work_order', id, summary: `${w.batch_number}: made ${round3(qty)} of ${w.planned} planned`, after: { finished_qty: round3(qty) } });
    notify({ roles: ['qc'], subject: 'Batch ready for quality check: ' + w.batch_number, text: `${w.batch_number} is finished (${round3(qty)} made). Quality check: please pass or fail it.`, path: 'work-order.html?id=' + id });
    res.json({ success: true, yield_pct: Math.round(qty / w.planned * 1000) / 10 });
  } catch (e) { console.error(e); fail(res, 500, 'Could not save the result'); }
});

router.post('/:id/qc', requirePermission(KEYS.WORK_ORDER_QC), async (req, res) => {
  const id = idOf(req); if (!id) return fail(res, 400, 'Invalid work order id');
  const b = req.body || {}, passed = b.passed === true || b.passed === 'true', notes = String(b.notes || '').trim();
  if (!passed && notes.length < 3) return fail(res, 400, 'Write why the batch failed');
  try {
    const w = (await pool.query("UPDATE work_orders SET status = $1, qc_notes = $2, qc_by_name = $3, qc_at = NOW() WHERE id = $4 AND status = 'completed' RETURNING batch_number",
      [passed ? 'qc_passed' : 'qc_failed', notes || null, req.user.name || null, id])).rows[0];
    if (!w) { const c = (await pool.query('SELECT status FROM work_orders WHERE id = $1', [id])).rows[0]; return c ? fail(res, 400, 'Only a finished batch can be checked (this one is ' + c.status + ')') : fail(res, 404, 'Work order not found'); }
    await audit(pool, req, { action: 'work_order.qc', entity: 'work_order', id, summary: `${w.batch_number} ${passed ? 'passed' : 'failed'} quality check`, reason: notes || undefined });
    notify({ roles: ['production', 'store'], subject: `Batch ${passed ? 'passed' : 'FAILED'} quality check: ` + w.batch_number, text: `${w.batch_number} ${passed ? 'passed' : 'failed'} quality check.${notes ? ' ' + notes : ''}`, path: 'work-order.html?id=' + id });
    res.json({ success: true, status: passed ? 'qc_passed' : 'qc_failed' });
  } catch (e) { console.error(e); fail(res, 500, 'Could not save the quality decision'); }
});

router.post('/:id/cancel', requirePermission(KEYS.WORK_ORDER_CREATE), async (req, res) => {
  const id = idOf(req); if (!id) return fail(res, 400, 'Invalid work order id');
  const reason = String((req.body || {}).reason || '').trim();
  if (reason.length < 5) return fail(res, 400, 'Write why it is being cancelled (at least 5 letters)');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const w = (await client.query('SELECT * FROM work_orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!w) { await client.query('ROLLBACK'); return fail(res, 404, 'Work order not found'); }
    if (!['planned', 'issued'].includes(w.status)) { await client.query('ROLLBACK'); return fail(res, 400, 'A finished batch cannot be cancelled (this one is ' + w.status + ')'); }
    let returned = 0;
    if (w.status === 'issued') {
      const mats = (await client.query('SELECT material_id, issued_qty::float AS q FROM work_order_materials WHERE wo_id = $1 AND issued_qty > 0', [id])).rows;
      for (const m of mats) { await move(client, req, { material_id: m.material_id, qty: m.q, kind: 'return', ref_type: 'work_order', ref_id: id, note: w.batch_number + ' cancelled' }); returned++; }
    }
    await client.query("UPDATE work_orders SET status = 'cancelled', cancel_reason = $1 WHERE id = $2", [reason, id]);
    await audit(client, req, { action: 'work_order.cancel', entity: 'work_order', id, summary: `${w.batch_number} cancelled${returned ? ' (' + returned + ' materials returned to stock)' : ''}`, reason, before: { status: w.status } });
    await client.query('COMMIT'); res.json({ success: true, returned });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); console.error(e); fail(res, 500, 'Could not cancel the batch'); } finally { client.release(); }
});

module.exports = router;
