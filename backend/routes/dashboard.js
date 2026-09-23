// routes/dashboard.js - home-page numbers, charts and the variance report.
//   GET /api/dashboard/summary
//   GET /api/dashboard/variance-report
//   GET /api/dashboard/analytics        monthly purchase trend + top suppliers by value
//   GET /api/dashboard/recent-activity   latest POs/payments/GRNs, newest first

const express = require('express');
const { pool } = require('../database');
const { fail } = require('../utils');
const { requirePermission } = require('../auth');
const { KEYS } = require('../permissions');
const router = express.Router();

router.get('/summary', requirePermission(KEYS.DASHBOARD_VIEW), async (req, res) => {
  try {
    const q = (sql) => pool.query(sql).then(r => r.rows[0].n);
    // A rejected GRN "awaiting resupply" = rejected, and this PO has no OTHER GRN
    // that isn't rejected - i.e. nothing has arrived to replace what was sent back yet.
    const REJECTED_AWAITING_SQL = `
      SELECT COUNT(*)::int n FROM grn_notes g
       WHERE g.status = 'rejected'
         AND NOT EXISTS (SELECT 1 FROM grn_notes g2 WHERE g2.po_id = g.po_id AND g2.status <> 'rejected')`;

    const [
      pendingBranchRequests, pendingIndents, activePOs, pendingPayments,
      inTransit, grnDiscrepancies, invoiceVariances, rejectedAwaitingResupply,
      openInvoices, pendingGrnQc
    ] = await Promise.all([
      q("SELECT COUNT(*)::int n FROM branch_stock_requests WHERE status IN ('pending','approved')"),
      q("SELECT COUNT(*)::int n FROM production_indents WHERE status IN ('pending','approved')"),
      q("SELECT COUNT(*)::int n FROM purchase_orders WHERE status NOT IN ('closed')"),
      q("SELECT COUNT(*)::int n FROM purchase_orders WHERE status IN ('created','payment_pending')"),
      q("SELECT COUNT(*)::int n FROM purchase_orders WHERE status = 'in_transit'"),
      q("SELECT COUNT(DISTINCT grn_id)::int n FROM grn_items WHERE variance <> 0"),
      q("SELECT COUNT(*)::int n FROM three_way_match WHERE status <> 'matched'"),
      q(REJECTED_AWAITING_SQL),
      q("SELECT COUNT(*)::int n FROM purchase_invoices WHERE status = 'uploaded'"),
      q("SELECT COUNT(*)::int n FROM grn_notes WHERE status = 'pending_qc'")
    ]);
    const totalValue = await pool.query(
      "SELECT COALESCE(SUM(total_amount), 0) AS v FROM purchase_orders");
    res.json({
      success: true,
      pending_branch_requests: pendingBranchRequests,
      pending_production_indents: pendingIndents,
      active_pos: activePOs,
      pending_payments: pendingPayments,
      goods_in_transit: inTransit,
      variance_issues: grnDiscrepancies + invoiceVariances,
      rejected_awaiting_resupply: rejectedAwaitingResupply,
      open_invoices: openInvoices,
      pending_grn_qc: pendingGrnQc,
      total_purchase_value: Number(totalValue.rows[0].v)
    });
  } catch (err) {
    console.error(err);
    fail(res, 500, 'Could not load dashboard summary');
  }
});

