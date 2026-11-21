// routes/stock.js - raw material stock in store.
//   GET  /api/stock                        every active raw material with what is in store (?q= search, ?only=low|in)
//   GET  /api/stock/:materialId/movements  the last 200 movements of one material
//   POST /api/stock/adjust                 { material_id, qty (+ adds, - takes out), note }  opening stock and corrections
const express = require('express');
const { pool } = require('../database');
const { fail } = require('../utils');
const { requirePermission } = require('../auth');
const { KEYS } = require('../permissions');
const { audit } = require('../audit');
const { balances, move, round3 } = require('../stock');
const router = express.Router();

router.get('/', requirePermission(KEYS.STOCK_VIEW), async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const m = await pool.query(
      `SELECT m.id, m.code, m.name, m.unit, m.category,
              COALESCE(s.on_hand, 0)::float AS on_hand, s.last_at
         FROM raw_materials m
         LEFT JOIN (SELECT material_id, SUM(qty) AS on_hand, MAX(at) AS last_at FROM stock_movements GROUP BY material_id) s ON s.material_id = m.id
        WHERE m.active AND ($1 = '' OR m.name ILIKE '%' || $1 || '%' OR m.code ILIKE '%' || $1 || '%')
        ORDER BY m.name`, [q]);
    let rows = m.rows.map(r => ({ ...r, on_hand: round3(r.on_hand) }));
    if (req.query.only === 'in') rows = rows.filter(r => r.on_hand > 0);
    if (req.query.only === 'out') rows = rows.filter(r => r.on_hand <= 0);
    res.json({ success: true, materials: rows });
  } catch (e) { console.error(e); fail(res, 500, 'Could not load stock'); }
});

router.get('/:materialId/movements', requirePermission(KEYS.STOCK_VIEW), async (req, res) => {
  const id = Number(req.params.materialId);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid material');
  try {
    const m = (await pool.query('SELECT id, code, name, unit FROM raw_materials WHERE id = $1', [id])).rows[0];
    if (!m) return fail(res, 404, 'Raw material not found');
    const r = await pool.query('SELECT id, qty::float AS qty, kind, ref_type, ref_id, note, by_name, at FROM stock_movements WHERE material_id = $1 ORDER BY id DESC LIMIT 200', [id]);
    res.json({ success: true, material: m, on_hand: (await balances(pool, [id])).get(id) || 0, movements: r.rows });
  } catch (e) { console.error(e); fail(res, 500, 'Could not load the movements'); }
});

router.post('/adjust', requirePermission(KEYS.STOCK_ADJUST), async (req, res) => {
  const b = req.body || {}, id = Number(b.material_id), qty = Number(b.qty), note = String(b.note || '').trim();
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Choose a raw material');
  if (!isFinite(qty) || qty === 0) return fail(res, 400, 'Enter the quantity to add (or a minus quantity to take out)');
  if (note.length < 3) return fail(res, 400, 'Write the reason, for example "Opening stock" or "Counted on 21 Nov"');
  if (note.length > 200) return fail(res, 400, 'The reason is at most 200 characters');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const m = (await client.query('SELECT id, name, unit FROM raw_materials WHERE id = $1 AND active FOR UPDATE', [id])).rows[0];
    if (!m) { await client.query('ROLLBACK'); return fail(res, 404, 'Raw material not found'); }
    const before = (await balances(client, [id])).get(id) || 0;
    if (round3(before + qty) < 0) { await client.query('ROLLBACK'); return fail(res, 400, `There is only ${before} ${m.unit || ''} in store, so ${Math.abs(qty)} cannot be taken out`); }
    await move(client, req, { material_id: id, qty, kind: 'adjust', ref_type: 'adjust', note });
    await audit(client, req, { action: 'stock.adjust', entity: 'raw_material', id, summary: `${m.name}: ${qty > 0 ? '+' : ''}${qty} (${note})`, before: { on_hand: before }, after: { on_hand: round3(before + qty) }, reason: note });
    await client.query('COMMIT');
    res.json({ success: true, on_hand: round3(before + qty) });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); console.error(e); fail(res, 500, 'Could not save the stock change'); } finally { client.release(); }
});

module.exports = router;
