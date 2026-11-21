// routes/rate-enquiry.js - ask suppliers for rates BEFORE a purchase order is made.
//   GET  /api/rate-enquiry              list
//   POST /api/rate-enquiry              start one from the items to buy { title, notes, supplier_ids[], items:[{item_name, unit, quantity, sources:[{type,id}]}] }
//   GET  /api/rate-enquiry/:id          items, suppliers, every quote
//   PUT  /api/rate-enquiry/:id/suppliers { supplier_ids[] }          who is being asked (removing one removes their quotes)
//   PUT  /api/rate-enquiry/:id/quote     { item_id, supplier_id, rate, note }   rate empty = remove the quote
//   PUT  /api/rate-enquiry/:id/award     { item_id, supplier_id|null }          choose the supplier for a line
//   POST /api/rate-enquiry/:id/ordered   { item_ids[], po_id }                  record the purchase order raised from the chosen lines
//   PUT  /api/rate-enquiry/:id/item      { item_id, gst_rate }                  the item's GST rate (blank = the raw material's own, else 18)
//   PUT  /api/rate-enquiry/:id/status    { status: open|closed|cancelled }
// Money is involved (quoted rates), so every route needs price access as well.

const express = require('express');
const { pool } = require('../database');
const { fail, round2, stamp, todayISO, nextNumber } = require('../utils');
const { requirePermission } = require('../auth');
const { KEYS } = require('../permissions');
const { fieldAccess } = require('../access');
const { audit } = require('../audit');
const { cleanRate } = require('../tax');
const router = express.Router();

const needPrices = (req, res, next) => fieldAccess(req.access).prices ? next() : fail(res, 403, 'Rate enquiries show rates, which this role may not see');
const VIEW = [requirePermission(KEYS.RATE_ENQUIRY_VIEW), needPrices];
const MANAGE = [requirePermission(KEYS.RATE_ENQUIRY_MANAGE), needPrices];
const idOf = (req) => { const n = Number(req.params.id); return Number.isInteger(n) && n > 0 ? n : 0; };
const fix = (res, e, msg) => { console.error(msg, e); fail(res, 500, msg); };

async function load(db, id) {
  const e = (await db.query('SELECT * FROM rate_enquiries WHERE id = $1', [id])).rows[0];
  if (!e) return null;
  const items = (await db.query('SELECT id, item_name, unit, quantity::float AS quantity, gst_rate::float AS gst_rate, sources, awarded_supplier_id, awarded_rate::float AS awarded_rate, po_id FROM rate_enquiry_items WHERE enquiry_id = $1 ORDER BY id', [id])).rows;
  const suppliers = (await db.query('SELECT s.id, s.name, s.phone, s.contact_person FROM rate_enquiry_suppliers r JOIN suppliers s ON s.id = r.supplier_id WHERE r.enquiry_id = $1 ORDER BY s.name', [id])).rows;
  const quotes = (await db.query('SELECT item_id, supplier_id, rate::float AS rate, note, quoted_by, quoted_at FROM rate_quotes WHERE enquiry_id = $1', [id])).rows;
  const pos = (await db.query('SELECT id, po_number FROM purchase_orders WHERE id = ANY($1)', [items.map(i => i.po_id).filter(Boolean)])).rows;
  return { enquiry: e, items, suppliers, quotes, pos };
}

router.get('/', ...VIEW, async (req, res) => {
  try {
    const r = await pool.query(`SELECT e.id, e.enquiry_number, e.title, e.status, e.created_by_name, e.created_at::date::text AS created,
        (SELECT COUNT(*)::int FROM rate_enquiry_items i WHERE i.enquiry_id = e.id) AS items,
        (SELECT COUNT(*)::int FROM rate_enquiry_suppliers s WHERE s.enquiry_id = e.id) AS suppliers,
        (SELECT COUNT(*)::int FROM rate_quotes q WHERE q.enquiry_id = e.id) AS quotes,
        (SELECT COUNT(*)::int FROM rate_enquiry_items i WHERE i.enquiry_id = e.id AND i.po_id IS NOT NULL) AS ordered
      FROM rate_enquiries e ORDER BY e.id DESC LIMIT 300`);
    res.json({ success: true, enquiries: r.rows });
  } catch (e) { fix(res, e, 'Could not load rate enquiries'); }
});

