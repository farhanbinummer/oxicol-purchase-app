// routes/materials-admin.js - the raw material list, edited by administrators (mounted under /api/admin, which already requires the admin role).
//   GET  /api/admin/materials?q=&filter=all|no_unit|off     the list, with how many recipe lines use each material
//   POST /api/admin/materials                               add a material
//   PUT  /api/admin/materials/:id                           change name, unit, category, HSN code, GST rate, or switch it on or off
//   POST /api/admin/materials/set-unit                      { ids, unit } give a unit to materials that have none yet (never changes one that has a unit)
// The code is the billing software's item code and is never changed here. A switched-off material is no longer offered when people type
// (purchase orders, production requests); recipes and old orders that use it are untouched. Taking a material out of the app entirely is on Remove Data.
const express = require('express');
const { pool } = require('../database');
const { fail } = require('../utils');
const { audit } = require('../audit');
const router = express.Router();

const UNITS = ['Kg', 'Litre', 'Nos', 'Box', 'Drum'];                   // the units the order forms offer
const CATEGORIES = ['Raw material', 'Packaging'];
const idOf = (v) => (/^\d+$/.test(String(v)) && Number(v) > 0 ? Number(v) : null);
const COLS = 'm.id, m.code, m.name, m.unit, m.category, m.hsn_code, m.gst_rate::float AS gst_rate, m.active';

/** Checks the fields that were sent. Returns { error } or { set } with only the fields to change. */
function clean(b, opts) {
  const creating = !!(opts && opts.creating), set = {};
  if (b.name !== undefined) { const n = String(b.name || '').replace(/\s+/g, ' ').trim(); if (!n) return { error: 'The name cannot be empty' }; if (n.length > 200) return { error: 'The name is too long (at most 200 characters)' }; set.name = n; }
  if (b.unit !== undefined) { const u = String(b.unit || '').trim(); if (!UNITS.includes(u)) return { error: 'Choose a unit: ' + UNITS.join(', ') }; set.unit = u; }
  if (b.category !== undefined) { const c = String(b.category || '').trim(); if (!CATEGORIES.includes(c)) return { error: 'Category must be ' + CATEGORIES.join(' or ') }; set.category = c; }
  if (b.hsn_code !== undefined) { const h = String(b.hsn_code || '').trim(); if (h && !/^\d{4,8}$/.test(h)) return { error: 'The HSN code is 4 to 8 digits (or leave it empty)' }; set.hsn_code = h || null; }
  if (b.gst_rate !== undefined) {
    if (b.gst_rate === '' || b.gst_rate === null) set.gst_rate = null;
    else { const g = Number(b.gst_rate); if (!isFinite(g) || g < 0 || g > 40) return { error: 'The GST rate must be between 0 and 40' }; set.gst_rate = g; }
  }
  if (b.active !== undefined) { if (typeof b.active !== 'boolean') return { error: 'Active must be true or false' }; set.active = b.active; }
  if (creating) {
    const code = String(b.code || '').trim();
    if (!code || code.length > 30) return { error: 'The item code is required (at most 30 characters)' };
    if (set.name === undefined) return { error: 'The name is required' };
    if (set.unit === undefined) return { error: 'Choose a unit' };
    set.code = code;
  }
  return { set };
}
async function sameName(db, name, exceptId) {
  const r = await db.query('SELECT code FROM raw_materials WHERE lower(name) = lower($1) AND id IS DISTINCT FROM $2 LIMIT 1', [name, exceptId || null]);
  return r.rows[0];
}

router.get('/materials', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 80), filter = ['no_unit', 'off'].includes(req.query.filter) ? req.query.filter : 'all';
    const rows = (await pool.query(
      `SELECT ${COLS}, (SELECT COUNT(*)::int FROM bom_lines l WHERE l.material_id = m.id) AS recipe_lines FROM raw_materials m
        WHERE ($1 = '' OR m.code ILIKE '%' || $1 || '%' OR m.name ILIKE '%' || $1 || '%')
          AND ($2 = 'all' OR ($2 = 'no_unit' AND m.unit = '') OR ($2 = 'off' AND NOT m.active))
        ORDER BY m.name LIMIT 400`, [q, filter])).rows;
    const t = (await pool.query("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE unit = '')::int AS no_unit, COUNT(*) FILTER (WHERE NOT active)::int AS off FROM raw_materials")).rows[0];
    res.json({ success: true, materials: rows, totals: t, units: UNITS, categories: CATEGORIES });
  } catch (err) { console.error('materials list failed:', err); fail(res, 500, 'Could not load the materials'); }
});

