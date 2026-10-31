// routes/search.js - GET /api/search?q=... - the top bar's quick-jump search.
// What it searches comes from the person's PERMISSIONS (not from a fixed list per role), and requests are limited
// to the branches they are assigned to - so it never returns a link they would hit a 403 on, and a permission
// an administrator revokes stops appearing in search immediately.

const express = require('express');
const { pool } = require('../database');
const { fail } = require('../utils');
const { KEYS } = require('../permissions');
const { can, branchScope, branchClause } = require('../access');
const router = express.Router();

router.get('/', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ success: true, results: [] });
  const like = '%' + q + '%';
  const results = [];

  try {
    if (can(req.access, KEYS.PO_VIEW)) {
      const r = await pool.query(
        `SELECT po.id, po.po_number, s.name AS supplier_name FROM purchase_orders po
           JOIN suppliers s ON s.id = po.supplier_id
          WHERE po.po_number ILIKE $1 ORDER BY po.id DESC LIMIT 5`, [like]);
      r.rows.forEach(x => results.push({ type: 'Purchase Order', label: x.po_number + ' - ' + x.supplier_name, href: 'po-detail.html?id=' + x.id }));
    }
    if (can(req.access, KEYS.GRN_VIEW)) {
      const r = await pool.query(
        `SELECT g.id, g.grn_number, s.name AS supplier_name FROM grn_notes g
           JOIN purchase_orders po ON po.id = g.po_id JOIN suppliers s ON s.id = po.supplier_id
          WHERE g.grn_number ILIKE $1 ORDER BY g.id DESC LIMIT 5`, [like]);
      r.rows.forEach(x => results.push({ type: 'GRN', label: x.grn_number + ' - ' + x.supplier_name, href: 'grn-detail.html?id=' + x.id }));
    }
    if (can(req.access, KEYS.PAYMENT_VIEW_ALL)) {
      const r = await pool.query(
        `SELECT p.id, p.payment_id, p.po_id, p.utr_number, s.name AS supplier_name FROM payments p
           JOIN suppliers s ON s.id = p.supplier_id
          WHERE p.payment_id ILIKE $1 OR p.utr_number ILIKE $1 ORDER BY p.id DESC LIMIT 5`, [like]);
      r.rows.forEach(x => results.push({ type: 'Payment', label: x.payment_id + ' - ' + x.supplier_name + ' (UTR ' + x.utr_number + ')', href: 'po-detail.html?id=' + x.po_id }));
    }
    if (can(req.access, KEYS.BRANCH_REQUEST_VIEW)) {
      const params = [like];
      const scoped = branchClause(branchScope(req.access, KEYS.BRANCH_REQUEST_VIEW), 'branch', params);
      const r = await pool.query(
        `SELECT id, request_number, branch FROM branch_stock_requests
          WHERE request_number ILIKE $1${scoped} ORDER BY id DESC LIMIT 5`, params);
      r.rows.forEach(x => results.push({ type: 'Branch Request', label: x.request_number + ' - ' + x.branch, href: 'branch-request-detail.html?id=' + x.id }));
    }
    if (can(req.access, KEYS.PRODUCTION_INDENT_VIEW)) {
      const r = await pool.query(
        `SELECT id, indent_number, production_head FROM production_indents
          WHERE indent_number ILIKE $1 ORDER BY id DESC LIMIT 5`, [like]);
      r.rows.forEach(x => results.push({ type: 'Production Indent', label: x.indent_number + ' - ' + x.production_head, href: 'production-indent-detail.html?id=' + x.id }));
    }
    res.json({ success: true, results: results.slice(0, 10) });
  } catch (err) {
    console.error('Search failed:', err);
    fail(res, 500, 'Search failed');
  }
});

module.exports = router;
