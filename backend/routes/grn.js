// routes/grn.js - Goods Receipt Note APIs.
//   POST /api/grn/create          create a GRN for a PO
//   GET  /api/grn                 list all GRNs (?discrepancies=true -> only ones with a mismatch)
//   GET  /api/grn/discrepancies   every item where received qty differs from ordered qty
//   GET  /api/grn/:id             one GRN with its items
//   PUT  /api/grn/:id/approve     QC decision on a pending GRN

const express = require('express');
const { pool } = require('../database');
const { notify } = require('../notify');
const { audit } = require('../audit');
const { fail, todayISO, isValidDate, stamp, nextNumber } = require('../utils');
const { requirePermission } = require('../auth');
const { KEYS } = require('../permissions');
const { can } = require('../access');
const R = require('../rd-logic');          // the same file checks as lab-trial photos: the file's own bytes decide what it is
const router = express.Router();

const CONDITIONS = ['Good', 'Damaged', 'Short'];
const PO_FLOW = ['created', 'payment_pending', 'payment_done', 'in_transit', 'delivered', 'closed'];

/** Rounds to 3 decimals (quantities can be fractional, e.g. 2.5 Kg). */
const round3 = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;

// ------------------------------------------------------------
// POST /api/grn/create
// body: { po_id, grn_date?, received_by, storage_location?, qc_notes?, qc_approved,
//         condition?, items: [{ po_item_id | item_name, received_qty, condition? }] }
// Ordered quantities are read from the PO in the database (not trusted from the browser).
// Every PO item must appear in items[].
// ------------------------------------------------------------
router.post('/create', requirePermission(KEYS.GRN_CREATE), async (req, res) => {
  const b = req.body || {};

  const poId = Number(b.po_id);
  if (!Number.isInteger(poId) || poId <= 0) return fail(res, 400, 'Please select a PO');

  const receivedBy = req.user.name; // the signed-in receiver, recorded automatically

  const grnDate = b.grn_date || todayISO();
  if (!isValidDate(grnDate)) return fail(res, 400, 'GRN date must be a valid date (YYYY-MM-DD)');

  if (b.condition && !CONDITIONS.includes(b.condition)) {
    return fail(res, 400, 'Condition must be Good, Damaged or Short');
  }
  if (!Array.isArray(b.items) || b.items.length === 0) return fail(res, 400, 'Enter received quantities');

  for (let i = 0; i < b.items.length; i++) {
    const it = b.items[i];
    const qty = Number(it.received_qty);
    if (it.received_qty === '' || it.received_qty === null || !isFinite(qty) || qty < 0) {
      return fail(res, 400, `Item ${i + 1}: received quantity must be 0 or more`);
    }
    if (it.condition && !CONDITIONS.includes(it.condition)) {
      return fail(res, 400, `Item ${i + 1}: condition must be Good, Damaged or Short`);
    }
    if (it.variance_note && String(it.variance_note).trim().length > 200) return fail(res, 400, `Item ${i + 1}: the reason for the difference is at most 200 characters`);
    if (!it.po_item_id && !it.item_name) return fail(res, 400, `Item ${i + 1}: item is not identified`);
  }

  const qcApproved = b.qc_approved === true || b.qc_approved === 'true';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const po = await client.query(
      'SELECT id, po_number, status FROM purchase_orders WHERE id = $1 FOR UPDATE', [poId]);
    if (po.rowCount === 0) { await client.query('ROLLBACK'); return fail(res, 404, 'PO not found'); }

    const dup = await client.query(
      "SELECT grn_number FROM grn_notes WHERE po_id = $1 AND status <> 'rejected' LIMIT 1", [poId]);
    if (dup.rowCount > 0) {
      await client.query('ROLLBACK');
      return fail(res, 400, `This PO already has a GRN (${dup.rows[0].grn_number})`);
    }

    // Match every ordered item with what the user entered.
    const poItems = (await client.query(
      'SELECT id, item_name, quantity FROM po_items WHERE po_id = $1 ORDER BY id', [poId])).rows;
    const used = new Set();
    const lines = [];
    for (const pi of poItems) {
      const idx = b.items.findIndex((it, i) => !used.has(i) &&
        (Number(it.po_item_id) === pi.id || (!it.po_item_id && it.item_name === pi.item_name)));
      if (idx === -1) {
        await client.query('ROLLBACK');
        return fail(res, 400, `Missing received quantity for "${pi.item_name}"`);
      }
      used.add(idx);
      const entry = b.items[idx];
      const ordered = Number(pi.quantity);
      const received = Number(entry.received_qty);
      const variance = round3(received - ordered);            // negative = short
      lines.push({
        item_name: pi.item_name,
        po_quantity: ordered,
        received_quantity: received,
        variance,
        variance_note: entry.variance_note && String(entry.variance_note).trim() ? String(entry.variance_note).trim() : null,
        condition: entry.condition || (variance < 0 ? 'Short' : 'Good')
      });
    }
    if (used.size !== b.items.length) {
      await client.query('ROLLBACK');
      return fail(res, 400, 'Some items do not belong to this PO');
    }

    // Overall condition: what the user chose, otherwise the worst item condition.
    const worst = lines.some(l => l.condition === 'Damaged') ? 'Damaged'
                : lines.some(l => l.condition === 'Short') ? 'Short' : 'Good';
    const condition = b.condition || worst;
    const status = qcApproved ? 'approved' : 'pending_qc';

    const grnNumber = await nextNumber(client, 'grn_notes', 'grn_number', `GRN-${stamp(grnDate)}-`);
    const grn = await client.query(
      `INSERT INTO grn_notes
         (grn_number, grn_date, po_id, received_by, total_items, status, qc_notes, storage_location, condition, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [grnNumber, grnDate, poId, receivedBy, lines.length, status,
       b.qc_notes ? String(b.qc_notes).trim() : null,
       b.storage_location ? String(b.storage_location).trim() : null, condition, req.user.id]);
    const grnId = grn.rows[0].id;

    for (const l of lines) {
      await client.query(
        `INSERT INTO grn_items (grn_id, item_name, po_quantity, received_quantity, variance, condition, variance_note)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [grnId, l.item_name, l.po_quantity, l.received_quantity, l.variance, l.condition, l.variance_note]);
    }

    // Goods have arrived -> PO becomes "delivered" (never moves a PO backwards).
    if (PO_FLOW.indexOf(po.rows[0].status) < PO_FLOW.indexOf('delivered')) {
      await client.query("UPDATE purchase_orders SET status = 'delivered' WHERE id = $1", [poId]);
    }

    await audit(client, req, { action: 'grn.create', entity: 'grn', id: grnId, summary: `${grnNumber} against ${po.rows[0].po_number}`, after: { status, condition } });
    await client.query('COMMIT');

    const short = lines.filter(l => l.variance < 0);
    notify({ roles: ['purchase', 'accounts'], subject: 'Goods received ' + grnNumber, text: `Goods received against ${po.rows[0].po_number} (${grnNumber})` + (lines.some(l => l.variance !== 0) ? ' - with a quantity difference, please check.' : '.'), path: 'grn-detail.html?id=' + grnId });
    res.status(201).json({
      success: true,
      grn_id: grnId,
      grn_number: grnNumber,
      po_number: po.rows[0].po_number,
      discrepancies: lines.some(l => l.variance !== 0),
      short_items: short.map(l => ({ item_name: l.item_name, variance: l.variance })),
      condition,
      status
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Create GRN failed:', err);
    fail(res, 500, 'Could not create GRN');
  } finally {
    client.release();
  }
});

