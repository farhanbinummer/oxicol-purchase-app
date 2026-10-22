// planning.js - raw-material requirement calculation (pure functions, no database).
//
// For each requested finished product (quantity Q in packs):
//     material gross requirement = line qty / recipe base output qty  x  Q  x  wastage factor
//   wastage factor = 1                      when the recipe's quantities ALREADY include wastage (wastage_included)
//                  = 1 + wastage_pct / 100  when they are net quantities and a wastage allowance applies
// So an allowance is never added on top of figures that already contain it.
//
// This is a GROSS requirement. Stock on hand, reservations and incoming supply are not subtracted
// because the app does not hold reliable inventory data yet; `basis` says so explicitly, and callers
// must show it. Nothing here guesses: an item with no linked product, or with no active recipe, is
// reported as BLOCKED and the plan is not complete.

const round6 = (n) => Number(Number(n).toFixed(6));

const BLOCK_REASONS = {
  unmapped: 'Not linked to a catalogue product',
  recipe_missing: 'Recipe missing',
  recipe_empty: 'Recipe has no materials'
};

/**
 * items: [{ item_id, item_name, product_id, product_name, quantity,
 *           recipe: null | { id, version, base_output_qty, wastage_included, wastage_pct,
 *                            lines: [{ material_id, code, name, unit, qty_per_unit }] } }]
 */
function calcMaterials(items) {
  const detail = [], blocked = [], totals = new Map();
  for (const it of items) {
    const q = Number(it.quantity);
    const base = { item_id: it.item_id, item_name: it.item_name, product_id: it.product_id || null, product: it.product_name || null, quantity: q };
    let reason = null;
    if (!it.product_id) reason = 'unmapped';
    else if (!it.recipe) reason = 'recipe_missing';
    else if (!it.recipe.lines || it.recipe.lines.length === 0) reason = 'recipe_empty';
    if (reason) {
      blocked.push({ ...base, reason, reason_text: BLOCK_REASONS[reason] });
      detail.push({ ...base, recipe: null, lines: [] });
      continue;
    }
    const r = it.recipe;
    const factor = (q / Number(r.base_output_qty)) * (r.wastage_included ? 1 : 1 + Number(r.wastage_pct || 0) / 100);
    const lines = r.lines.map(l => ({ ...l, needed: round6(Number(l.qty_per_unit) * factor) }));
    lines.forEach(l => {
      const t = totals.get(l.material_id) || { material_id: l.material_id, code: l.code, name: l.name, unit: l.unit, qty: 0 };
      t.qty = round6(t.qty + l.needed);
      totals.set(l.material_id, t);
    });
    detail.push({ ...base, recipe: { id: r.id, version: r.version, base_output_qty: Number(r.base_output_qty), wastage_included: r.wastage_included, wastage_pct: Number(r.wastage_pct || 0) }, lines });
  }
  const totalList = [...totals.values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    basis: 'gross_requirement',
    basis_note: 'Gross requirement from recipes. Stock on hand, reservations and incoming supply are not subtracted (the app has no inventory data yet) - review stock before turning this into purchase quantities.',
    items: detail,
    totals: totalList,
    blocked,
    complete: blocked.length === 0 && totalList.length > 0
  };
}

module.exports = { calcMaterials, round6, BLOCK_REASONS };