router.get('/variance-report', requirePermission(KEYS.DASHBOARD_VIEW), async (req, res) => {
  try {
    const grn = await pool.query(
      `SELECT 'grn_short_or_excess' AS type, g.grn_number AS reference, po.po_number, s.name AS supplier_name,
              i.item_name, i.po_quantity, i.received_quantity, i.variance, NULL::numeric AS amount
         FROM grn_items i
         JOIN grn_notes g ON g.id = i.grn_id
         JOIN purchase_orders po ON po.id = g.po_id
         JOIN suppliers s ON s.id = po.supplier_id
        WHERE i.variance <> 0
        ORDER BY g.id DESC`);
    const inv = await pool.query(
      `SELECT 'invoice_variance' AS type, iv.invoice_number AS reference, po.po_number, s.name AS supplier_name,
              m.status, m.po_total, m.grn_total, m.invoice_total, m.variance_amount, m.notes
         FROM three_way_match m
         JOIN purchase_invoices iv ON iv.id = m.invoice_id
         JOIN purchase_orders po ON po.id = m.po_id
         JOIN suppliers s ON s.id = po.supplier_id
        WHERE m.status <> 'matched'
        ORDER BY m.id DESC`);
    // Rejected GRNs where nothing has replaced the goods yet - who to chase, and why.
    const rejected = await pool.query(
      `SELECT g.grn_number, g.grn_date, g.qc_notes, g.condition, po.po_number, s.name AS supplier_name
         FROM grn_notes g
         JOIN purchase_orders po ON po.id = g.po_id
         JOIN suppliers s ON s.id = po.supplier_id
        WHERE g.status = 'rejected'
          AND NOT EXISTS (SELECT 1 FROM grn_notes g2 WHERE g2.po_id = g.po_id AND g2.status <> 'rejected')
        ORDER BY g.id DESC`);
    res.json({ success: true, grn_discrepancies: grn.rows, invoice_variances: inv.rows,
               rejected_awaiting_resupply: rejected.rows });
  } catch (err) {
    console.error(err);
    fail(res, 500, 'Could not load variance report');
  }
});

// ------------------------------------------------------------
// GET /api/dashboard/analytics - monthly purchase trend (last 6 months) + top 5 suppliers
// ------------------------------------------------------------
router.get('/analytics', requirePermission(KEYS.DASHBOARD_VIEW), async (req, res) => {
  try {
    const trend = await pool.query(
      `SELECT to_char(date_trunc('month', po_date), 'YYYY-MM') AS month,
              COALESCE(SUM(total_amount), 0) AS total
         FROM purchase_orders
        WHERE po_date >= date_trunc('month', CURRENT_DATE) - INTERVAL '5 months'
        GROUP BY 1 ORDER BY 1`);
    // Fill in any month with no POs as 0, so the chart always has 6 points.
    const byMonth = new Map(trend.rows.map(r => [r.month, Number(r.total)]));
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      months.push({ month: key, total: byMonth.get(key) || 0 });
    }

    const topSuppliers = await pool.query(
      `SELECT s.name AS supplier_name, COALESCE(SUM(po.total_amount), 0) AS total
         FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
        GROUP BY s.name ORDER BY total DESC LIMIT 5`);

    res.json({ success: true, monthly_trend: months,
               top_suppliers: topSuppliers.rows.map(r => ({ supplier_name: r.supplier_name, total: Number(r.total) })) });
  } catch (err) {
    console.error(err);
    fail(res, 500, 'Could not load analytics');
  }
});

// ------------------------------------------------------------
// GET /api/dashboard/recent-activity - latest 8 POs/payments/GRNs, newest first
// ------------------------------------------------------------
router.get('/recent-activity', requirePermission(KEYS.DASHBOARD_VIEW), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM (
         SELECT 'po' AS type, po.po_number AS reference, po.id AS po_id, s.name AS supplier_name,
                po.total_amount AS amount, po.status, po.created_at
           FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
         UNION ALL
         SELECT 'payment', p.payment_id, p.po_id, s.name, p.amount, p.status, p.created_at
           FROM payments p JOIN suppliers s ON s.id = p.supplier_id
         UNION ALL
         SELECT 'grn', g.grn_number, g.po_id, s.name, NULL, g.status, g.created_at
           FROM grn_notes g JOIN purchase_orders po ON po.id = g.po_id JOIN suppliers s ON s.id = po.supplier_id
       ) activity
       ORDER BY created_at DESC LIMIT 8`);
    res.json({ success: true, activity: result.rows });
  } catch (err) {
    console.error(err);
    fail(res, 500, 'Could not load recent activity');
  }
});

module.exports = router;
