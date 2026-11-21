// routes/admin-records.js - administrator-only removal of ANY kind of record, not only R&D projects (mounted under /api/admin/data/records).
//   GET  /api/admin/data/records                     the kinds that can be removed
//   GET  /api/admin/data/records/:kind?q=            the records of one kind, each with what hangs under it and whether it may be removed
//   POST /api/admin/data/records/:kind/delete        { ids (at most 50), confirm, reason }
// Kinds: rd_project, po (purchase orders), grn (goods receipts), payment, invoice, branch_request, indent (production requests),
//        supplier, material (raw materials), product (finished products).
// Not included, on purpose: people's accounts (switch them off on the Users page instead: a person's name is on too much history to
// delete) and the audit history (never removable).
//
// Removing is permanent, so: administrator only (the whole /api/admin tree), a typed confirmation, a written reason, everything under a
// record removed in the same transaction (all or nothing), and one audit entry per record with what was removed, by whom and why.
// Master records that other records still point at (a supplier with orders, a raw material used in a recipe, a product that branches
// have requested) are NOT removable until what uses them is removed: the screen says why instead of breaking anything.
const express = require('express');
const { pool } = require('../database');
const { fail } = require('../utils');
const { audit } = require('../audit');
const { refreshSourceStatus } = require('../source-status');
const rdData = require('./admin-data');
const router = express.Router();

const MAX_BULK = 50;
const idOf = (v) => (/^\d+$/.test(String(v)) && Number(v) > 0 ? Number(v) : null);
const reasonOf = (b) => String((b && b.reason) || '').trim();
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const likeArg = (q) => String(q || '').trim().slice(0, 80);
const tableCache = new Map();
async function hasTable(db, name) {            // tables added by later changes may not exist yet on every database
  if (!tableCache.has(name)) tableCache.set(name, !!(await db.query('SELECT to_regclass($1) AS t', [name])).rows[0].t);
  return tableCache.get(name);
}
/** Map id -> number from a "SELECT key, COUNT(*) AS n ... GROUP BY key" query (sql takes the id list as $1). */
async function tally(db, sql, ids) { return new Map((await db.query(sql, [ids])).rows.map(r => [r.k, Number(r.n)])); }
const take = (m, id) => m.get(id) || 0;

