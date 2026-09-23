// permissions.js - the single source of truth for every editable permission key.
//
// KEYS gives every route file a constant to call requirePermission(KEYS.PO_CREATE) with,
// instead of a bare string - a typo becomes "undefined" immediately, not a silent hole.
// CATALOG is what the Permissions admin page renders (module/action labels).
// DEFAULTS is what gets seeded into role_permissions so behaviour is UNCHANGED right after
// this system goes live - nothing here differs from what requireRole() used to hardcode.
//
// Deliberately NOT covered by this system: user management, and editing this matrix itself.
// Both stay hardcoded to requireRole('admin') in their route files, on purpose - if they were
// editable here, a bad edit (or a compromised non-admin account) could grant itself admin power.

const KEYS = {
  BRANCH_REQUEST_CREATE: 'branch_request.create',
  BRANCH_REQUEST_VIEW: 'branch_request.view',
  BRANCH_REQUEST_APPROVE: 'branch_request.approve',
  BRANCH_REQUEST_DELETE: 'branch_request.delete',

  PRODUCTION_INDENT_CREATE: 'production_indent.create',
  PRODUCTION_INDENT_VIEW: 'production_indent.view',
  PRODUCTION_INDENT_APPROVE: 'production_indent.approve',
  PRODUCTION_INDENT_DELETE: 'production_indent.delete',

  CONSOLIDATE_VIEW: 'consolidate.view',
  CONSOLIDATE_CREATE_PO: 'consolidate.create_po',

  PO_CREATE: 'po.create',
  PO_VIEW: 'po.view',
  PO_UPDATE_STATUS: 'po.update_status',
  PO_DELETE: 'po.delete',

  PAYMENT_CREATE: 'payment.create',
  PAYMENT_VIEW_BY_PO: 'payment.view_by_po',
  PAYMENT_VIEW_ALL: 'payment.view_all',
  PAYMENT_APPROVE: 'payment.approve',

  GRN_CREATE: 'grn.create',
  GRN_VIEW: 'grn.view',
  GRN_APPROVE: 'grn.approve',

  INVOICE_UPLOAD: 'invoice.upload',
  INVOICE_VIEW: 'invoice.view',
  INVOICE_MATCH: 'invoice.match',

  THREE_WAY_MATCH_VIEW: 'three_way_match.view',
  SUPPLIERS_VIEW: 'suppliers.view',

  TALLY_SYNC: 'tally.sync',
  TALLY_VIEW_LOG: 'tally.view_log',

  DASHBOARD_VIEW: 'dashboard.view'
};