router.post('/', ...MANAGE, async (req, res) => {
  const b = req.body || {};
  if (!Array.isArray(b.items) || !b.items.length) return fail(res, 400, 'Choose at least one item to ask rates for');
  for (let i = 0; i < b.items.length; i++) {
    const it = b.items[i];
    if (!it || !String(it.item_name || '').trim()) return fail(res, 400, `Item ${i + 1}: name is required`);
    if (!String(it.unit || '').trim()) return fail(res, 400, `Item ${i + 1}: unit is required`);
    if (!isFinite(Number(it.quantity)) || Number(it.quantity) <= 0) return fail(res, 400, `Item ${i + 1}: quantity must be greater than 0`);
    if (cleanRate(it.gst_rate) === undefined) return fail(res, 400, `Item ${i + 1}: GST rate must be one of 0, 0.25, 3, 5, 12, 18 or 28 (or blank)`);
  }
  const sup = Array.isArray(b.supplier_ids) ? [...new Set(b.supplier_ids.map(Number).filter(n => Number.isInteger(n) && n > 0))] : [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (sup.length) {
      const ok = (await client.query("SELECT id FROM suppliers WHERE id = ANY($1) AND status = 'active'", [sup])).rowCount;
      if (ok !== sup.length) { await client.query('ROLLBACK'); return fail(res, 400, 'One of the suppliers was not found'); }
    }
    const number = await nextNumber(client, 'rate_enquiries', 'enquiry_number', `RE-${stamp(todayISO())}-`);
    const e = (await client.query('INSERT INTO rate_enquiries (enquiry_number, title, notes, created_by, created_by_name) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [number, b.title ? String(b.title).trim().slice(0, 120) : null, b.notes ? String(b.notes).trim() : null, req.user.id, req.user.name || null])).rows[0];
    for (const it of b.items) {
      const src = (Array.isArray(it.sources) ? it.sources : []).filter(s => s && ['branch', 'production'].includes(s.type) && Number.isInteger(Number(s.id))).map(s => ({ type: s.type, id: Number(s.id) }));
      await client.query('INSERT INTO rate_enquiry_items (enquiry_id, item_name, unit, quantity, sources, gst_rate) VALUES ($1,$2,$3,$4,$5,$6)',
        [e.id, String(it.item_name).trim(), String(it.unit).trim(), round2(Number(it.quantity)), JSON.stringify(src), cleanRate(it.gst_rate)]);
    }
    for (const s of sup) await client.query('INSERT INTO rate_enquiry_suppliers (enquiry_id, supplier_id) VALUES ($1,$2)', [e.id, s]);
    await audit(client, req, { action: 'rate_enquiry.create', entity: 'rate_enquiry', id: e.id, summary: `${number} started for ${b.items.length} item(s)` });
    await client.query('COMMIT');
    res.status(201).json({ success: true, id: e.id, enquiry_number: number });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); fix(res, e, 'Could not start the rate enquiry'); } finally { client.release(); }
});

router.get('/:id', ...VIEW, async (req, res) => {
  const id = idOf(req); if (!id) return fail(res, 400, 'Invalid enquiry id');
  try { const d = await load(pool, id); if (!d) return fail(res, 404, 'Rate enquiry not found'); res.json({ success: true, ...d }); }
  catch (e) { fix(res, e, 'Could not load the rate enquiry'); }
});

// each of these changes only an enquiry that is still open
async function openEnquiry(db, id) {
  const e = (await db.query('SELECT id, enquiry_number, status FROM rate_enquiries WHERE id = $1 FOR UPDATE', [id])).rows[0];
  return e;
}

router.put('/:id/suppliers', ...MANAGE, async (req, res) => {
  const id = idOf(req); if (!id) return fail(res, 400, 'Invalid enquiry id');
  const sup = Array.isArray((req.body || {}).supplier_ids) ? [...new Set(req.body.supplier_ids.map(Number).filter(n => Number.isInteger(n) && n > 0))] : null;
  if (!sup) return fail(res, 400, 'supplier_ids is required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const e = await openEnquiry(client, id);
    if (!e) { await client.query('ROLLBACK'); return fail(res, 404, 'Rate enquiry not found'); }
    if (e.status !== 'open') { await client.query('ROLLBACK'); return fail(res, 400, 'This enquiry is ' + e.status); }
    if (sup.length && (await client.query("SELECT id FROM suppliers WHERE id = ANY($1) AND status = 'active'", [sup])).rowCount !== sup.length) { await client.query('ROLLBACK'); return fail(res, 400, 'One of the suppliers was not found'); }
    // a supplier already chosen for a line, or whose line is ordered, cannot be taken off
    const held = (await client.query('SELECT DISTINCT awarded_supplier_id AS s FROM rate_enquiry_items WHERE enquiry_id = $1 AND awarded_supplier_id IS NOT NULL', [id])).rows.map(r => r.s);
    if (held.some(s => !sup.includes(s))) { await client.query('ROLLBACK'); return fail(res, 400, 'A supplier chosen for an item cannot be removed: change that choice first'); }
    await client.query('DELETE FROM rate_quotes WHERE enquiry_id = $1 AND NOT (supplier_id = ANY($2))', [id, sup]);
    await client.query('DELETE FROM rate_enquiry_suppliers WHERE enquiry_id = $1', [id]);
    for (const s of sup) await client.query('INSERT INTO rate_enquiry_suppliers (enquiry_id, supplier_id) VALUES ($1,$2)', [id, s]);
    await audit(client, req, { action: 'rate_enquiry.suppliers', entity: 'rate_enquiry', id, summary: `${e.enquiry_number}: ${sup.length} supplier(s) asked` });
    await client.query('COMMIT'); res.json({ success: true });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); fix(res, e, 'Could not save the suppliers'); } finally { client.release(); }
});

