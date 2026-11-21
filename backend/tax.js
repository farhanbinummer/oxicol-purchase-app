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

/** GST rates an item may carry (percent of its value; same-state orders split it half CGST, half SGST). */
const RATES = [0, 0.25, 3, 5, 12, 18, 28];
/** null/'' = not set (the order's default rate applies); a bad value returns undefined. */
function cleanRate(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return RATES.includes(n) ? n : undefined;
}
/**
 * Tax on a set of lines [{ amount, rate }] - `rate` null means the default total rate (IGST_RATE, 18%). Tax is worked out on the total of
 * each rate (as on a GST invoice) and rounded once per rate; CGST and SGST are always equal.
 */
function taxLines(lines, mode) {
  const groups = new Map();
  for (const l of lines) { const r = l.rate === null || l.rate === undefined ? IGST_RATE : Number(l.rate); groups.set(r, round2((groups.get(r) || 0) + Number(l.amount))); }
  let cgst = 0, sgst = 0, igst = 0, subtotal = 0;
  for (const [r, base] of groups) {
    subtotal += base;
    if (mode === 'inter') igst += round2(base * r / 100);
    else { const half = round2(base * r / 200); cgst += half; sgst += half; }
  }
  subtotal = round2(subtotal); cgst = round2(cgst); sgst = round2(sgst); igst = round2(igst);
  return { cgst, sgst, igst, total: round2(subtotal + cgst + sgst + igst), subtotal };
}

module.exports = { RATES, cleanRate, taxLines, taxMode, taxSplit, modeOfPo, validOverride, CGST_RATE, SGST_RATE, IGST_RATE };
