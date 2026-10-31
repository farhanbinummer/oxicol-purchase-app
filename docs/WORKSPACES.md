# Role workspaces

One application, one sign-in, shared records. After signing in each person lands on the workspace for their role, with the
menu, numbers and actions that belong to it. This document describes what was built, what was checked, and - just as
important - what was **not** built because the application has no data or process for it yet.

The rules behind it (role, branch scope, action, field visibility) are in [ACCESS-MATRIX.md](ACCESS-MATRIX.md). The database
changes are in [../database/MIGRATION-NOTES.md](../database/MIGRATION-NOTES.md). Screenshots are in `docs/screenshots/workspaces/`.

## What was built

**Foundation (server)**
- A person can hold several roles (`user_roles`); branch scope belongs to a role assignment (`user_scopes`); the workspace last
  used and a default are remembered (`user_workspace_prefs`). `users.role` still holds the primary role so existing screens work.
- Every request loads the person's roles, permissions and branches fresh (`backend/access.js`), so an administrator's change
  applies to the very next click, with no sign-out.
- Branch scope is enforced through the permission being used, not by a role name, on requests (list, detail, create, approve,
  delete), material planning, consolidation, catalogue review, search, dashboards, approvals, notifications and alert recipients.
- Prices, tax, totals and supplier bank details are left out of responses for roles without `field.prices` / `field.supplier_bank`.
- Search follows the permission matrix (it used to follow a fixed list per role).
- Two new roles, **Manager** and **Quality check**, nobody holds until an administrator assigns them.
- Permission edits are now written to Audit History; the last active administrator cannot be removed, disabled or deleted.

**Workspaces (one shared layout, different content)**
Title and description, up to four cards that open the matching filtered list, a "My work" queue (overdue first, then due date, then
waiting time), exceptions, recent activity relevant to the role, and two or three quick actions. Each task shows the record and
type, branch or supplier, why action is needed, who is responsible, due date, waiting time, progress, and the next step the person
may take - or, when they may not, who it is waiting on. Loading, empty, error and retry states are built in.

| Workspace | Role | New pages it uses |
|---|---|---|
| Purchase | Purchase | Expected Deliveries |
| Stores | Stores | Expected Deliveries (never shows money) |
| Branch | Branch staff | - |
| Production | Production | - |
| Quality | Quality check | - |
| Accounts | Accounts | - |
| Manager | Manager, Administrator | Approvals |
| Administrator | Administrator | Edit access (per user) |

A person with several roles gets the workspace switcher in the sidebar (also in the phone drawer). Switching changes only what is
shown; permissions, branches and identity are unchanged. Notifications are derived from the same queues: only things the person
can act on, each once, linking straight to the record. E-mail and WhatsApp stay off until configured on the server, as before.

## What was not built, and why

None of the following exists in the application's data, so no card, queue, menu entry or button was added for it. Adding an empty
section would only hide that.

| Asked for | Missing piece |
|---|---|
| Quotations, comparing quotations | No quotation data or process |
| Supplier follow-up log | No record of follow-ups (overdue orders are listed; nothing is logged) |
| POs "awaiting approval" or "not yet issued" | Purchase orders have no approval or issue step |
| Stock & Locations; material shortages; reserved stock | No inventory data |
| Branch dispatches; dispatched / received stages; incoming deliveries; branch receipt confirmation; partial fulfilment ("60 of 100 received") | Nothing records a dispatch or a branch receipt. Branch progress shows Submitted, Approved, Being prepared |
| Returns & replacements as records | Only "rejected, still waiting for replacement goods" is derivable |
| Line-level accepted/rejected quantities, reasons, documents; inspector and time per line | Quality is one decision per receipt. (The person and time of the decision are recorded in Audit History) |
| Partial receipts | One receipt per order |
| Attachments, exports (other than the Tally log) | Neither exists, so there is nothing to protect yet |
| Production progress updates | No such process |
| Accounting export queue, retry, failed state | Tally is a test-mode log; it is shown honestly as "Test mode" |
| Reject with reason / return for correction; approval limits | Only approve exists, with no amount thresholds |
| Warehouses as a scope | No warehouse on any record |
| "Inspections overdue" | No inspection deadline rule exists |

## Decisions needed from the business

1. **Stores still sees payment references on an order.** The existing matrix explicitly grants Stores `payment.view_by_po`. The
   brief says a storekeeper should not see them unless permitted. Untick it on Roles & Permissions to hide them.
2. **Stores does three jobs today**: receives goods, records the quality decision, and approves branch requests and
   production requirements. The new Quality and Manager roles exist to split these. Which people should move, and should Stores then
   lose `grn.approve` and the two approvals? (Nothing was taken away automatically.)
3. **Administrator holds every permission, including approving payments and quality.** That is the existing behaviour and was kept so
   nobody is locked out. The brief asks that administering accounts should not automatically confer approval authority. Proposed
   path: a separate system-administrator role limited to Users, Permissions, Audit and master data, with business approvals granted
   explicitly - but it needs your decision on who keeps what.
4. **Approval thresholds.** No amount limits exist and none were invented. Who approves what, above which value?
5. **Should Managers confirm payments?** By default they cannot (Accounts keeps that); they can view payments.
6. **Branches and warehouses as managed master data.** The four branches are fixed in the database. Making them editable, and adding
   warehouses to receipts, is a data change that needs agreeing first.

## How it was checked

- `backend/tests/workspaces.test.js` (18 tests, real server and database, temporary users and records removed afterwards) checks
  **data and API access**, not menus: each role's landing workspace, nav entries that point at real pages, dashboard shape, unassigned
  workspaces refused by URL, branch scope across lists/counts/details/search/notifications/actions, multi-role scope, restricted
  fields absent from responses, direct API calls refused, search following permissions, revocation applying on the next request,
  dashboard counts equal to the lists they open, notifications relevant and unique, approvals using the signed-in identity,
  multi-role switching, default workspace at sign-in, and administration guards with an audit trail.
- All earlier tests (33) still pass; the full run is 51.
- Visual audit of every page each role uses, at 360 / 768 / 1024 / 1440 px in light and dark: no horizontal overflow, no text below
  the WCAG contrast minimum, no blank pages. It also found and fixed real problems (below).
- Hands-on: the switcher, drawer, keyboard focus and filtered links from cards.

Problems found while verifying and fixed: branch activity rows had no labels; the activity feed showed irrelevant records;
create buttons showed to roles that could not use them; wide tables overflowed on tablets (now scroll inside a box); a badge
overflowed a phone card by 1 px; the phone drawer's Dark mode button was hidden behind the bottom bar; accounts created directly in
SQL had no branch scope (now fall back to their branch).

## Limitations

- Everything above runs on the local database. The migrations run on the live database at its next start; take a backup first.
- Phone and tablet layouts were checked with browser emulation, not on devices.
- Counts and queues are computed on demand; a very large database may need indexes later.
- Dashboard activity for the Administrator shows Audit History entries only once there are some.