// ------------------------------------------------------------
// GET /api/grn - list GRNs, newest first. ?discrepancies=true keeps only mismatches.
// ------------------------------------------------------------
router.get('/', requirePermission(KEYS.GRN_VIEW), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM (
         SELECT g.id, g.grn_number, g.grn_date, g.received_by, g.status, g.condition,
                g.total_items, g.po_id, g.created_at, po.po_number, s.name AS supplier_name,
                (SELECT COUNT(*)::int FROM grn_items i WHERE i.grn_id = g.id AND i.variance <> 0)
                  AS discrepancy_count,
                (SELECT COUNT(*)::int FROM grn_attachments a WHERE a.grn_id = g.id AND a.removed_at IS NULL) AS file_count
           FROM grn_notes g
           JOIN purchase_orders po ON po.id = g.po_id
           JOIN suppliers s ON s.id = po.supplier_id
       ) x
       WHERE ($1::boolean IS NOT TRUE OR discrepancy_count > 0)
       ORDER BY id DESC`,
      [req.query.discrepancies === 'true']);
    res.json({ success: true, count: result.rowCount, grns: result.rows });
  } catch (err) {
    console.error(err);
    fail(res, 500, 'Could not load GRNs');
  }
});

// ------------------------------------------------------------
// GET /api/grn/discrepancies - item-level list of quantity mismatches
// (declared before /:id so "discrepancies" is not read as an id)
// ------------------------------------------------------------
router.get('/discrepancies', requirePermission(KEYS.GRN_VIEW), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT i.item_name, i.po_quantity, i.received_quantity, i.variance, i.condition,
              g.id AS grn_id, g.grn_number, g.grn_date, po.po_number, s.name AS supplier_name
         FROM grn_items i
         JOIN grn_notes g ON g.id = i.grn_id
         JOIN purchase_orders po ON po.id = g.po_id
         JOIN suppliers s ON s.id = po.supplier_id
        WHERE i.variance <> 0
        ORDER BY g.id DESC, i.id`);
    res.json({ success: true, count: result.rowCount, discrepancies: result.rows });
  } catch (err) {
    console.error(err);
    fail(res, 500, 'Could not load discrepancies');
  }
});

