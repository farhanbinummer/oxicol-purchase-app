// delivery.js - what a branch has received of a stock request. Pure rules, shared by the routes, the dashboards and the tests.
//
// A branch confirms what arrived, as many times as needed (deliveries often come in parts). For each line it says how many arrived and how
// many of those were damaged. "Nothing more is coming" closes the request, even when it is short. The state is worked out from the records:
//   none         nothing confirmed yet
//   partial      some confirmed, more still expected
//   complete     everything requested has arrived
//   closed_short the branch said nothing more is coming, but some of it never arrived
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;

/**
 * items:    [{ id, quantity }]
 * received: Map or object  item id -> { qty, damaged }   (totals over all confirmations)
 * closed:   true when any confirmation was marked "nothing more is coming"
 */
function deliveryState(items, received, closed) {
  const get = (id) => { const r = received instanceof Map ? received.get(id) : (received || {})[id]; return r || { qty: 0, damaged: 0 }; };
  let requested = 0, got = 0, damaged = 0, anyReceived = false, allDone = items.length > 0;
  const lines = items.map(i => {
    const r = get(i.id), q = round3(i.quantity), qty = round3(r.qty), dm = round3(r.damaged);
    requested += q; got += qty; damaged += dm; if (qty > 0) anyReceived = true;
    const remaining = Math.max(0, round3(q - qty)); if (remaining > 0) allDone = false;
    return { item_id: i.id, requested: q, received: qty, damaged: dm, remaining };
  });
  const state = allDone ? 'complete' : closed ? 'closed_short' : (anyReceived ? 'partial' : 'none');
  return { state, requested: round3(requested), received: round3(got), damaged: round3(damaged), lines, has_problem: damaged > 0 || state === 'closed_short' };
}

const WORDS = { none: 'Not received yet', partial: 'Partly received', complete: 'Received', closed_short: 'Closed short' };
/** Plain words for lists: "Received", "60 of 100 received", "Not received yet". */
function deliveryText(d) {
  if (d.state === 'partial') return `${d.received} of ${d.requested} received`;
  if (d.state === 'closed_short') return `Closed short: ${d.received} of ${d.requested} received`;
  return WORDS[d.state];
}

/** Can the request still be confirmed against? Only while it is being fulfilled and not already complete or closed. */
const CONFIRMABLE_STATUS = ['approved', 'po_raised'];
const canStillConfirm = (status, state) => CONFIRMABLE_STATUS.includes(status) && (state === 'none' || state === 'partial');

/**
 * Checks a confirmation against what is still expected. Returns { error } or { lines, final, note }.
 * body: { items: [{ item_id, qty, damaged_qty }], note, final }
 * itemsNow: the request's lines with what has already been received: [{ id, quantity, received }]
 */
function validateReceipt(body, itemsNow) {
  const b = body || {};
  const note = String(b.note || '').trim().slice(0, 300), final = b.final === true || b.final === 'true';
  if (!Array.isArray(b.items)) return { error: 'Enter what arrived' };
  const byId = new Map(itemsNow.map(i => [Number(i.id), i]));
  const seen = new Set(), lines = [];
  for (const [n, raw] of b.items.entries()) {
    const id = Number(raw && raw.item_id), qty = raw && raw.qty !== '' && raw.qty != null ? Number(raw.qty) : 0, dm = raw && raw.damaged_qty !== '' && raw.damaged_qty != null ? Number(raw.damaged_qty) : 0;
    const it = byId.get(id);
    if (!it) return { error: `Line ${n + 1} is not part of this request` };
    if (seen.has(id)) return { error: `${it.item_name || 'An item'} is listed twice` };
    seen.add(id);
    if (!isFinite(qty) || qty < 0) return { error: `${it.item_name || 'Item'}: the quantity that arrived must be 0 or more` };
    if (!isFinite(dm) || dm < 0) return { error: `${it.item_name || 'Item'}: the damaged quantity must be 0 or more` };
    if (qty === 0 && dm === 0) continue;                                    // nothing entered for this line
    const remaining = round3(Number(it.quantity) - Number(it.received || 0));
    if (round3(qty) > remaining) return { error: `${it.item_name || 'Item'}: only ${remaining} is still expected, you entered ${round3(qty)}` };
    if (round3(dm) > round3(qty)) return { error: `${it.item_name || 'Item'}: the damaged quantity cannot be more than the quantity that arrived` };
    lines.push({ item_id: id, qty: round3(qty), damaged_qty: round3(dm) });
  }
  if (!lines.length && !final) return { error: 'Enter how many arrived for at least one item' };
  const damaged = lines.some(l => l.damaged_qty > 0);
  const stillOpen = itemsNow.some(i => {
    const add = (lines.find(l => l.item_id === Number(i.id)) || { qty: 0 }).qty;
    return round3(Number(i.quantity) - Number(i.received || 0) - add) > 0;
  });
  if (damaged && note.length < 5) return { error: 'Say what was wrong with the damaged goods (at least 5 characters)' };
  if (final && stillOpen && note.length < 5) return { error: 'Say why the rest is not coming (at least 5 characters)' };
  return { lines, final, note };
}

/** Delivery state for many requests at once: Map request id -> deliveryState(...). Reads records only. */
async function deliveryFor(db, ids) {
  const out = new Map(); if (!ids.length) return out;
  const [items, got, fin] = await Promise.all([
    db.query('SELECT id, request_id, quantity::float AS quantity FROM branch_request_items WHERE request_id = ANY($1) ORDER BY id', [ids]),
    db.query(`SELECT ri.request_item_id AS item_id, SUM(ri.qty)::float AS qty, SUM(ri.damaged_qty)::float AS damaged
                FROM branch_receipt_items ri JOIN branch_receipts r ON r.id = ri.receipt_id WHERE r.request_id = ANY($1) GROUP BY ri.request_item_id`, [ids]),
    db.query('SELECT DISTINCT request_id FROM branch_receipts WHERE request_id = ANY($1) AND is_final', [ids])
  ]);
  const received = new Map(got.rows.map(r => [r.item_id, { qty: r.qty, damaged: r.damaged }])), closed = new Set(fin.rows.map(r => r.request_id));
  const by = new Map(); items.rows.forEach(i => { if (!by.has(i.request_id)) by.set(i.request_id, []); by.get(i.request_id).push(i); });
  ids.forEach(id => out.set(id, deliveryState(by.get(id) || [], received, closed.has(id))));
  return out;
}

module.exports = { deliveryFor, deliveryState, deliveryText, canStillConfirm, validateReceipt, CONFIRMABLE_STATUS, round3 };
