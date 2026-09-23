// routes/tally.js - TallyPrime sync (MOCK MODE for week 1).
//   POST /api/tally/sync/:po_id   build the Tally vouchers for a PO and log them
//   GET  /api/tally/log           everything logged so far
//
// Tally is not connected yet, so nothing is posted. Each sync builds the entries that
// WOULD be sent, prints them to the console and appends them to mock-tally-sync.json.

const fs = require('fs');
const path = require('path');
const express = require('express');
const { pool } = require('../database');
const { fail } = require('../utils');
const { requirePermission } = require('../auth');
const { KEYS } = require('../permissions');
const router = express.Router();

const LOG_FILE = path.join(__dirname, '..', 'mock-tally-sync.json');
// Ledger names must match the ledgers in your Tally company. Change them in .env.
const BANK_LEDGER = process.env.TALLY_BANK_LEDGER || 'Bank Account';
const ADVANCE_LEDGER = process.env.TALLY_ADVANCE_LEDGER || 'Advance to Suppliers';
const PURCHASE_LEDGER = process.env.TALLY_PURCHASE_LEDGER || 'Purchases';
const GST_INPUT_LEDGER = process.env.TALLY_GST_INPUT_LEDGER || 'GST Input';
const PAYABLE_LEDGER = process.env.TALLY_PAYABLE_LEDGER || 'Supplier Payable';
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Reads the log file (an array). A missing or damaged file counts as empty. */
function readLog() {
  try {
    const data = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

// ------------------------------------------------------------
// POST /api/tally/sync/:po_id
// ------------------------------------------------------------
router.post('/sync/:po_id', requirePermission(KEYS.TALLY_SYNC), async (req, res) => {
  const poId = Number(req.params.po_id);
  if (!Number.isInteger(poId) || poId <= 0) return fail(res, 400, 'Invalid PO id');
  try {
    const po = await pool.query(
      `SELECT po.*, s.name AS supplier_name FROM purchase_orders po
         JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = $1`, [poId]);
    if (po.rowCount === 0) return fail(res, 404, 'PO not found');
    const p = po.rows[0];

    const items = (await pool.query('SELECT * FROM po_items WHERE po_id = $1 ORDER BY id', [poId])).rows;
    const pays = (await pool.query(
      "SELECT * FROM payments WHERE po_id = $1 AND status = 'confirmed' ORDER BY id", [poId])).rows;

    const vouchers = [];

    // 1) The purchase order itself
    vouchers.push({
      voucher_type: 'Purchase Order',
      voucher_number: p.po_number,
      date: p.po_date,
      party_ledger: p.supplier_name,
      items: items.map(i => ({
        stock_item: i.item_name, quantity: Number(i.quantity), unit: i.unit,
        rate: Number(i.rate), amount: Number(i.line_amount)
      })),
      tax_ledgers: [
        { ledger: 'CGST', amount: Number(p.cgst_amount) },
        { ledger: 'SGST', amount: Number(p.sgst_amount) }
      ],
      total_amount: Number(p.total_amount),
      narration: `PO ${p.po_number} to ${p.supplier_name}`
    });

    // 2) Each confirmed advance payment: Dr Advance to Supplier, Cr Bank
    for (const pay of pays) {
      vouchers.push({
        voucher_type: 'Journal',
        voucher_number: pay.payment_id,
        date: pay.payment_date,
        entries: [
          { ledger: `${ADVANCE_LEDGER} - ${p.supplier_name}`, type: 'Dr', amount: Number(pay.amount) },
          { ledger: BANK_LEDGER, type: 'Cr', amount: Number(pay.amount) }
        ],
        narration: `Advance for ${p.po_number}, UTR ${pay.utr_number}`
      });
    }

    // 3) Goods actually received (GRN, valued at PO rates): Dr Purchases + GST Input, Cr Supplier Payable
    const grn = (await pool.query(
      "SELECT id, grn_number FROM grn_notes WHERE po_id = $1 AND status <> 'rejected' ORDER BY id DESC LIMIT 1",
      [poId])).rows[0];
    if (grn) {
      const valued = (await pool.query(
        `SELECT COALESCE(SUM(gi.received_quantity * pi.rate), 0) AS subtotal
           FROM grn_items gi JOIN po_items pi ON pi.po_id = $2 AND pi.item_name = gi.item_name
          WHERE gi.grn_id = $1`, [grn.id, poId])).rows[0];
      const subtotal = round2(Number(valued.subtotal));
      const cgstRate = Number(process.env.CGST_RATE ?? 9), sgstRate = Number(process.env.SGST_RATE ?? 9);
      const cgst = round2(subtotal * cgstRate / 100);
      const sgst = round2(subtotal * sgstRate / 100);
      const payable = round2(subtotal + cgst + sgst);
      vouchers.push({
        voucher_type: 'Journal',
        voucher_number: grn.grn_number,
        date: p.po_date,
        entries: [
          { ledger: PURCHASE_LEDGER, type: 'Dr', amount: subtotal },
          { ledger: GST_INPUT_LEDGER, type: 'Dr', amount: round2(cgst + sgst) },
          { ledger: `${PAYABLE_LEDGER} - ${p.supplier_name}`, type: 'Cr', amount: payable }
        ],
        narration: `Goods received against ${p.po_number} (${grn.grn_number}), valued at PO rates`
      });
    }

    const record = { synced_at: new Date().toISOString(), mode: 'mock', po_number: p.po_number, vouchers };
    const log = readLog();
    log.push(record);
    fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
    console.log('Would have posted to Tally:', JSON.stringify(record));

    // Mark the PO as posted (never move it backwards out of "closed").
    if (p.status !== 'closed') {
      await pool.query("UPDATE purchase_orders SET status = 'posted_to_tally' WHERE id = $1", [poId]);
    }

    res.json({
      success: true,
      mode: 'mock',
      message: 'Tally is not connected. Entries were logged to mock-tally-sync.json, not posted.',
      po_number: p.po_number,
      voucher_count: vouchers.length,
      vouchers,
      po_status: p.status !== 'closed' ? 'posted_to_tally' : p.status
    });
  } catch (err) {
    console.error('Tally sync failed:', err);
    fail(res, 500, 'Could not prepare Tally entries');
  }
});

// GET /api/tally/log - what has been "synced" so far
router.get('/log', requirePermission(KEYS.TALLY_VIEW_LOG), (req, res) => {
  const log = readLog();
  res.json({ success: true, count: log.length, log });
});

module.exports = router;