// ------------------------------------------------------------
// GET /api/grn/:id - one GRN with items
// ------------------------------------------------------------
router.get('/:id', requirePermission(KEYS.GRN_VIEW), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid GRN id');
  try {
    const grn = await pool.query(
      `SELECT g.*, po.po_number, s.name AS supplier_name
         FROM grn_notes g
         JOIN purchase_orders po ON po.id = g.po_id
         JOIN suppliers s ON s.id = po.supplier_id
        WHERE g.id = $1`, [id]);
    if (grn.rowCount === 0) return fail(res, 404, 'GRN not found');
    const items = await pool.query('SELECT * FROM grn_items WHERE grn_id = $1 ORDER BY id', [id]);
    const files = await pool.query('SELECT id, kind, note, file_name, mime, size_bytes, uploaded_by_name AS by, created_at AS at FROM grn_attachments WHERE grn_id = $1 AND removed_at IS NULL ORDER BY id', [id]);   // never the file itself
    res.json({ success: true, grn: grn.rows[0], items: items.rows,
               discrepancies: items.rows.some(i => Number(i.variance) !== 0),
               attachments: files.rows, can_attach: canAttach(req), limits: { attach_max_bytes: R.ATTACH_MAX_BYTES, attach_max_per_grn: ATTACH_MAX_PER_GRN } });
  } catch (err) {
    console.error(err);
    fail(res, 500, 'Could not load GRN');
  }
});

// ------------------------------------------------------------
// PUT /api/grn/:id/approve - QC decision on a "pending_qc" GRN
// body (optional): { approved: true|false, qc_notes }   (default approved = true)
// ------------------------------------------------------------
router.put('/:id/approve', requirePermission(KEYS.GRN_APPROVE), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid GRN id');
  const b = req.body || {};
  const approved = !(b.approved === false || b.approved === 'false');
  try {
    const cur = await pool.query('SELECT status, grn_number FROM grn_notes WHERE id = $1', [id]);
    if (cur.rowCount === 0) return fail(res, 404, 'GRN not found');
    if (cur.rows[0].status !== 'pending_qc') {
      return fail(res, 400, `Only "pending_qc" GRNs can be decided (this one is "${cur.rows[0].status}")`);
    }
    const status = approved ? 'approved' : 'rejected';
    await pool.query(
      'UPDATE grn_notes SET status = $1, qc_notes = COALESCE($2, qc_notes) WHERE id = $3',
      [status, b.qc_notes ? String(b.qc_notes).trim() : null, id]);
    await audit(pool, req, { action: 'grn.qc_' + status, entity: 'grn', id, summary: `${cur.rows[0].grn_number} ${status} at quality check`, before: { status: 'pending_qc' }, after: { status }, reason: b.qc_notes ? String(b.qc_notes).trim() : undefined });
    notify({ roles: ['purchase', 'accounts'], subject: 'GRN ' + status, text: `GRN ${cur.rows[0].grn_number} was ${status} at quality check.`, path: 'grn-detail.html?id=' + id });
    res.json({ success: true, grn_id: id, status });
  } catch (err) {
    console.error(err);
    fail(res, 500, 'Could not update GRN');
  }
});

// ------------------------------------------------------------
// Photos and files on a receipt: delivery challan, photos of damaged or short goods.
//   POST /api/grn/:id/attachments                   raw JPEG / PNG / PDF body, headers X-File-Name, X-File-Kind, X-File-Note
//   GET  /api/grn/:id/attachments/:attId            the file
//   POST /api/grn/:id/attachments/:attId/remove     { reason }   hides it and records who and why (the file is kept)
// Whoever may record or decide a receipt may add or remove files; whoever may see receipts may open them.
// ------------------------------------------------------------
const ATTACH_MAX_PER_GRN = 10, ATTACH_MAX_GRN_BYTES = 30 * 1024 * 1024, KINDS = ['challan', 'damage', 'other'];
const KIND_WORDS = { challan: 'delivery challan or invoice copy', damage: 'photo of damaged or short goods', other: 'file' };
const canAttach = (req) => can(req.access, KEYS.GRN_CREATE) || can(req.access, KEYS.GRN_APPROVE);
const needAttach = (req, res, next) => (canAttach(req) ? next() : fail(res, 403, 'Your role is not allowed to add or remove files on a receipt'));
const attachBody = express.raw({ type: ['image/jpeg', 'image/png', 'application/pdf'], limit: R.ATTACH_MAX_BYTES + 1024 });
const headerText = (v, max) => { try { return decodeURIComponent(String(v || '')).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max); } catch (e) { return ''; } };

