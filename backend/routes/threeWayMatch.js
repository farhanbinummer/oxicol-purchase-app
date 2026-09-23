// routes/threeWayMatch.js - GET /api/three-way-match/:po_id
// Match history for one PO (newest first). Kept as its own tiny router so the
// URL matches the brief exactly (/api/three-way-match/... vs /api/invoice/...).

const express = require('express');
const { pool } = require('../database');
const { fail } = require('../utils');
const { requirePermission } = require('../auth');
const { KEYS } = require('../permissions');
const router = express.Router();

router.get('/:po_id', requirePermission(KEYS.THREE_WAY_MATCH_VIEW), async (req, res) => {
  const poId = Number(req.params.po_id);
  if (!Number.isInteger(poId) || poId <= 0) return fail(res, 400, 'Invalid PO id');
  try {
    const result = await pool.query(
      `SELECT m.*, i.invoice_number FROM three_way_match m
         JOIN purchase_invoices i ON i.id = m.invoice_id
        WHERE m.po_id = $1 ORDER BY m.id DESC`, [poId]);
    res.json({ success: true, count: result.rowCount, matches: result.rows });
  } catch (err) {
    console.error(err);
    fail(res, 500, 'Could not load match history');
  }
});

module.exports = router;