const CATALOG = [
  { key: KEYS.BRANCH_REQUEST_CREATE, module: 'Branch Stock Requests', action: 'Create a request' },
  { key: KEYS.BRANCH_REQUEST_VIEW, module: 'Branch Stock Requests', action: 'View requests' },
  { key: KEYS.BRANCH_REQUEST_APPROVE, module: 'Branch Stock Requests', action: 'Approve a request' },
  { key: KEYS.BRANCH_REQUEST_DELETE, module: 'Branch Stock Requests', action: 'Delete a request' },

  { key: KEYS.PRODUCTION_INDENT_CREATE, module: 'Production Indents', action: 'Create an indent' },
  { key: KEYS.PRODUCTION_INDENT_VIEW, module: 'Production Indents', action: 'View indents' },
  { key: KEYS.PRODUCTION_INDENT_APPROVE, module: 'Production Indents', action: 'Approve an indent' },
  { key: KEYS.PRODUCTION_INDENT_DELETE, module: 'Production Indents', action: 'Delete an indent' },

  { key: KEYS.CONSOLIDATE_VIEW, module: 'Consolidate Orders', action: 'View open requests/indents to merge' },
  { key: KEYS.CONSOLIDATE_CREATE_PO, module: 'Consolidate Orders', action: 'Create a PO from consolidation' },

  { key: KEYS.PO_CREATE, module: 'Purchase Orders', action: 'Create a PO' },
  { key: KEYS.PO_VIEW, module: 'Purchase Orders', action: 'View POs' },
  { key: KEYS.PO_UPDATE_STATUS, module: 'Purchase Orders', action: 'Change PO status' },
  { key: KEYS.PO_DELETE, module: 'Purchase Orders', action: 'Delete a PO' },

  { key: KEYS.PAYMENT_CREATE, module: 'Payments', action: 'Record an advance payment' },
  { key: KEYS.PAYMENT_VIEW_BY_PO, module: 'Payments', action: "View one PO's payment" },
  { key: KEYS.PAYMENT_VIEW_ALL, module: 'Payments', action: 'View the full payments list' },
  { key: KEYS.PAYMENT_APPROVE, module: 'Payments', action: 'Approve an initiated payment' },

  { key: KEYS.GRN_CREATE, module: 'Goods Receipt (GRN)', action: 'Create a GRN' },
  { key: KEYS.GRN_VIEW, module: 'Goods Receipt (GRN)', action: 'View GRNs' },
  { key: KEYS.GRN_APPROVE, module: 'Goods Receipt (GRN)', action: 'Approve / reject a GRN (QC)' },

  { key: KEYS.INVOICE_UPLOAD, module: 'Invoice & 3-Way Match', action: 'Upload an invoice' },
  { key: KEYS.INVOICE_VIEW, module: 'Invoice & 3-Way Match', action: 'View invoice / match history' },
  { key: KEYS.INVOICE_MATCH, module: 'Invoice & 3-Way Match', action: 'Run the 3-way match' },
  { key: KEYS.THREE_WAY_MATCH_VIEW, module: 'Invoice & 3-Way Match', action: "View a PO's match history" },

  { key: KEYS.SUPPLIERS_VIEW, module: 'Suppliers', action: 'View supplier list' },

  { key: KEYS.TALLY_SYNC, module: 'Tally Sync', action: 'Sync a PO to Tally (mock log)' },
  { key: KEYS.TALLY_VIEW_LOG, module: 'Tally Sync', action: 'View the Tally sync log' },

  { key: KEYS.DASHBOARD_VIEW, module: 'Dashboard & Reports', action: 'Dashboard, charts, activity, variance report' }
];

// The exact behaviour the app already had before this system existed. Seeded once;
// after that, the role_permissions table in the database is the only source of truth.
const DEFAULTS = {
  branch: [KEYS.BRANCH_REQUEST_CREATE, KEYS.BRANCH_REQUEST_VIEW, KEYS.BRANCH_REQUEST_DELETE],
  production: [KEYS.PRODUCTION_INDENT_CREATE, KEYS.PRODUCTION_INDENT_VIEW, KEYS.PRODUCTION_INDENT_DELETE],
  store: [
    KEYS.BRANCH_REQUEST_VIEW, KEYS.BRANCH_REQUEST_APPROVE,
    KEYS.PRODUCTION_INDENT_VIEW, KEYS.PRODUCTION_INDENT_APPROVE,
    KEYS.PO_VIEW, KEYS.PAYMENT_VIEW_BY_PO,
    KEYS.GRN_CREATE, KEYS.GRN_VIEW, KEYS.GRN_APPROVE,
    KEYS.DASHBOARD_VIEW
  ],
  purchase: [
    KEYS.CONSOLIDATE_VIEW, KEYS.CONSOLIDATE_CREATE_PO,
    KEYS.PO_CREATE, KEYS.PO_VIEW, KEYS.PO_UPDATE_STATUS, KEYS.PO_DELETE,
    KEYS.PAYMENT_VIEW_BY_PO, KEYS.PAYMENT_VIEW_ALL,
    KEYS.GRN_VIEW, KEYS.INVOICE_VIEW, KEYS.THREE_WAY_MATCH_VIEW,
    KEYS.SUPPLIERS_VIEW, KEYS.DASHBOARD_VIEW
  ],
  accounts: [
    KEYS.PO_VIEW,
    KEYS.PAYMENT_CREATE, KEYS.PAYMENT_VIEW_BY_PO, KEYS.PAYMENT_VIEW_ALL, KEYS.PAYMENT_APPROVE,
    KEYS.GRN_VIEW,
    KEYS.INVOICE_UPLOAD, KEYS.INVOICE_VIEW, KEYS.INVOICE_MATCH, KEYS.THREE_WAY_MATCH_VIEW,
    KEYS.SUPPLIERS_VIEW,
    KEYS.TALLY_SYNC, KEYS.TALLY_VIEW_LOG,
    KEYS.DASHBOARD_VIEW
  ]
};

module.exports = { KEYS, CATALOG, DEFAULTS };