router.post('/materials', async (req, res) => {
  const c = clean(req.body || {}, { creating: true }); if (c.error) return fail(res, 400, c.error);
  const s = c.set;
  try {
    const dup = await sameName(pool, s.name); if (dup) return fail(res, 409, `A material with that name already exists (code ${dup.code})`);
    const r = await pool.query('INSERT INTO raw_materials (code, name, unit, category, hsn_code, gst_rate, active) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [s.code, s.name, s.unit, s.category || 'Raw material', s.hsn_code || null, s.gst_rate === undefined ? null : s.gst_rate, s.active === undefined ? true : s.active]);
    await audit(pool, req, { action: 'material.create', entity: 'material', id: r.rows[0].id, summary: `Added material ${s.code} ${s.name} (${s.unit})` });
    res.status(201).json({ success: true, id: r.rows[0].id });
  } catch (err) {
    if (err.code === '23505') return fail(res, 409, 'That item code already exists');
    console.error('material create failed:', err); fail(res, 500, 'Could not add the material');
  }
});

router.put('/materials/:id', async (req, res) => {
  const id = idOf(req.params.id); if (!id) return fail(res, 400, 'Invalid material id');
  const c = clean(req.body || {}); if (c.error) return fail(res, 400, c.error);
  const s = c.set, keys = Object.keys(s); if (!keys.length) return fail(res, 400, 'Nothing to change');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = (await client.query('SELECT code, name, unit, category, hsn_code, gst_rate::float AS gst_rate, active FROM raw_materials WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) { await client.query('ROLLBACK'); return fail(res, 404, 'Material not found'); }
    const changed = keys.filter(k => String(s[k] === null || s[k] === undefined ? '' : s[k]) !== String(cur[k] === null || cur[k] === undefined ? '' : cur[k]));
    if (!changed.length) { await client.query('ROLLBACK'); return fail(res, 400, 'Nothing was changed'); }
    if (changed.includes('name') && s.name.toLowerCase() !== cur.name.toLowerCase()) {
      const dup = await sameName(client, s.name, id);
      if (dup) { await client.query('ROLLBACK'); return fail(res, 409, `A material with that name already exists (code ${dup.code})`); }
    }
    const sets = changed.map((k, i) => `${k} = $${i + 1}`);
    await client.query(`UPDATE raw_materials SET ${sets.join(', ')} WHERE id = $${changed.length + 1}`, [...changed.map(k => s[k]), id]);
    const before = {}, after = {}; changed.forEach(k => { before[k] = cur[k]; after[k] = s[k]; });
    await audit(client, req, { action: s.active === false && cur.active ? 'material.off' : 'material.update', entity: 'material', id, summary: `${cur.code} ${cur.name}: changed ${changed.join(', ')}`, before, after });
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); console.error('material update failed:', err); fail(res, 500, 'Could not save the change'); }
  finally { client.release(); }
});

router.post('/materials/set-unit', async (req, res) => {
  const b = req.body || {}, unit = String(b.unit || '').trim();
  const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(idOf).filter(Boolean))];
  if (!UNITS.includes(unit)) return fail(res, 400, 'Choose a unit: ' + UNITS.join(', '));
  if (!ids.length) return fail(res, 400, 'Choose at least one material');
  if (ids.length > 100) return fail(res, 400, 'Set at most 100 materials at a time');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query("UPDATE raw_materials SET unit = $1 WHERE id = ANY($2) AND unit = '' RETURNING id, code, name", [unit, ids]);     // only ones with no unit yet
    for (const m of r.rows) await audit(client, req, { action: 'material.update', entity: 'material', id: m.id, summary: `${m.code} ${m.name}: unit set to ${unit}`, before: { unit: '' }, after: { unit } });
    await client.query('COMMIT');
    res.json({ success: true, changed: r.rowCount, skipped: ids.length - r.rowCount });
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); console.error('set-unit failed:', err); fail(res, 500, 'Could not set the units'); }
  finally { client.release(); }
});

module.exports = router;