router.post('/:id/attachments', requirePermission(KEYS.GRN_VIEW), needAttach, attachBody, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid GRN id');
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) return fail(res, 400, 'Send a JPEG, PNG or PDF file (no larger than ' + Math.round(R.ATTACH_MAX_BYTES / 1048576) + ' MB)');
  if (buf.length > R.ATTACH_MAX_BYTES) return fail(res, 400, 'That file is larger than ' + Math.round(R.ATTACH_MAX_BYTES / 1048576) + ' MB');
  const mime = R.sniffAttachment(buf);
  if (!mime) return fail(res, 400, 'That file is not a JPEG, PNG or PDF');
  const kind = KINDS.includes(String(req.headers['x-file-kind'] || '')) ? String(req.headers['x-file-kind']) : 'other';
  const note = headerText(req.headers['x-file-note'], 150) || null;
  const fileName = R.safeFileName(headerText(req.headers['x-file-name'], 200), mime);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const g = (await client.query('SELECT id, grn_number FROM grn_notes WHERE id = $1 FOR UPDATE', [id])).rows[0];      // the lock keeps the limits honest when two people upload together
    if (!g) { await client.query('ROLLBACK'); return fail(res, 404, 'GRN not found'); }
    const used = (await client.query('SELECT COUNT(*)::int AS n, COALESCE(SUM(size_bytes), 0)::bigint AS bytes FROM grn_attachments WHERE grn_id = $1 AND removed_at IS NULL', [id])).rows[0];
    if (used.n >= ATTACH_MAX_PER_GRN) { await client.query('ROLLBACK'); return fail(res, 409, `A receipt can have at most ${ATTACH_MAX_PER_GRN} files. Remove one first.`); }
    if (Number(used.bytes) + buf.length > ATTACH_MAX_GRN_BYTES) { await client.query('ROLLBACK'); return fail(res, 409, 'This receipt has reached its limit for stored files.'); }
    const ins = await client.query('INSERT INTO grn_attachments (grn_id, kind, note, file_name, mime, size_bytes, data, uploaded_by, uploaded_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
      [id, kind, note, fileName, mime, buf.length, buf, req.user.id, req.user.name]);
    await audit(client, req, { action: 'grn.attach', entity: 'grn', id, summary: `${g.grn_number}: ${KIND_WORDS[kind]} added`, after: { kind, type: mime, size_bytes: buf.length } });
    await client.query('COMMIT');
    res.status(201).json({ success: true, id: ins.rows[0].id, file_name: fileName, mime, size_bytes: buf.length, kind });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('grn attach failed:', err); fail(res, 500, 'Could not save the file');
  } finally { client.release(); }
});

router.get('/:id/attachments/:attId', requirePermission(KEYS.GRN_VIEW), async (req, res) => {
  const id = Number(req.params.id), attId = Number(req.params.attId);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(attId) || attId <= 0) return fail(res, 400, 'Invalid id');
  try {
    const r = await pool.query('SELECT file_name, mime, data FROM grn_attachments WHERE id = $1 AND grn_id = $2 AND removed_at IS NULL', [attId, id]);
    const f = r.rows[0]; if (!f) return fail(res, 404, 'File not found');
    res.set({ 'Content-Type': f.mime, 'Content-Length': f.data.length, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': `${f.mime === 'application/pdf' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(f.file_name)}` });
    res.send(f.data);
  } catch (err) { console.error('grn file failed:', err); fail(res, 500, 'Could not load the file'); }
});

router.post('/:id/attachments/:attId/remove', requirePermission(KEYS.GRN_VIEW), needAttach, async (req, res) => {
  const id = Number(req.params.id), attId = Number(req.params.attId);
  const reason = String((req.body && req.body.reason) || '').trim();
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(attId) || attId <= 0) return fail(res, 400, 'Invalid id');
  if (reason.length < 5) return fail(res, 400, 'Say why you are removing this file (at least 5 characters)');
  try {
    const r = await pool.query(`UPDATE grn_attachments a SET removed_at = NOW(), removed_by_name = $3, removed_reason = $4 FROM grn_notes g
      WHERE a.id = $1 AND a.grn_id = $2 AND g.id = a.grn_id AND a.removed_at IS NULL RETURNING g.grn_number, a.kind`, [attId, id, req.user.name, reason.slice(0, 1000)]);
    if (!r.rowCount) return fail(res, 404, 'File not found');
    await audit(pool, req, { action: 'grn.attach_remove', entity: 'grn', id, summary: `${r.rows[0].grn_number}: ${KIND_WORDS[r.rows[0].kind]} removed`, reason });
    res.json({ success: true });
  } catch (err) { console.error('grn attach remove failed:', err); fail(res, 500, 'Could not remove the file'); }
});

module.exports = router;