router.put('/:id/quote', ...MANAGE, async (req, res) => {
  const id = idOf(req); if (!id) return fail(res, 400, 'Invalid enquiry id');
  const b = req.body || {}, itemId = Number(b.item_id), supId = Number(b.supplier_id);
  if (!Number.isInteger(itemId) || !Number.isInteger(supId)) return fail(res, 400, 'item_id and supplier_id are required');
  const clear = b.rate === '' || b.rate === null || b.rate === undefined;
  if (!clear && (!isFinite(Number(b.rate)) || Number(b.rate) <= 0)) return fail(res, 400, 'The rate must be greater than 0');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const e = await openEnquiry(client, id);
    if (!e) { await client.query('ROLLBACK'); return fail(res, 404, 'Rate enquiry not found'); }
    if (e.status !== 'open') { await client.query('ROLLBACK'); return fail(res, 400, 'This enquiry is ' + e.status); }
    const it = (await client.query('SELECT id, po_id, awarded_supplier_id, item_name FROM rate_enquiry_items WHERE id = $1 AND enquiry_id = $2 FOR UPDATE', [itemId, id])).rows[0];
    const asked = (await client.query('SELECT 1 FROM rate_enquiry_suppliers WHERE enquiry_id = $1 AND supplier_id = $2', [id, supId])).rowCount;
    if (!it || !asked) { await client.query('ROLLBACK'); return fail(res, 400, 'That item or supplier is not part of this enquiry'); }
    if (it.po_id) { await client.query('ROLLBACK'); return fail(res, 400, 'An order was already raised for this item'); }
    if (clear) {
      if (it.awarded_supplier_id === supId) { await client.query('ROLLBACK'); return fail(res, 400, 'This supplier is chosen for the item: change the choice first'); }
      await client.query('DELETE FROM rate_quotes WHERE item_id = $1 AND supplier_id = $2', [itemId, supId]);
    } else {
      const rate = round2(Number(b.rate));
      await client.query(`INSERT INTO rate_quotes (enquiry_id, item_id, supplier_id, rate, note, quoted_by) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (item_id, supplier_id) DO UPDATE SET rate = EXCLUDED.rate, note = EXCLUDED.note, quoted_by = EXCLUDED.quoted_by, quoted_at = NOW()`,
        [id, itemId, supId, rate, b.note ? String(b.note).trim().slice(0, 200) : null, req.user.name || null]);
      if (it.awarded_supplier_id === supId) await client.query('UPDATE rate_enquiry_items SET awarded_rate = $1 WHERE id = $2', [rate, itemId]);   // the chosen quote was corrected
    }
    await audit(client, req, { action: 'rate_enquiry.quote', entity: 'rate_enquiry', id, summary: `${e.enquiry_number}: ${it.item_name} ${clear ? 'quote removed' : 'quoted ' + round2(Number(b.rate))}`, after: { item_id: itemId, supplier_id: supId, rate: clear ? null : round2(Number(b.rate)) } });
    await client.query('COMMIT'); res.json({ success: true });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); fix(res, e, 'Could not save the quote'); } finally { client.release(); }
});

