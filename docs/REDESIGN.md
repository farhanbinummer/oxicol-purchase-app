# Oxicol Purchase App - redesign: findings, plan and status

This document separates **what is done and verified**, **what is planned**, and **what depends on configuration or business decisions**. Nothing is listed as working unless it was run and checked (see "Verification").

## 1. Findings, checked against the code

"Defect" = the software does something wrong. "Limitation" = it works as designed but the design is inadequate. "Unverified" = could not be confirmed from the code.

| # | Reported issue | Verdict | Status |
|---|---|---|---|
| 1 | Desktop menu is icons only | Limitation (labels existed only on hover) | **Done** - grouped, labelled, collapsible sidebar |
| 2 | Dashboard actions repeated (cards, pills, New menu) | Limitation | Phase 4 |
| 3 | Dashboard panel stuck on "Checking..." | **Defect** - placeholder text with no error handling; a failed call left it forever | **Done** - loading / error + retry |
| 4 | Server/database health under the greeting | Limitation | **Done** - moved to Administration > System Status |
| 5 | Free-text finished-product names | **Defect** for branch requests (any text accepted, no ID) | **Done for branch requests.** PO form, production indent form and consolidation lines are still free text (Phase 2) |
| 6 | "hk wheel" found no recipe | **Defect** - recipes were matched by exact typed name; two wheel products also made it ambiguous | **Done** - items link to a product ID; recipes hang off the product ID |
| 7 | Stock on hand not subtracted | Limitation - the app holds no inventory data | Labelled "gross requirement" everywhere; inventory is Phase 3 |
| 8 | Consolidation could count demand twice | **Defect** - a request already planned into an indent was still listed, and unapproved (pending) demand was accepted | **Done** - approved only; planned requests held back and refused server-side. A full allocation ledger with partial allocation is Phase 2 |
| 9 | One status mixes order/payment/delivery/invoice/accounting | Limitation | Phase 2 |
| 10 | Manual status transitions with internal values | Limitation | Labels fixed now; replacing manual transitions with business actions is Phase 2 |
| 11 | Payment form assumes one 100% advance | Limitation | Phase 3 |
| 12 | GRN form lists only POs without a GRN | Limitation | Phase 3 |
| 13 | Requester / receiver / approver typed as free text | **Defect** - the server trusted names sent in the request body | **Done** for request, GRN receiver and payment approver |
| 14 | Order detail is one long page | Limitation | Phase 4 |
| 15 | Approve/Delete directly in production list | Limitation | Phase 3-4 (approvals workspace) |
| 16 | Recipes reached via Material Planning | Limitation | **Done** - Master Data area |
| 17 | Tally button says test mode / logs only | Confirmed, and honest | System Status now states "Test mode"; button wording is Phase 5 |
| 18 | Filters show underscore values | Limitation | **Done** - plain-language labels |
| 19 | Fixed CGST/SGST summary | Confirmed: rates come from server settings and apply to the whole PO, not per line | Phase 2 |
| 20 | Primary creation actions are small links | Limitation | Phase 4 |

Additional defects found while working (all fixed in Phase 1):
- Consolidate accepted **pending** requests/indents, not only approved ones.
- A payment could be "confirmed" by ticking a box, with a typed approver name. It is now confirmed only if the signed-in user holds the approve permission, and the name stored is theirs.
- The previous product autocomplete had a lost backslash that mangled double-s words (for example "glass"). Replaced by server-side search.

## 2. Phased plan

**Phase 1 - Master data and traceability (implemented, below).**
**Phase 2 - Workflow and status correction:** separate Order / Receiving / Quality / Payment / Invoice / Accounting progress; replace manual PO transitions with actions; fulfilment decision (transfer stock / manufacture / buy for resale); requirements and allocation ledger (partial allocation, retry-safe); suppliers, branches, warehouses, units and conversions as master data; configurable per-line tax; catalogue selection in PO, production indent and consolidation.
**Phase 3 - Partial receipts, payments and approvals:** multiple receipts per PO, QC separate from receipt, returns/replacements linked to rejected quantity; multiple/partial payments with entry vs confirmation separation; unified approvals workspace with thresholds and separation of duties; inventory (stock, reservations, incoming supply) so planning can net shortages.
**Phase 4 - Navigation, dashboard and detail layouts:** role-aware action dashboard, tabbed order detail, list/form/detail patterns, global permission-aware search.
**Phase 5 - Visual consistency, reports and integration:** light neutral visual system, reports, real accounting integration.

Phase 4/5 includes a visual direction (light grey pages, white surfaces, purple accent) that differs from the dark glass style the application currently uses and that was chosen earlier. That change should be confirmed before it is made.

