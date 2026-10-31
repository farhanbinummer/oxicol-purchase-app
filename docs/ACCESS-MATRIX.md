# Access matrix

Generated from `backend/permissions.js` and `backend/access.js`. It shows the **shipped defaults**. An administrator can change any
cell except Administrator on the Roles & Permissions screen; every change is recorded in Audit History, and the live
values are always what that screen shows.

Access is the combination of four independent rules, all enforced on the server for every request:

| Rule | What it decides | Where it is set |
|---|---|---|
| **Role** | The responsibilities a person holds (one or several) | Users > Edit access |
| **Scope** | Which branches each role covers | Users > Edit access |
| **Action** | What the person may do: view, create, edit, approve, cancel, export | Roles & Permissions |
| **Field** | Whether prices and supplier bank details are included in what they receive | Roles & Permissions > Restricted fields |

A workspace is only a view over these rules. Choosing one never grants anything.

## 1. Role by module and action

Columns follow the vocabulary requested: View, Create, Edit, Submit, Approve, Cancel, Export. In this application creating a
request, indent or purchase order is how it is submitted, so **Submit** has no permission of its own; and the only export
that exists is syncing a PO to the Tally log, so **Export** appears on one row.

### Branch Stock Requests

| Action | Kind | Administrator | Manager | Purchase | Accounts | Stores | Quality check | Production | Branch staff |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Create a request (`branch_request.create`) | create | Yes | - | - | - | - | - | - | Yes |
| View requests (`branch_request.view`) | view | Yes | Yes | - | - | Yes | - | - | Yes |
| Approve a request (`branch_request.approve`) | approve | Yes | Yes | - | - | Yes | - | - | - |
| Delete a request (`branch_request.delete`) | cancel | Yes | - | - | - | - | - | - | Yes |

### Production Indents

| Action | Kind | Administrator | Manager | Purchase | Accounts | Stores | Quality check | Production | Branch staff |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Create an indent (`production_indent.create`) | create | Yes | - | - | - | - | - | Yes | - |
| View indents (`production_indent.view`) | view | Yes | Yes | - | - | Yes | - | Yes | - |
| Approve an indent (`production_indent.approve`) | approve | Yes | Yes | - | - | Yes | - | - | - |
| Delete an indent (`production_indent.delete`) | cancel | Yes | - | - | - | - | - | Yes | - |

### Consolidate Orders

| Action | Kind | Administrator | Manager | Purchase | Accounts | Stores | Quality check | Production | Branch staff |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| View open requests/indents to merge (`consolidate.view`) | view | Yes | - | Yes | - | - | - | - | - |
| Create a PO from consolidation (`consolidate.create_po`) | create | Yes | - | Yes | - | - | - | - | - |

### Purchase Orders

| Action | Kind | Administrator | Manager | Purchase | Accounts | Stores | Quality check | Production | Branch staff |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Create a PO (`po.create`) | create | Yes | - | Yes | - | - | - | - | - |
| View POs (`po.view`) | view | Yes | Yes | Yes | Yes | Yes | Yes | - | - |
| Change PO status (`po.update_status`) | edit | Yes | - | Yes | - | - | - | - | - |
| Delete a PO (`po.delete`) | cancel | Yes | - | Yes | - | - | - | - | - |

### Payments

| Action | Kind | Administrator | Manager | Purchase | Accounts | Stores | Quality check | Production | Branch staff |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Record an advance payment (`payment.create`) | create | Yes | - | - | Yes | - | - | - | - |
| View one PO's payment (`payment.view_by_po`) | view | Yes | Yes | Yes | Yes | Yes | - | - | - |
| View the full payments list (`payment.view_all`) | view | Yes | Yes | Yes | Yes | - | - | - | - |
| Approve an initiated payment (`payment.approve`) | approve | Yes | - | - | Yes | - | - | - | - |

### Goods Receipt (GRN)

| Action | Kind | Administrator | Manager | Purchase | Accounts | Stores | Quality check | Production | Branch staff |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Create a GRN (`grn.create`) | create | Yes | - | - | - | Yes | - | - | - |
| View GRNs (`grn.view`) | view | Yes | Yes | Yes | Yes | Yes | Yes | - | - |
| Approve / reject a GRN (QC) (`grn.approve`) | approve | Yes | - | - | - | Yes | Yes | - | - |

### Invoice & 3-Way Match

| Action | Kind | Administrator | Manager | Purchase | Accounts | Stores | Quality check | Production | Branch staff |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Upload an invoice (`invoice.upload`) | create | Yes | - | - | Yes | - | - | - | - |
| View invoice / match history (`invoice.view`) | view | Yes | Yes | Yes | Yes | - | - | - | - |
| Run the 3-way match (`invoice.match`) | edit | Yes | - | - | Yes | - | - | - | - |
| View a PO's match history (`three_way_match.view`) | view | Yes | Yes | Yes | Yes | - | - | - | - |

### Suppliers

| Action | Kind | Administrator | Manager | Purchase | Accounts | Stores | Quality check | Production | Branch staff |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| View supplier list (`suppliers.view`) | view | Yes | Yes | Yes | Yes | - | - | - | - |

