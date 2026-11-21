// tax.js - GST on a purchase order. A supplier in the same state as the company charges CGST + SGST (9% + 9%);
// a supplier in another state charges IGST (18%). The state is the first two characters of the supplier's GST number.
const { round2 } = require('./utils');
const { company, stateOf } = require('./po-print');

const CGST_RATE = Number(process.env.CGST_RATE ?? 9);
const SGST_RATE = Number(process.env.SGST_RATE ?? 9);
const IGST_RATE = Number(process.env.IGST_RATE ?? (CGST_RATE + SGST_RATE));

/** 'intra' (CGST + SGST) or 'inter' (IGST). `override` ('intra' | 'inter') wins; otherwise the GST number decides; no usable GST number = same state. */
function taxMode(supplierGstin, override) {
  if (override === 'intra' || override === 'inter') return override;
  const sup = stateOf(supplierGstin), own = stateOf(company(process.env).gstin);
  if (!sup || !own) return 'intra';
  return sup.code === own.code ? 'intra' : 'inter';
}
/** The tax on a subtotal in that mode. */
function taxSplit(subtotal, mode) {
  if (mode === 'inter') { const igst = round2(subtotal * IGST_RATE / 100); return { cgst: 0, sgst: 0, igst, total: round2(subtotal + igst) }; }
  const cgst = round2(subtotal * CGST_RATE / 100), sgst = round2(subtotal * SGST_RATE / 100);
  return { cgst, sgst, igst: 0, total: round2(subtotal + cgst + sgst) };
}
/** The mode an existing order was made in (it has IGST money on it, or not). */
const modeOfPo = (po) => Number(po && po.igst_amount) > 0 ? 'inter' : 'intra';
const validOverride = (v) => v === 'intra' || v === 'inter' ? v : null;

module.exports = { taxMode, taxSplit, modeOfPo, validOverride, CGST_RATE, SGST_RATE, IGST_RATE };
