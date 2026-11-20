# Printed purchase order

Open a purchase order → **Print purchase order (PDF)** (people who may see prices only). The page `po-print.html?id=N` is an exact copy of the company's own Tally-style PO template (A4, measured from the supplied PDF); use **Print / Save as PDF** (margins none, background graphics on).

Data: `GET /api/po/:id/print` (needs PO view + price access). Supplier bank details are never included.

| Template field | Source |
|---|---|
| Voucher No. / Reference No. | `purchase_orders.po_ref`, e.g. `PO/26-27/028` (financial year April–March + running number, assigned automatically; existing orders were numbered by date) |
| Dated | PO date |
| Dispatched through | the order's transporter |
| Terms of Delivery | the order's notes (one per line) |
| Supplier address | new **Address** box on the supplier (up to 6 lines of 80 characters) |
| Supplier state / code | taken from the first two characters of the GST number |
| Due on | the order's delivery date |
| Round off, amount in words | calculated from the total |
| Company block | defaults from the template; override with `COMPANY_NAME`, `COMPANY_ADDRESS` (lines separated by `|`), `COMPANY_GSTIN`, `COMPANY_EMAIL` |

Fields the app does not hold (Mode/Terms of payment, Other references, Destination) are left blank like the template's. More than 5 items continue on further pages.