### Tally Sync

| Action | Kind | Administrator | Manager | Purchase | Accounts | Stores | Quality check | Production | Branch staff |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Sync a PO to Tally (mock log) (`tally.sync`) | export | Yes | - | - | Yes | - | - | - | - |
| View the Tally sync log (`tally.view_log`) | view | Yes | - | - | Yes | - | - | - | - |

### Dashboard & Reports

| Action | Kind | Administrator | Manager | Purchase | Accounts | Stores | Quality check | Production | Branch staff |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Dashboard, charts, activity, variance report (`dashboard.view`) | view | Yes | Yes | Yes | Yes | Yes | Yes | - | - |

### Product Catalogue

| Action | Kind | Administrator | Manager | Purchase | Accounts | Stores | Quality check | Production | Branch staff |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Search and view finished products (`catalog.view`) | view | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Link older free-text request items to catalogue products (`catalog.map_items`) | edit | Yes | - | - | - | Yes | - | Yes | - |

### Restricted fields

| Action | Kind | Administrator | Manager | Purchase | Accounts | Stores | Quality check | Production | Branch staff |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| See prices, rates, tax and purchase totals (`field.prices`) | field | Yes | Yes | Yes | Yes | - | - | - | - |
| See suppliers' bank details (`field.supplier_bank`) | field | Yes | - | Yes | Yes | - | - | - | - |

## 2. Scope

| Role | Scope rule |
|---|---|
| Branch staff | **Always limited** to the branches assigned to them. With none assigned they see nothing (fails closed). |
| Every other role | Unrestricted by default. An administrator may assign branches to any role to limit it. |
| Administrator | Never limited (see Limitations). |

When a person holds several roles, the scope that applies to a record is the union of the scopes of the roles that grant the
permission being used. Example: someone who is Branch staff for Kannur **and** Purchase sees only Kannur's branch requests
(Branch staff grants that view) but every branch's approved demand in Purchase Requirements (Purchase grants that).

Scope is enforced on: branch request lists, details, creation, approval and deletion; material planning; consolidation (list and
purchase-order creation); catalogue review; global search; dashboard cards, queues and activity; approvals; notifications; and
the recipients of e-mail/WhatsApp alerts.

**Warehouses:** the data has no warehouse on any record (a receipt only has a free-text storage location), so a warehouse scope
cannot be enforced yet and is not offered.

## 3. Restricted fields

| Field key | Removed from responses when absent | Held by default |
|---|---|---|
| `field.prices` | Rates, line amounts, subtotal, tax and totals on purchase orders; purchase value and spend on dashboards; amounts in recent activity and variance reports; the analytics endpoint is refused | Administrator, Manager, Purchase, Accounts |
| `field.supplier_bank` | Bank name, account number and IFSC on purchase orders and the supplier list | Administrator, Purchase, Accounts |

The fields are **omitted** from the response, not hidden by the page. Payment records inside a purchase order are only included for
roles that hold `payment.view_by_po`.

**Narrowed by this change:** Stores no longer receives prices or bank details (it did before, through `po.view`). Tick the two
boxes under Restricted fields for the Store role to restore the old behaviour.

## 4. Workspaces

| Workspace | Opened by role | Dashboard shows (from existing data only) |
|---|---|---|
| Purchase Workspace | Purchase | Approved requirements to buy; orders not yet paid; deliveries due and overdue; rejected goods and invoice mismatches |
| Stores Workspace | Stores | Arrivals due today and overdue; receipts awaiting quality check; rejected goods awaiting replacement; branch requests to approve |
| Branch Workspace | Branch staff | Own-branch requests by stage; rejected requests |
| Production Workspace | Production | Approved demand to plan; plans blocked by a missing recipe or unlinked item; material requirements and linked purchase orders |
| Quality Workspace | Quality check | Receipts awaiting inspection; replacement receipts; rejected goods; decisions recorded |
| Accounts Workspace | Accounts | Payments to confirm; outstanding advances; orders awaiting payment; invoices to review or mismatched; Tally state |
| Manager Workspace | Manager, Administrator | Decisions waiting for the person; overdue deliveries; exceptions; purchase orders raised in a chosen period |
| Administrator Workspace | Administrator | Accounts without access; unlinked request items; products without a recipe; integrations not live |

A person holding several roles gets every workspace those roles open and can switch between them from the sidebar. The last one
used is remembered, and a default can be set (My Account, or Users > Edit access); signing in lands on the default.

## 5. Where the rules are enforced

- `auth.js` loads the person's roles, granted permissions and branches on **every request** (so a revoked permission applies to the next click).
- `requirePermission(key)` guards each endpoint; `branchScope` / `branchClause` apply the branch scope inside queries; `redactPo` and `fieldAccess` remove restricted fields.
- `workspaces.js` builds every dashboard section only when the person may read that kind of record, with the same scope and field rules.
- The menu, buttons and cards are display only; the tests in `backend/tests/workspaces.test.js` check the data and the direct API calls, not the menus.
