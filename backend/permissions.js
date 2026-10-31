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

  DASHBOARD_VIEW: 'dashboard.view',

  CATALOG_VIEW: 'catalog.view',
  CATALOG_MAP_ITEMS: 'catalog.map_items',

  // Field visibility: who may see money. These do not open any screen on their own; they decide whether prices,
  // tax and purchase totals (or suppliers' bank details) are INCLUDED in responses the user can already reach.
  FIELD_PRICES: 'field.prices',
  FIELD_SUPPLIER_BANK: 'field.supplier_bank',

  // R&D projects
  RD_VIEW: 'rd.view',                 // open R&D projects the person is involved in (requester, lead or member)
  RD_VIEW_ALL: 'rd.view_all',         // open every R&D project
  RD_CREATE: 'rd.create',             // raise and submit an R&D request
  RD_EDIT: 'rd.edit',                 // edit a project, its assessment, schedule, tasks and notes
  RD_STAGE: 'rd.stage',               // complete and reopen development stages
  RD_APPROVE_HEAD: 'rd.approve_head', // record the R&D Head decision
  RD_APPROVE_MGMT: 'rd.approve_mgmt', // record the Management decision
  RD_QC_SIGNOFF: 'rd.qc_signoff',     // record QC sign-off
  RD_HANDOVER_ACK: 'rd.handover_ack', // record Production's acknowledgement of a handover
  FIELD_RD_TECHNICAL: 'field.rd_technical' // technical approach, risks and lab notes (confidential)
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

  { key: KEYS.DASHBOARD_VIEW, module: 'Dashboard & Reports', action: 'Dashboard, charts, activity, variance report' },

  { key: KEYS.CATALOG_VIEW, module: 'Product Catalogue', action: 'Search and view finished products' },
  { key: KEYS.CATALOG_MAP_ITEMS, module: 'Product Catalogue', action: 'Link older free-text request items to catalogue products' },

  { key: KEYS.FIELD_PRICES, module: 'Restricted fields', action: 'See prices, rates, tax and purchase totals' },
  { key: KEYS.FIELD_SUPPLIER_BANK, module: 'Restricted fields', action: "See suppliers' bank details" },

  { key: KEYS.RD_VIEW, module: 'R&D Projects', action: 'Open R&D projects I am involved in' },
  { key: KEYS.RD_VIEW_ALL, module: 'R&D Projects', action: 'Open every R&D project' },
  { key: KEYS.RD_CREATE, module: 'R&D Projects', action: 'Raise and submit an R&D request' },
  { key: KEYS.RD_EDIT, module: 'R&D Projects', action: 'Edit projects, assessment, schedule, tasks and notes' },
  { key: KEYS.RD_STAGE, module: 'R&D Projects', action: 'Complete and reopen development stages' },
  { key: KEYS.RD_APPROVE_HEAD, module: 'R&D Projects', action: 'Record the R&D Head decision' },
  { key: KEYS.RD_APPROVE_MGMT, module: 'R&D Projects', action: 'Record the Management decision' },
  { key: KEYS.RD_QC_SIGNOFF, module: 'R&D Projects', action: 'Record QC sign-off on a project' },
  { key: KEYS.RD_HANDOVER_ACK, module: 'R&D Projects', action: "Record Production's handover acknowledgement" },
  { key: KEYS.FIELD_RD_TECHNICAL, module: 'Restricted fields', action: 'See confidential R&D content (technical approach, risks, lab notes)' }
];

// What each key lets a person DO, in the vocabulary the access matrix uses: view, create, edit, submit, approve,
// cancel, export (or "field" for visibility switches). In this application creating a request, indent or PO is
// also how it is submitted, so there is no separate "submit" permission; and nothing yet exports data except the
// Tally log, so "export" appears only on that key.
const KINDS = {
  'branch_request.create': 'create', 'branch_request.view': 'view', 'branch_request.approve': 'approve', 'branch_request.delete': 'cancel',
  'production_indent.create': 'create', 'production_indent.view': 'view', 'production_indent.approve': 'approve', 'production_indent.delete': 'cancel',
  'consolidate.view': 'view', 'consolidate.create_po': 'create',
  'po.create': 'create', 'po.view': 'view', 'po.update_status': 'edit', 'po.delete': 'cancel',
  'payment.create': 'create', 'payment.view_by_po': 'view', 'payment.view_all': 'view', 'payment.approve': 'approve',
  'grn.create': 'create', 'grn.view': 'view', 'grn.approve': 'approve',
  'invoice.upload': 'create', 'invoice.view': 'view', 'invoice.match': 'edit',
  'three_way_match.view': 'view', 'suppliers.view': 'view',
  'tally.sync': 'export', 'tally.view_log': 'view',
  'dashboard.view': 'view', 'catalog.view': 'view', 'catalog.map_items': 'edit',
  'field.prices': 'field', 'field.supplier_bank': 'field',
  'rd.view': 'view', 'rd.view_all': 'view', 'rd.create': 'create', 'rd.edit': 'edit', 'rd.stage': 'edit',
  'rd.approve_head': 'approve', 'rd.approve_mgmt': 'approve', 'rd.qc_signoff': 'approve', 'rd.handover_ack': 'approve',
  'field.rd_technical': 'field'
};
CATALOG.forEach(c => { c.kind = KINDS[c.key] || 'view'; });