router.put('/:id/award', ...MANAGE, async (req, res) => {
  const id = idOf(req); if (!id) return fail(res, 400, 'Invalid enquiry id');
  const b = req.body || {}, itemId = Number(b.item_id), supId = b.supplier_id === null || b.supplier_id === undefined || b.supplier_id === '' ? null : Number(b.supplier_id);
  if (!Number.isInteger(itemId) || (supId !== null && !Number.isInteger(supId))) return fail(res, 400, 'item_id and supplier_id are required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const e = await openEnquiry(client, id);
    if (!e) { await client.query('ROLLBACK'); return fail(res, 404, 'Rate enquiry not found'); }
    if (e.status !== 'open') { await client.query('ROLLBACK'); return fail(res, 400, 'This enquiry is ' + e.status); }
    const it = (await client.query('SELECT id, po_id, item_name FROM rate_enquiry_items WHERE id = $1 AND enquiry_id = $2 FOR UPDATE', [itemId, id])).rows[0];
    if (!it) { await client.query('ROLLBACK'); return fail(res, 400, 'That item is not part of this enquiry'); }
    if (it.po_id) { await client.query('ROLLBACK'); return fail(res, 400, 'An order was already raised for this item: delete that order first to choose again'); }
    let rate = null;
    if (supId !== null) {
      const q = (await client.query('SELECT rate::float AS rate FROM rate_quotes WHERE item_id = $1 AND supplier_id = $2', [itemId, supId])).rows[0];
      if (!q) { await client.query('ROLLBACK'); return fail(res, 400, 'That supplier has not quoted this item yet'); }
      rate = q.rate;
    }
    await client.query('UPDATE rate_enquiry_items SET awarded_supplier_id = $1, awarded_rate = $2 WHERE id = $3', [supId, rate, itemId]);
    await audit(client, req, { action: 'rate_enquiry.award', entity: 'rate_enquiry', id, summary: `${e.enquiry_number}: ${it.item_name} ${supId ? 'given to supplier ' + supId + ' at ' + rate : 'choice cleared'}` });
    await client.query('COMMIT'); res.json({ success: true });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); fix(res, e, 'Could not save the choice'); } finally { client.release(); }
});

