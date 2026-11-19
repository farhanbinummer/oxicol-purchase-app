# Photos and files on goods receipts

Open a goods receipt (GRN) and scroll to **Photos and files**. Use it for the supplier's delivery challan or invoice copy and for photos of damaged or short goods.

**Who can do what** (no new permission: it follows the existing receipt permissions)
- Add or remove files: whoever may record or decide a receipt (Stores, QC, administrators).
- Open files: whoever may see receipts (for example the Manager, Purchase).
- Everyone else sees nothing.

**How it works**
- On a phone, "Take a photo or choose files" opens the camera. Photos are shrunk before they are sent (longest side 1800 px), so they upload quickly on a weak connection.
- Choose what it is (delivery challan or invoice copy, damaged or short goods, other) and add an optional note such as "3 drums leaking".
- JPEG, PNG or PDF only, up to 5 MB each and 10 files per receipt (30 MB in all). The file's own contents are checked, not its name.
- Files are stored in the database, so they are covered by the database backup. They are served with browser protections (`nosniff`, a sandbox policy, never cached); PDFs download rather than open inside the page.
- **Removing** a file needs a reason (at least 5 letters). It stops being shown, but the file, who removed it and why are kept; the audit history records every add and remove (type and size only, never the file).
- The GRN history list shows how many files each receipt has.
- Files are left out when a receipt is printed.

Not included yet: files on purchase orders, invoices or branch requests; notifying Purchase when a damage photo is added.
