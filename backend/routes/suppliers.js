// routes/suppliers.js - read-only supplier list (suppliers are hardcoded sample data this week).

const express = require('express');
const { pool } = require('../database');
const { requirePermission } = require('../auth');
const { KEYS } = require('../permissions');
const router = express.Router();

// GET /api/suppliers - active suppliers, used to fill the PO form dropdown
router.get('/', requirePermission(KEYS.SUPPLIERS_VIEW), async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, name, contact_person, phone, email, bank_name, account_number, ifsc_code " +
      "FROM suppliers WHERE status = 'active' ORDER BY name"
    );
    const { fieldAccess } = require('../access');
    const fa = fieldAccess(req.access);
    if (!fa.supplier_bank) result.rows.forEach(r => { delete r.bank_name; delete r.account_number; delete r.ifsc_code; });
    res.json({ success: true, suppliers: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load suppliers' });
  }
});

module.exports = router;
