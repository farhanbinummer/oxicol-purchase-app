// materials.js - the raw material list people pick from when they ask for or order material (type a few letters, choose one).
//
// The list is the `raw_materials` table (loaded from the billing software's item list by migration 031, plus the materials already in
// the recipes). Search only SUGGESTS, exactly like the product search: several matches are all shown and a person chooses. A chosen
// material's name is what gets saved on the order or request, so the same material is always spelt the same way.
const { rankItems } = require('./catalog-search');

const idOf = (v) => (/^\d+$/.test(String(v)) && Number(v) > 0 ? Number(v) : null);

/** Active materials, in the shape rankItems wants. */
async function loadMaterials(db) {
  const r = await db.query('SELECT id, code, name, unit, hsn_code, gst_rate::float AS gst_rate FROM raw_materials WHERE active ORDER BY name');
  return r.rows.map(m => ({ ...m, aliases: [] }));
}

/** Up to `limit` suggestions for the typed text; with nothing typed, the first ones alphabetically. */
async function searchMaterials(db, q, limit = 10) {
  const items = await loadMaterials(db), n = Math.min(Math.max(Number(limit) || 10, 1), 20), text = String(q || '').slice(0, 80);
  const hits = text.trim() ? rankItems(items, text, n) : items.slice(0, n);
  return hits.map(({ id, code, name, unit, hsn_code, gst_rate, matched_via }) => ({ id, code, name, unit, hsn_code, gst_rate, matched_via }));
}

/**
 * For order or request lines that carry a chosen material_id: checks it and returns Map id -> material.
 * Returns { error } naming the line when a chosen material does not exist or is switched off. Lines without material_id are untouched
 * (a person may still type something that is not on the list).
 */
async function resolveMaterials(db, items) {
  const ids = [...new Set(items.map(it => it && it.material_id).filter(v => v !== undefined && v !== null && v !== ''))];
  const bad = ids.find(v => !idOf(v));
  if (bad !== undefined) return { error: `Item ${items.findIndex(it => it && String(it.material_id) === String(bad)) + 1}: that raw material is not valid. Choose it from the list again.` };
  if (!ids.length) return { map: new Map() };
  const r = await db.query('SELECT id, code, name, unit, hsn_code FROM raw_materials WHERE id = ANY($1) AND active', [ids.map(Number)]);
  const map = new Map(r.rows.map(m => [m.id, m]));
  for (const [i, it] of items.entries()) {
    if (it && it.material_id !== undefined && it.material_id !== null && it.material_id !== '' && !map.has(Number(it.material_id))) return { error: `Item ${i + 1}: that raw material is no longer in the list. Choose it again.` };
  }
  return { map };
}

module.exports = { loadMaterials, searchMaterials, resolveMaterials, idOf };