router.post('/:id/ordered', ...MANAGE, async (req, res) => {
  const id = idOf(req); if (!id) return fail(res, 400, 'Invalid enquiry id');
  const itemIds = Array.isArray((req.body || {}).item_ids) ? req.body.item_ids.map(Number).filter(Number.isInteger) : [], poId = Number((req.body || {}).po_id);
  if (!itemIds.length || !Number.isInteger(poId) || poId <= 0) return fail(res, 400, 'item_ids and po_id are required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const e = await openEnquiry(client, id);
    if (!e) { await client.query('ROLLBACK'); return fail(res, 404, 'Rate enquiry not found'); }
    const po = (await client.query('SELECT id, po_number, supplier_id FROM purchase_orders WHERE id = $1', [poId])).rows[0];
    if (!po) { await client.query('ROLLBACK'); return fail(res, 400, 'That purchase order does not exist'); }
    const its = (await client.query('SELECT id, awarded_supplier_id, po_id FROM rate_enquiry_items WHERE enquiry_id = $1 AND id = ANY($2) FOR UPDATE', [id, itemIds])).rows;
    if (its.length !== itemIds.length || its.some(i => i.po_id || i.awarded_supplier_id !== po.supplier_id)) { await client.query('ROLLBACK'); return fail(res, 400, 'Those items are not chosen for the supplier of that order, or are already ordered'); }
    await client.query('UPDATE rate_enquiry_items SET po_id = $1 WHERE id = ANY($2)', [poId, itemIds]);
    if (!(await client.query('SELECT 1 FROM rate_enquiry_items WHERE enquiry_id = $1 AND po_id IS NULL LIMIT 1', [id])).rowCount) await client.query("UPDATE rate_enquiries SET status = 'closed' WHERE id = $1 AND status = 'open'", [id]);
    await audit(client, req, { action: 'rate_enquiry.ordered', entity: 'rate_enquiry', id, summary: `${e.enquiry_number}: ${itemIds.length} item(s) ordered in ${po.po_number}` });
    await client.query('COMMIT'); res.json({ success: true });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); fix(res, e, 'Could not record the order'); } finally { client.release(); }
});

router.put('/:id/item', ...MANAGE, async (req, res) => {
  const id = idOf(req); if (!id) return fail(res, 400, 'Invalid enquiry id');
  const b = req.body || {}, itemId = Number(b.item_id), rate = cleanRate(b.gst_rate);
  if (!Number.isInteger(itemId)) return fail(res, 400, 'item_id is required');
  if (rate === undefined) return fail(res, 400, 'GST rate must be one of 0, 0.25, 3, 5, 12, 18 or 28 (or blank)');
  try {
    const e = (await pool.query('SELECT status FROM rate_enquiries WHERE id = $1', [id])).rows[0];
    if (!e) return fail(res, 404, 'Rate enquiry not found');
    if (e.status !== 'open') return fail(res, 400, 'This enquiry is ' + e.status);
    const r = await pool.query('UPDATE rate_enquiry_items SET gst_rate = $1 WHERE id = $2 AND enquiry_id = $3 AND po_id IS NULL', [rate, itemId, id]);
    if (!r.rowCount) return fail(res, 400, 'That item is not part of this enquiry, or is already ordered');
    res.json({ success: true });
  } catch (e) { fix(res, e, 'Could not save the GST rate'); }
});

router.put('/:id/status', ...MANAGE, async (req, res) => {
  const id = idOf(req); if (!id) return fail(res, 400, 'Invalid enquiry id');
  const st = (req.body || {}).status;
  if (!['open', 'closed', 'cancelled'].includes(st)) return fail(res, 400, 'Status must be open, closed or cancelled');
  try {
    const r = await pool.query('UPDATE rate_enquiries SET status = $1 WHERE id = $2 RETURNING enquiry_number', [st, id]);
    if (!r.rowCount) return fail(res, 404, 'Rate enquiry not found');
    await audit(pool, req, { action: 'rate_enquiry.status', entity: 'rate_enquiry', id, summary: `${r.rows[0].enquiry_number} marked ${st}` });
    res.json({ success: true, status: st });
  } catch (e) { fix(res, e, 'Could not change the status'); }
});

module.exports = router;
