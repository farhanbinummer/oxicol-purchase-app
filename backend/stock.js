// stock.js - stock in store, as a ledger of movements (+ in, - out). The balance of a material is the sum of its movements.
//   receipt  goods received and passed at quality check (added automatically from the goods receipt)
//   issue    materials taken out for a work order
//   return   materials put back (a work order cancelled after issue)
//   adjust   opening stock and corrections, always with a written reason
const round3 = (n) => Math.round(Number(n) * 1000) / 1000;

/** Balances for some materials (or all): Map material_id -> on hand. */
async function balances(db, materialIds) {
  const r = materialIds
    ? await db.query('SELECT material_id, COALESCE(SUM(qty), 0)::float AS on_hand FROM stock_movements WHERE material_id = ANY($1) GROUP BY material_id', [materialIds])
    : await db.query('SELECT material_id, COALESCE(SUM(qty), 0)::float AS on_hand FROM stock_movements GROUP BY material_id');
  return new Map(r.rows.map(x => [x.material_id, round3(x.on_hand)]));
}

async function move(db, req, { material_id, qty, kind, ref_type = null, ref_id = null, note = null }) {
  const u = (req && req.user) || {};
  await db.query('INSERT INTO stock_movements (material_id, qty, kind, ref_type, ref_id, note, by_user, by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [material_id, round3(qty), kind, ref_type, ref_id, note ? String(note).slice(0, 200) : null, u.id || null, u.name || null]);
}

/**
 * A goods receipt passed at quality check adds its received quantities to stock: each line whose name matches an active raw material
 * (ignoring capital letters), except lines marked Damaged. Done once per receipt. Lines that match no raw material are returned so the
 * person can be told; nothing is guessed.
 */
async function receiveGrn(db, req, grnId) {
  if ((await db.query("SELECT 1 FROM stock_movements WHERE ref_type = 'grn' AND ref_id = $1 LIMIT 1", [grnId])).rowCount) return { added: 0, unmatched: [] };
  const g = (await db.query('SELECT grn_number FROM grn_notes WHERE id = $1', [grnId])).rows[0];
  const lines = (await db.query('SELECT item_name, received_quantity::float AS qty, condition FROM grn_items WHERE grn_id = $1', [grnId])).rows;
  const mats = (await db.query('SELECT id, lower(name) AS n FROM raw_materials WHERE active')).rows;
  const byName = new Map(mats.map(m => [m.n, m.id]));
  const sum = new Map(), unmatched = [];
  for (const l of lines) {
    if (l.condition === 'Damaged' || !(l.qty > 0)) continue;
    const id = byName.get(String(l.item_name).trim().toLowerCase());
    if (!id) { unmatched.push(l.item_name); continue; }
    sum.set(id, round3((sum.get(id) || 0) + l.qty));
  }
  for (const [material_id, qty] of sum) await move(db, req, { material_id, qty, kind: 'receipt', ref_type: 'grn', ref_id: grnId, note: g ? g.grn_number : null });
  return { added: sum.size, unmatched };
}

module.exports = { balances, move, receiveGrn, round3 };
