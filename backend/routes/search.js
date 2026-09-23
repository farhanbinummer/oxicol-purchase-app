// routes/search.js - GET /api/search?q=... - the top bar's quick-jump search.
// Only searches the entity types this role is actually allowed to open, and (for the
// branch role) only that branch's own requests - never returns a link the role would hit a 403 on.

const express = require('express');
const { pool } = require('../database');
const { fail } = require('../utils');
const router = express.Router();

// Which entity types each role's search should cover.
const ROLE_TYPES = {
  branch: ['branch_request'],
  production: ['production_indent'],
  store: ['branch_request', 'production_indent', 'po', 'grn'],
  purchase: ['po', 'grn', 'payment'],
  accounts: ['po', 'grn', 'payment'],
  admin: ['po', 'grn', 'payment', 'branch_request', 'production_indent']
};

router.get('/', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ success: true, results: [] });
  const like = '%' + q + '%';
  const types = ROLE_TYPES[req.user.role] || [];
  const results = [];

  try {
    if (types.includes('po')) {
      const r = await pool.query(
        `SELECT po.id, po.po_number, s.name AS supplier_name FROM purchase_orders po
           JOIN suppliers s ON s.id = po.supplier_id
          WHERE po.po_number ILIKE $1 ORDER BY po.id DESC LIMIT 5`, [like]);
      r.rows.forEach(x => results.push({
        type: 'Purchase Order', label: x.po_number + ' - ' + x.supplier_name,
        href: 'po-detail.html?id=' + x.id
      }));
    }
    if (types.includes('grn')) {
      const r = await pool.query(
        `SELECT g.id, g.grn_number, s.name AS supplier_name FROM grn_notes g
           JOIN purchase_orders po ON po.id = g.po_id JOIN suppliers s ON s.id = po.supplier_id
          WHERE g.grn_number ILIKE $1 ORDER BY g.id DESC LIMIT 5`, [like]);
      r.rows.forEach(x => results.push({
        type: 'GRN', label: x.grn_number + ' - ' + x.supplier_name,
        href: 'grn-detail.html?id=' + x.id
      }));
    }
    if (types.includes('payment')) {
      const r = await pool.query(
        `SELECT p.id, p.payment_id, p.po_id, p.utr_number, s.name AS supplier_name FROM payments p
           JOIN suppliers s ON s.id = p.supplier_id
          WHERE p.payment_id ILIKE $1 OR p.utr_number ILIKE $1 ORDER BY p.id DESC LIMIT 5`, [like]);
      r.rows.forEach(x => results.push({
        type: 'Payment', label: x.payment_id + ' - ' + x.supplier_name + ' (UTR ' + x.utr_number + ')',
        href: 'po-detail.html?id=' + x.po_id
      }));
    }
    if (types.includes('branch_request')) {
      const params = [like];
      let branchClause = '';
      if (req.user.role === 'branch') { params.push(req.user.branch); branchClause = ' AND branch = $2'; }
      const r = await pool.query(
        `SELECT id, request_number, branch FROM branch_stock_requests
          WHERE request_number ILIKE $1${branchClause} ORDER BY id DESC LIMIT 5`, params);
      r.rows.forEach(x => results.push({
        type: 'Branch Request', label: x.request_number + ' - ' + x.branch,
        href: 'branch-request-list.html'
      }));
    }
    if (types.includes('production_indent')) {
      const r = await pool.query(
        `SELECT id, indent_number, production_head FROM production_indents
          WHERE indent_number ILIKE $1 ORDER BY id DESC LIMIT 5`, [like]);
      r.rows.forEach(x => results.push({
        type: 'Production Indent', label: x.indent_number + ' - ' + x.production_head,
        href: 'production-indent-list.html'
      }));
    }

    res.json({ success: true, results: results.slice(0, 10) });
  } catch (err) {
    console.error('Search failed:', err);
    fail(res, 500, 'Search failed');
  }
});

module.exports = router;
