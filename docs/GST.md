# GST on purchase orders

- A supplier in **our state** (first two characters of the GST number match the company's, `32` Kerala): **CGST 9% + SGST 9%**.
- A supplier in **another state**: **IGST 18%**.
- A supplier with **no GST number saved**: treated as our state (CGST + SGST). The order form says so; choose the tax by hand if that is wrong.
- Choose the tax by hand on the order form (**Tax** box: Automatic / Same state / Other state) or send `tax_type` (`intra` | `inter`) to `POST /api/po/create`, `PUT /api/po/:id` or `POST /api/consolidate/create-po`.
- Orders from Purchase Requirements and Rate Enquiries use the automatic rule.
- Editing an order keeps its kind of tax while the supplier stays the same, and re-works it when the supplier changes.
- The printed PO shows IGST in place of CGST/SGST; Tally vouchers and the invoice check use the same kind of tax as the order.
- Rates: `CGST_RATE`, `SGST_RATE`, `IGST_RATE` (default 9, 9, 18). Company GST number: `COMPANY_GSTIN`.
- Orders made before this change keep their CGST + SGST.

## GST rate per item

- Each order line has its own **GST %** (0, 5, 12, 18, 28; also 0.25 and 3 through the API). Blank means 18.
- An item picked from the raw-material list takes that material's GST rate (set on the raw-materials admin screen); a rate chosen on the line wins.
- Orders from Purchase Requirements have a **GST %** column (auto = the raw material of the same name, else 18); Rate Enquiries have one per item.
- Tax is worked out on the total of each rate (as on a GST invoice): CGST and SGST are half each; IGST the whole. The goods-receipt Tally entry and the invoice check use each item's own rate.
- Orders made before this change have no per-item rate and count as 18%, exactly as they were taxed.
