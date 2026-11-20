// po-print.js - everything the printed purchase order needs, worked out on the server so the page only has to draw it.
//
// The printed layout copies the company's own purchase order template (Tally style): invoice-to and ship-to blocks, supplier block,
// voucher / reference / date boxes, the goods table with due date, quantity, rate and amount, CGST / SGST / round off, the total,
// the amount in words and the signature box. See docs/PO-PRINT.md. Money is formatted the Indian way (1,23,456.00).

// The company's details as they appear on the template. They can be changed with environment settings without touching code:
//   COMPANY_NAME, COMPANY_ADDRESS (lines separated by |), COMPANY_GSTIN, COMPANY_EMAIL
const DEFAULT_COMPANY = {
  name: 'OXICOL CAR CARE PRODUCTS',
  address: ['Ground Floor, 31/524, 22nd Mile', 'Muttipalam Upper, Manjeri', 'Muttipalam Upper, Manjeri'],
  gstin: '32FGVPS9596F1ZB',
  email: 'herakloen1@gmail.com'
};

// GST state codes (the first two characters of a GST number)
const STATES = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan',
  '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '25': 'Daman and Diu',
  '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '28': 'Andhra Pradesh', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala',
  '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory', '99': 'Centre Jurisdiction'
};
const stateOf = (gstin) => {
  const code = String(gstin || '').slice(0, 2);
  return STATES[code] ? { code, name: STATES[code] } : null;
};

function company(env) {
  const e = env || process.env, lines = String(e.COMPANY_ADDRESS || '').split('|').map(s => s.trim()).filter(Boolean);
  const c = { name: (e.COMPANY_NAME || '').trim() || DEFAULT_COMPANY.name, address: lines.length ? lines : DEFAULT_COMPANY.address, gstin: (e.COMPANY_GSTIN || '').trim().toUpperCase() || DEFAULT_COMPANY.gstin, email: (e.COMPANY_EMAIL || '').trim() || DEFAULT_COMPANY.email };
  const st = stateOf(c.gstin); c.state = st ? st.name : ''; c.state_code = st ? st.code : '';
  return c;
}

// ---------- number formats ----------
const cents = (n) => Math.round(Number(n || 0) * 100 + (Number(n || 0) < 0 ? -1e-9 : 1e-9));
/** 123456.5 -> "1,23,456.50" (Indian digit grouping, always two decimals) */
function inr(n) {
  const c = cents(n), neg = c < 0, abs = Math.abs(c), rup = String(Math.floor(abs / 100)), paise = String(abs % 100).padStart(2, '0');
  const head = rup.slice(0, -3), tail = rup.slice(-3);
  const grouped = (head ? head.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' : '') + tail;
  return (neg ? '-' : '') + grouped + '.' + paise;
}
/** quantities print with four decimals, like the template: 240 -> "240.0000" */
const qty4 = (n) => Number(n).toFixed(4);
const UNIT_CODES = { kg: 'KG', litre: 'LTR', liter: 'LTR', nos: 'NOS', box: 'BOX', drum: 'DRUM' };
const unitCode = (u) => UNIT_CODES[String(u || '').trim().toLowerCase()] || String(u || '').trim().toUpperCase();
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-11-03" -> "3-Nov-26" */
function dmy(d) {
  const s = d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10), m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? `${Number(m[3])}-${MON[Number(m[2]) - 1]}-${m[1].slice(2)}` : '';
}

// ---------- amount in words (Indian: thousand, lakh, crore) ----------
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function below100(n) { return n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : ''); }
function below1000(n) { const h = Math.floor(n / 100), r = n % 100; return [h ? ONES[h] + ' Hundred' : '', r ? below100(r) : ''].filter(Boolean).join(' '); }
function wholeWords(n) {
  if (n === 0) return 'Zero';
  const parts = [], crore = Math.floor(n / 1e7), lakh = Math.floor((n % 1e7) / 1e5), thou = Math.floor((n % 1e5) / 1e3), rest = n % 1000;
  if (crore) parts.push(wholeWords(crore) + ' Crore'); if (lakh) parts.push(below100(lakh) + ' Lakh'); if (thou) parts.push(below100(thou) + ' Thousand'); if (rest) parts.push(below1000(rest));
  return parts.join(' ');
}
/** 69526 -> "INR Sixty Nine Thousand Five Hundred Twenty Six Only"; with paise: "... and Fifty Paise Only" */
function amountInWords(amount) {
  const c = Math.abs(cents(amount)), rupees = Math.floor(c / 100), paise = c % 100;
  return 'INR ' + wholeWords(rupees) + (paise ? ' and ' + below100(paise) + ' Paise' : '') + ' Only';
}

/** financial year serial from a reference like "PO/26-27/028" -> 28 (the number shown as "Voucher No.") */
const voucherNo = (ref) => { const m = /(\d+)$/.exec(String(ref || '')); return m ? String(Number(m[1])) : ''; };

/**
 * po:       { po_ref, po_date, delivery_date, notes, transporter, subtotal, cgst_amount, sgst_amount, igst_amount, total_amount }
 * items:    [{ item_name, quantity, unit, rate, line_amount }]
 * supplier: { name, address, gst_number }
 */
function buildPrint(po, items, supplier, env) {
  const total = Number(po.total_amount), c = cents(total), rupees = Math.floor((c + 50) / 100), roundOff = rupees * 100 - c;
  const taxes = [['CGST', po.cgst_amount], ['SGST', po.sgst_amount], ['IGST', po.igst_amount]].filter(([, v]) => Number(v) > 0).map(([label, v]) => ({ label, amount: inr(v) }));
  const st = stateOf(supplier.gst_number), due = dmy(po.delivery_date);
  const totalQty = {}; items.forEach(i => { const u = unitCode(i.unit); totalQty[u] = (totalQty[u] || 0) + Number(i.quantity); });
  const units = Object.keys(totalQty);
  return {
    company: company(env),
    po: { reference: po.po_ref || '', voucher_no: voucherNo(po.po_ref), date: dmy(po.po_date), dispatched_through: po.transporter || '', terms_of_delivery: String(po.notes || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean) },
    supplier: { name: supplier.name, address: String(supplier.address || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean), gstin: supplier.gst_number || '', state: st ? st.name : '', state_code: st ? st.code : '' },
    items: items.map((i, k) => ({ n: k + 1, name: i.item_name, due, qty: qty4(i.quantity), unit: unitCode(i.unit), rate: inr(i.rate), amount: inr(i.line_amount) })),
    totals: { subtotal: inr(po.subtotal), taxes, round_off: roundOff ? inr(roundOff / 100) : '', total: inr(rupees), total_quantity: units.length === 1 ? qty4(totalQty[units[0]]) + ' ' + units[0] : '', words: amountInWords(rupees) }
  };
}

module.exports = { buildPrint, company, stateOf, inr, qty4, unitCode, dmy, amountInWords, voucherNo, STATES, DEFAULT_COMPANY };