// The exact behaviour the app already had before this system existed. Seeded once;
// after that, the role_permissions table in the database is the only source of truth.
const DEFAULTS = {
  branch: [KEYS.BRANCH_REQUEST_CREATE, KEYS.BRANCH_REQUEST_VIEW, KEYS.BRANCH_REQUEST_DELETE, KEYS.CATALOG_VIEW],
  production: [KEYS.PRODUCTION_INDENT_CREATE, KEYS.PRODUCTION_INDENT_VIEW, KEYS.PRODUCTION_INDENT_DELETE, KEYS.CATALOG_VIEW, KEYS.CATALOG_MAP_ITEMS],
  store: [
    KEYS.BRANCH_REQUEST_VIEW, KEYS.BRANCH_REQUEST_APPROVE,
    KEYS.PRODUCTION_INDENT_VIEW, KEYS.PRODUCTION_INDENT_APPROVE,
    KEYS.PO_VIEW, KEYS.PAYMENT_VIEW_BY_PO,
    KEYS.GRN_CREATE, KEYS.GRN_VIEW, KEYS.GRN_APPROVE,
    KEYS.DASHBOARD_VIEW, KEYS.CATALOG_VIEW, KEYS.CATALOG_MAP_ITEMS
  ],
  purchase: [
    KEYS.CONSOLIDATE_VIEW, KEYS.CONSOLIDATE_CREATE_PO,
    KEYS.PO_CREATE, KEYS.PO_VIEW, KEYS.PO_UPDATE_STATUS, KEYS.PO_DELETE,
    KEYS.PAYMENT_VIEW_BY_PO, KEYS.PAYMENT_VIEW_ALL,
    KEYS.GRN_VIEW, KEYS.INVOICE_VIEW, KEYS.THREE_WAY_MATCH_VIEW,
    KEYS.SUPPLIERS_VIEW, KEYS.DASHBOARD_VIEW, KEYS.CATALOG_VIEW,
    KEYS.FIELD_PRICES, KEYS.FIELD_SUPPLIER_BANK
  ],
  accounts: [
    KEYS.PO_VIEW,
    KEYS.PAYMENT_CREATE, KEYS.PAYMENT_VIEW_BY_PO, KEYS.PAYMENT_VIEW_ALL, KEYS.PAYMENT_APPROVE,
    KEYS.GRN_VIEW,
    KEYS.INVOICE_UPLOAD, KEYS.INVOICE_VIEW, KEYS.INVOICE_MATCH, KEYS.THREE_WAY_MATCH_VIEW,
    KEYS.SUPPLIERS_VIEW,
    KEYS.TALLY_SYNC, KEYS.TALLY_VIEW_LOG,
    KEYS.DASHBOARD_VIEW, KEYS.CATALOG_VIEW,
    KEYS.FIELD_PRICES, KEYS.FIELD_SUPPLIER_BANK
  ],
  // New roles. Nobody holds them until an administrator assigns them.
  qc: [KEYS.GRN_VIEW, KEYS.GRN_APPROVE, KEYS.PO_VIEW, KEYS.DASHBOARD_VIEW, KEYS.CATALOG_VIEW],
  manager: [
    KEYS.BRANCH_REQUEST_VIEW, KEYS.BRANCH_REQUEST_APPROVE,
    KEYS.PRODUCTION_INDENT_VIEW, KEYS.PRODUCTION_INDENT_APPROVE,
    KEYS.PO_VIEW, KEYS.PAYMENT_VIEW_BY_PO, KEYS.PAYMENT_VIEW_ALL,
    KEYS.GRN_VIEW, KEYS.INVOICE_VIEW, KEYS.THREE_WAY_MATCH_VIEW, KEYS.SUPPLIERS_VIEW,
    KEYS.DASHBOARD_VIEW, KEYS.CATALOG_VIEW, KEYS.FIELD_PRICES
  ]
};

const RD_DEFAULTS = {
  rd: [KEYS.RD_VIEW, KEYS.RD_VIEW_ALL, KEYS.RD_CREATE, KEYS.RD_EDIT, KEYS.RD_STAGE, KEYS.FIELD_RD_TECHNICAL, KEYS.CATALOG_VIEW],
  manager: [KEYS.RD_VIEW, KEYS.RD_VIEW_ALL, KEYS.RD_CREATE],
  branch: [KEYS.RD_VIEW, KEYS.RD_CREATE],
  production: [KEYS.RD_VIEW], purchase: [KEYS.RD_VIEW], qc: [KEYS.RD_VIEW], store: [KEYS.RD_VIEW], accounts: [KEYS.RD_VIEW]
};
for (const [role, keys] of Object.entries(RD_DEFAULTS)) {
  DEFAULTS[role] = (DEFAULTS[role] || []).concat(keys.filter(k => !(DEFAULTS[role] || []).includes(k)));
}

// The five roles that have permission rows (admin is implicit). Migration 006 only knows these.
const LEGACY_ROLES = ['branch', 'production', 'store', 'purchase', 'accounts'];

module.exports = { KEYS, CATALOG, DEFAULTS, LEGACY_ROLES };