## 3. Phase 1 - what was built

- **Versioned migrations** (`backend/migrate.js`): each step runs once, in a transaction, recorded in `app_migrations`. See `database/MIGRATION-NOTES.md`.
- **Catalogue**: products have a stable ID, code (`FG-0001`), category, pack size, base unit, active flag and aliases. Search (`/api/catalog/products/search`) ranks code > alias/name > all words in name > words across name+aliases, and **returns every candidate - it never chooses silently**.
- **Branch requests use catalogue IDs.** The server rejects free text, duplicate products and inactive products; the unit and item name come from the catalogue; the requester is the signed-in user.
- **Legacy review queue** (Master Data > Catalogue Review): older free-text items stay `needs_review` until a person links each one. Only an *exact, unambiguous* name match was linked automatically.
- **Recipes by product ID, versioned** (`recipe_versions`): output quantity, wastage allowance, "quantities already include wastage" flag, effective date, status. A recipe that an approved plan used is never edited in place - the first edit creates a new version.
- **Planning**: `backend/planning.js` (pure, unit-tested). Missing recipe, empty recipe, or an unlinked item produces **"Planning blocked"** with the product and quantity; the draft indent is refused until resolved; unresolved demand stays visible. Wastage is never added on top of figures that already include it. Each approved plan stores the recipe versions and inputs it used (`material_plans`). The table shows **gross requirement** only and says so, because there is no inventory data.
- **No double buying**: Consolidate lists only approved demand; a request planned into an indent is held back and refused (and the reverse: a request already in a PO cannot be planned). Repeated or simultaneous submissions produce one record (row locks).
- **Identity and audit**: `audit_log` records actor (from the session), time, record, action, before/after and reason; secrets are stripped. Admin-only Audit History page.
- **Navigation**: grouped labelled sidebar built from the server's own permission list (`/api/auth/my-permissions`), collapsible, remembered per browser; admin-only Administration group (Users, Roles & Permissions, Audit History, System Status). Only existing capabilities are listed - no empty pages.
- **System Status** (admin): database health, alert channels (configured / not configured, never the values), accounting integration state, applied migrations.

## 4. Verification

- `npm test` - 18 unit tests (search ranking, pack sizes, planning maths including wastage not doubled, blocked states, audit scrubbing).
- `npm run test:integration` - 15 tests against a real server and database: migration idempotency, existing records readable, legacy items flagged, abbreviation search resolving a recipe, catalogue enforcement and server-controlled unit/requester, recipe-missing blocking, legacy-item linking and audit, double-count guards in both directions, simultaneous submissions, recipe versioning preserving old plans, permission and branch-scope enforcement, invalid transitions, audit actor/secrets, system-status secrecy.
- The tests were checked to fail when a safeguard is deliberately removed (the "already planned" guard and the wastage rule were each broken once and the matching tests went red).
- Tests create their own temporary users and data (random credentials, never printed) and delete them afterwards.
- Visual checks (desktop and 390 px phone): all 24 pages load with the application shell and no horizontal overflow at phone width; the sidebar, catalogue, planning (including the blocked state), audit, system and request-form screens were viewed.

## 5. Not done / limitations

- **Phases 2-5 above are not implemented.** This includes partial receipts, multiple payments, unified approvals, separate progress fields, per-line tax, suppliers/warehouses/units master data, the redesigned dashboard and order detail, reports, and the visual restyle.
- **Inventory**: none. Planning shows gross requirements; net shortage, reservations and incoming supply need stock data (Phase 3).
- **Fulfilment decision** (transfer stock / manufacture / buy for resale) is not modelled yet. Today an approved request can be planned for manufacturing or bought as finished goods; the guards only prevent doing both.
- **Dispatch and production execution** are outside the app. There is no handoff record yet for finished goods leaving the factory.
- **Tally**: test mode only. Nothing reaches Tally. A real connection needs a reachable TallyPrime server (address, company) and agreed ledger mappings.
- **Alerts**: email/WhatsApp work only when configured in the hosting environment; WhatsApp is untested (no account available).
- **PO, production-indent and consolidation forms** still accept free-text item names.
- **Live deployment**: the production database (Supabase) was paused/unreachable when this work was done, so the migrations have been run and tested **only on the local database**. They run automatically on the next start of the live server; take a backup first (see migration notes).
- **Units** of raw materials were inferred (packaging = Nos, everything else = Kg) when the BOM was loaded; please review them.
- 9 finished products named in the BOM sheet's "no data" tab were added to the catalogue **without recipes**, deliberately, so requests for them show "Planning blocked: recipe missing" until a recipe is entered.
