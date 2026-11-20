# Removing data (administrator only)

Menu: **System, Remove Data**. Choose what to remove from the list, search, tick the records, press **Remove selected**. Each record's own page (purchase order, goods receipt, branch request, production request, R&D project, task, trial) also has an administrator-only remove button at the bottom.

| Kind | What goes with it | What happens to things that pointed at it |
|---|---|---|
| R&D projects | stages, checklist, tasks, trials and their files, notes, team, approvals | nothing else points at a project |
| Purchase orders | order lines, payments, goods receipts (and their lines and files), invoices and invoice checks, links to requests | a branch or production request whose only order this was goes back to "approved" (waiting for an order) |
| Goods receipts | receipt lines and files | the order stays (its status is not changed) |
| Payments | nothing | the order stays (its status is not changed) |
| Invoices | the invoice checks | the order stays |
| Branch requests | lines, delivery confirmations, material plans, links to orders | orders stay |
| Production requests | lines, material plans, links to orders | branch requests planned from it become "not planned" again |
| Suppliers | nothing | **cannot be removed while orders or payments use it** (remove those first, or switch the supplier off) |
| Raw materials | nothing | **cannot be removed while a recipe uses it** (switch it off, or take it out of the recipes) |
| Finished products | its recipes and other names | **cannot be removed while a branch request lists it** |

**Safeguards (every kind)**
- Administrators only: the whole `/api/admin` area is closed to everyone else.
- A warning that it cannot be undone and a list of what goes with each record.
- Type the record's number to confirm (`DELETE` where there is no number; `DELETE 3 PURCHASE ORDERS` for several; at most 50 at a time).
- A written reason (at least 5 letters).
- All or nothing: removing is one database transaction, so if anything fails, or one record in the list is not allowed, nothing is removed.
- The **Audit History** records who removed what, when and why, with the number, status, counts under it and, for money records (orders, payments, invoices), the amount. It cannot be removed here.
- Numbers are not reused: the next purchase order or request number carries on from the highest one given out.

**Not included, on purpose**
- **People's accounts.** Switch them off on the Users page: a person's name is on too much history to delete.
- **The Audit History itself.**

**Please take a database backup before removing real data** (`docs/BACKUP-AND-RECOVERY.md`). Removed records cannot be brought back from inside the app. Removing money records (orders, payments, invoices, receipts) changes what reports and the three-way match show, so use it for test data and mistakes, not to tidy history.