const KINDS = {
  rd_project: {
    label: 'R&D project', words: 'R&D projects', sort: 1,
    q: { alias: 'p', cols: `p.id, p.project_number AS number, p.title, CASE WHEN p.is_draft THEN 'Draft' ELSE p.status END AS status, p.created_at::date::text AS created, p.requested_by_name AS who`, from: `rd_projects p`, search: ['p.project_number', 'p.title', 'p.requested_by_name'], order: 'p.id DESC' },
    async counts(db, ids) {
      const c = await rdData.countsFor(db, ids);
      return new Map(ids.map(id => { const x = c.get(id); return [id, { 'Stages done': `${x.stages_done} of ${x.stages}`, Tasks: x.tasks, 'Lab trials': x.trials, Files: x.files, Notes: x.notes }]; }));
    },
    async remove(db, ids) { await db.query('DELETE FROM rd_projects WHERE id = ANY($1)', [ids]); }
  },
  po: {
    label: 'purchase order', words: 'purchase orders', sort: 2,
    q: { alias: 'p', cols: `p.id, p.po_number AS number, s.name AS title, p.status, p.po_date::text AS created, p.total_amount::float AS amount`, from: `purchase_orders p JOIN suppliers s ON s.id = p.supplier_id`, search: ['p.po_number', 's.name'], order: 'p.id DESC' },
    async counts(db, ids) {
      const [items, pay, grn, inv, links] = await Promise.all([
        tally(db, 'SELECT po_id AS k, COUNT(*) AS n FROM po_items WHERE po_id = ANY($1) GROUP BY po_id', ids), tally(db, 'SELECT po_id AS k, COUNT(*) AS n FROM payments WHERE po_id = ANY($1) GROUP BY po_id', ids),
        tally(db, 'SELECT po_id AS k, COUNT(*) AS n FROM grn_notes WHERE po_id = ANY($1) GROUP BY po_id', ids), tally(db, 'SELECT po_id AS k, COUNT(*) AS n FROM purchase_invoices WHERE po_id = ANY($1) GROUP BY po_id', ids),
        tally(db, 'SELECT po_id AS k, COUNT(*) AS n FROM po_source_links WHERE po_id = ANY($1) GROUP BY po_id', ids)]);
      return new Map(ids.map(id => [id, { Items: take(items, id), Payments: take(pay, id), 'Goods receipts': take(grn, id), Invoices: take(inv, id), 'Linked requests': take(links, id) }]));
    },
    async remove(db, ids) {
      const links = (await db.query('SELECT DISTINCT source_type, source_id FROM po_source_links WHERE po_id = ANY($1)', [ids])).rows;
      await db.query('DELETE FROM three_way_match WHERE po_id = ANY($1) OR invoice_id IN (SELECT id FROM purchase_invoices WHERE po_id = ANY($1))', [ids]);
      await db.query('DELETE FROM purchase_invoices WHERE po_id = ANY($1)', [ids]);
      await db.query('DELETE FROM payments WHERE po_id = ANY($1)', [ids]);
      await db.query('DELETE FROM grn_notes WHERE po_id = ANY($1)', [ids]);                 // goods receipt lines and files go with them
      await db.query('DELETE FROM purchase_orders WHERE id = ANY($1)', [ids]);              // order lines and links go with it
      // a request or production request whose only order is gone is waiting for an order again
      for (const l of links) await refreshSourceStatus(db, l.source_type, l.source_id);
    },
    audit: (r) => ({ supplier: r.title, total_amount: r.amount })
  },
  grn: {
    label: 'goods receipt', words: 'goods receipts', sort: 3,
    q: { alias: 'g', cols: `g.id, g.grn_number AS number, s.name || ' - ' || po.po_number AS title, g.status, g.grn_date::text AS created`, from: `grn_notes g JOIN purchase_orders po ON po.id = g.po_id JOIN suppliers s ON s.id = po.supplier_id`, search: ['g.grn_number', 'po.po_number', 's.name'], order: 'g.id DESC' },
    async counts(db, ids) {
      const items = await tally(db, 'SELECT grn_id AS k, COUNT(*) AS n FROM grn_items WHERE grn_id = ANY($1) GROUP BY grn_id', ids);
      const files = (await hasTable(db, 'grn_attachments')) ? await tally(db, 'SELECT grn_id AS k, COUNT(*) AS n FROM grn_attachments WHERE grn_id = ANY($1) GROUP BY grn_id', ids) : new Map();
      return new Map(ids.map(id => [id, { Items: take(items, id), Files: take(files, id) }]));
    },
    async remove(db, ids) { await db.query('DELETE FROM grn_notes WHERE id = ANY($1)', [ids]); }
  },
  payment: {
    label: 'payment', words: 'payments', sort: 4,
    q: { alias: 'y', cols: `y.id, y.payment_id AS number, s.name || ' - ' || po.po_number AS title, y.status, y.payment_date::text AS created, y.amount::float AS amount`, from: `payments y JOIN purchase_orders po ON po.id = y.po_id JOIN suppliers s ON s.id = y.supplier_id`, search: ['y.payment_id', 'po.po_number', 's.name'], order: 'y.id DESC' },
    async counts(db, ids) { return new Map(ids.map(id => [id, {}])); },
    async remove(db, ids) { await db.query('DELETE FROM payments WHERE id = ANY($1)', [ids]); },
    audit: (r) => ({ amount: r.amount })
  },
  invoice: {
    label: 'invoice', words: 'invoices', sort: 5,
    q: { alias: 'i', cols: `i.id, i.invoice_number AS number, po.po_number AS title, i.status, i.invoice_date::text AS created, i.invoice_amount::float AS amount`, from: `purchase_invoices i JOIN purchase_orders po ON po.id = i.po_id`, search: ['i.invoice_number', 'po.po_number'], order: 'i.id DESC' },
    async counts(db, ids) { const m = await tally(db, 'SELECT invoice_id AS k, COUNT(*) AS n FROM three_way_match WHERE invoice_id = ANY($1) GROUP BY invoice_id', ids); return new Map(ids.map(id => [id, { 'Invoice checks': take(m, id) }])); },
    async remove(db, ids) { await db.query('DELETE FROM three_way_match WHERE invoice_id = ANY($1)', [ids]); await db.query('DELETE FROM purchase_invoices WHERE id = ANY($1)', [ids]); },
    audit: (r) => ({ amount: r.amount })
  },
  branch_request: {
    label: 'branch request', words: 'branch requests', sort: 6,
    q: { alias: 'b', cols: `b.id, b.request_number AS number, b.branch AS title, b.status, b.created_at::date::text AS created, b.requested_by AS who`, from: `branch_stock_requests b`, search: ['b.request_number', 'b.branch', 'b.requested_by'], order: 'b.id DESC' },
    async counts(db, ids) {
      const [items, plans, links] = await Promise.all([
        tally(db, 'SELECT request_id AS k, COUNT(*) AS n FROM branch_request_items WHERE request_id = ANY($1) GROUP BY request_id', ids),
        tally(db, 'SELECT request_id AS k, COUNT(*) AS n FROM material_plans WHERE request_id = ANY($1) GROUP BY request_id', ids),
        tally(db, "SELECT source_id AS k, COUNT(*) AS n FROM po_source_links WHERE source_type = 'branch' AND source_id = ANY($1) GROUP BY source_id", ids)]);
      const rec = (await hasTable(db, 'branch_receipts')) ? await tally(db, 'SELECT request_id AS k, COUNT(*) AS n FROM branch_receipts WHERE request_id = ANY($1) GROUP BY request_id', ids) : new Map();
      return new Map(ids.map(id => [id, { Items: take(items, id), 'Material plans': take(plans, id), 'Delivery confirmations': take(rec, id), 'Links to orders': take(links, id) }]));
    },
    async remove(db, ids) {
      await db.query('DELETE FROM material_plans WHERE request_id = ANY($1)', [ids]);
      await db.query("DELETE FROM po_source_links WHERE source_type = 'branch' AND source_id = ANY($1)", [ids]);
      await db.query('DELETE FROM branch_stock_requests WHERE id = ANY($1)', [ids]);        // lines and delivery confirmations go with it
    }
  },
  indent: {
    label: 'production request', words: 'production requests', sort: 7,
    q: { alias: 'i', cols: `i.id, i.indent_number AS number, i.production_head AS title, i.status, i.created_at::date::text AS created`, from: `production_indents i`, search: ['i.indent_number', 'i.production_head'], order: 'i.id DESC' },
    async counts(db, ids) {
      const [items, plans, reqs, links] = await Promise.all([
        tally(db, 'SELECT indent_id AS k, COUNT(*) AS n FROM production_indent_items WHERE indent_id = ANY($1) GROUP BY indent_id', ids),
        tally(db, 'SELECT indent_id AS k, COUNT(*) AS n FROM material_plans WHERE indent_id = ANY($1) GROUP BY indent_id', ids),
        tally(db, 'SELECT planned_indent_id AS k, COUNT(*) AS n FROM branch_stock_requests WHERE planned_indent_id = ANY($1) GROUP BY planned_indent_id', ids),
        tally(db, "SELECT source_id AS k, COUNT(*) AS n FROM po_source_links WHERE source_type = 'production' AND source_id = ANY($1) GROUP BY source_id", ids)]);
      return new Map(ids.map(id => [id, { Items: take(items, id), 'Material plans': take(plans, id), 'Branch requests planned from it': take(reqs, id), 'Links to orders': take(links, id) }]));
    },
    async remove(db, ids) {
      await db.query('DELETE FROM material_plans WHERE indent_id = ANY($1)', [ids]);
      await db.query('UPDATE branch_stock_requests SET planned_indent_id = NULL WHERE planned_indent_id = ANY($1)', [ids]);      // those requests are not planned any more
      await db.query("DELETE FROM po_source_links WHERE source_type = 'production' AND source_id = ANY($1)", [ids]);
      await db.query('DELETE FROM production_indents WHERE id = ANY($1)', [ids]);
    }
  },
  supplier: {
    label: 'supplier', words: 'suppliers', sort: 8,
    q: { alias: 's', cols: `s.id, NULL::text AS number, s.name AS title, s.status, s.created_at::date::text AS created`, from: `suppliers s`, search: ['s.name'], order: 's.name' },
    async counts(db, ids) {
      const [po, pay] = await Promise.all([tally(db, 'SELECT supplier_id AS k, COUNT(*) AS n FROM purchase_orders WHERE supplier_id = ANY($1) GROUP BY supplier_id', ids), tally(db, 'SELECT supplier_id AS k, COUNT(*) AS n FROM payments WHERE supplier_id = ANY($1) GROUP BY supplier_id', ids)]);
      return new Map(ids.map(id => [id, { 'Purchase orders': take(po, id), Payments: take(pay, id) }]));
    },
    blocked(c) { const used = [c['Purchase orders'] && plural(c['Purchase orders'], 'purchase order'), c.Payments && plural(c.Payments, 'payment')].filter(Boolean); return used.length ? `Used by ${used.join(' and ')}. Remove those first, or switch the supplier off instead.` : null; },
    async remove(db, ids) { await db.query('DELETE FROM suppliers WHERE id = ANY($1)', [ids]); }
  },
  material: {
    label: 'raw material', words: 'raw materials', sort: 9,
    q: { alias: 'm', cols: `m.id, m.code AS number, m.name AS title, CASE WHEN m.active THEN 'Active' ELSE 'Switched off' END AS status, NULL::text AS created`, from: `raw_materials m`, search: ['m.code', 'm.name'], order: 'm.name' },
    async counts(db, ids) { const m = await tally(db, 'SELECT material_id AS k, COUNT(*) AS n FROM bom_lines WHERE material_id = ANY($1) GROUP BY material_id', ids); return new Map(ids.map(id => [id, { 'Recipe lines': take(m, id) }])); },
    blocked(c) { return c['Recipe lines'] ? `Used in ${plural(c['Recipe lines'], 'recipe line')}. Take it out of those recipes first, or switch it off instead.` : null; },
    async remove(db, ids) { await db.query('DELETE FROM raw_materials WHERE id = ANY($1)', [ids]); }
  },
  product: {
    label: 'finished product', words: 'finished products', sort: 10,
    q: { alias: 'p', cols: `p.id, p.code AS number, p.name AS title, CASE WHEN p.active THEN 'Active' ELSE 'Switched off' END AS status, NULL::text AS created`, from: `products p`, search: ['p.code', 'p.name'], order: 'p.name' },
    async counts(db, ids) {
      const [req, rec, al] = await Promise.all([tally(db, 'SELECT product_id AS k, COUNT(*) AS n FROM branch_request_items WHERE product_id = ANY($1) GROUP BY product_id', ids),
        tally(db, 'SELECT product_id AS k, COUNT(*) AS n FROM recipe_versions WHERE product_id = ANY($1) GROUP BY product_id', ids), tally(db, 'SELECT product_id AS k, COUNT(*) AS n FROM product_aliases WHERE product_id = ANY($1) GROUP BY product_id', ids)]);
      return new Map(ids.map(id => [id, { 'Branch request lines': take(req, id), 'Recipe versions': take(rec, id), 'Other names': take(al, id) }]));
    },
    blocked(c) { return c['Branch request lines'] ? `Branches have requested it on ${plural(c['Branch request lines'], 'request line')}. Remove those requests first, or switch the product off instead.` : null; },
    async remove(db, ids) { await db.query('DELETE FROM products WHERE id = ANY($1)', [ids]); }          // its recipes and other names go with it
  }
};
/** Rows of a kind: the newest 300 matching what was typed, or exactly the given ids (locked while they are removed). */
const listRows = (db, kind, q) => { const s = KINDS[kind].q, like = likeArg(q);
  return db.query(`SELECT ${s.cols} FROM ${s.from} WHERE ($1 = '' OR ${s.search.map(c => `${c} ILIKE '%' || $1 || '%'`).join(' OR ')}) ORDER BY ${s.order} LIMIT 300`, [like]).then(r => r.rows); };
