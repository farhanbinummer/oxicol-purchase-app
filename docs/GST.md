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