const rowsByIds = (db, kind, ids, lock) => { const s = KINDS[kind].q;
  return db.query(`SELECT ${s.cols} FROM ${s.from} WHERE ${s.alias}.id = ANY($1) ORDER BY ${s.order}${lock ? ` FOR UPDATE OF ${s.alias}` : ''}`, [ids]).then(r => r.rows); };
const nonZero = (c) => Object.fromEntries(Object.entries(c).filter(([, v]) => v !== 0 && v !== '0 of 0'));
const countsText = (c) => Object.entries(nonZero(c)).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(', ') || 'nothing else under it';
const expectedConfirm = (kind, rows) => (rows.length === 1 ? (rows[0].number || 'DELETE') : `DELETE ${rows.length} ${KINDS[kind].words.toUpperCase()}`);

router.get('/', (req, res) => res.json({ success: true, kinds: Object.entries(KINDS).sort((a, b) => a[1].sort - b[1].sort).map(([kind, k]) => ({ kind, label: k.label, words: k.words })) }));

router.get('/:kind', async (req, res) => {
  const k = KINDS[req.params.kind]; if (!k) return fail(res, 404, 'Unknown kind of record');
  try {
    const one = idOf(req.query.id);                                                  // ?id= opens the details of a single record (used by the remove button on a record's own page)
    const rows = one ? await rowsByIds(pool, req.params.kind, [one]) : await listRows(pool, req.params.kind, req.query.q), ids = rows.map(r => r.id), counts = ids.length ? await k.counts(pool, ids) : new Map();
    res.json({ success: true, kind: req.params.kind, label: k.label, words: k.words, shown: rows.length,
      rows: rows.map(r => { const c = counts.get(r.id) || {}; return { ...r, counts: nonZero(c), blocked: k.blocked ? k.blocked(c) : null }; }) });
  } catch (err) { console.error('admin records list failed:', err); fail(res, 500, 'Could not load the records'); }
});

router.post('/:kind/delete', async (req, res) => {
  const kind = req.params.kind, k = KINDS[kind]; if (!k) return fail(res, 404, 'Unknown kind of record');
  const b = req.body || {}, reason = reasonOf(b);
  const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(idOf).filter(Boolean))];
  if (!ids.length) return fail(res, 400, 'Choose at least one record');
  if (ids.length > MAX_BULK) return fail(res, 400, `Remove at most ${MAX_BULK} records at a time`);
  if (reason.length < 5) return fail(res, 400, 'Write why the data is being removed (at least 5 letters)');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await rowsByIds(client, kind, ids, true);
    if (found.length !== ids.length) { await client.query('ROLLBACK'); return fail(res, 404, 'One of the records no longer exists. Reload the list.'); }
    const expected = expectedConfirm(kind, found);
    if (String(b.confirm || '').trim() !== expected) { await client.query('ROLLBACK'); return fail(res, 400, `To confirm, type exactly: ${expected}`); }
    const counts = await k.counts(client, ids);
    if (k.blocked) { const stop = found.find(r => k.blocked(counts.get(r.id) || {})); if (stop) { await client.query('ROLLBACK'); return fail(res, 409, `${stop.number || stop.title}: ${k.blocked(counts.get(stop.id))}`); } }
    await k.remove(client, ids);
    for (const r of found) {
      const c = counts.get(r.id) || {};
      await audit(client, req, { action: `admin.${kind}_delete`, entity: kind, id: r.id, summary: `Removed ${k.label} ${r.number || r.title}${r.number && r.title ? ' (' + r.title + ')' : ''}: ${countsText(c)}`,
        before: { number: r.number, title: r.title, status: r.status, ...(k.audit ? k.audit(r) : {}), under_it: nonZero(c) }, reason });
    }
    await client.query('COMMIT');
    res.json({ success: true, removed: found.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('admin records delete failed:', err); fail(res, 500, 'Could not remove the records. Nothing was removed.');
  } finally { client.release(); }
});

module.exports = router;
module.exports.KINDS = KINDS;
