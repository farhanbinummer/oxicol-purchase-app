// bom.js - Bill of Materials tables and their first-time data.
//
//   products        finished goods you make (e.g. "DU CAR SHAMPOO CONC. 5KG")
//   raw_materials   everything that goes into them (chemicals, cans, labels...)
//   bom_lines       "one unit of this product uses this much of this material"
//
// Created automatically on server start. The 29 products / 94 materials from your BOM sheet
// (database/bom-seed.json) are loaded ONLY when the products table is empty, so later edits
// made in the app are never overwritten.

const fs = require('fs');
const path = require('path');
const { pool } = require('./database');

async function ensureBomSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS raw_materials (
      id     SERIAL PRIMARY KEY,
      code   VARCHAR(30)  NOT NULL UNIQUE,
      name   VARCHAR(200) NOT NULL,
      unit   VARCHAR(20)  NOT NULL DEFAULT 'Kg'
    );
    CREATE TABLE IF NOT EXISTS products (
      id     SERIAL PRIMARY KEY,
      name   VARCHAR(200) NOT NULL UNIQUE,
      active BOOLEAN NOT NULL DEFAULT true
    );
    CREATE TABLE IF NOT EXISTS bom_lines (
      id           SERIAL PRIMARY KEY,
      product_id   INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      material_id  INTEGER NOT NULL REFERENCES raw_materials(id) ON DELETE RESTRICT,
      qty_per_unit NUMERIC(14,6) NOT NULL CHECK (qty_per_unit > 0),
      UNIQUE (product_id, material_id)
    );
    CREATE INDEX IF NOT EXISTS idx_bom_lines_product ON bom_lines(product_id);
    ALTER TABLE branch_stock_requests ADD COLUMN IF NOT EXISTS planned_indent_id INTEGER;
  `);

  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM products');
  if (rows[0].n > 0) return;

  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'database', 'bom-seed.json'), 'utf8'));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const matId = {};
    for (const m of seed.materials) {
      const r = await client.query(
        'INSERT INTO raw_materials (code, name, unit) VALUES ($1,$2,$3) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id',
        [m.code, m.name, m.unit]);
      matId[m.code] = r.rows[0].id;
    }
    for (const p of seed.products) {
      const r = await client.query('INSERT INTO products (name) VALUES ($1) RETURNING id', [p.name]);
      for (const l of p.lines) {
        await client.query('INSERT INTO bom_lines (product_id, material_id, qty_per_unit) VALUES ($1,$2,$3)',
          [r.rows[0].id, matId[l.code], l.qty]);
      }
    }
    await client.query('COMMIT');
    console.log(`BOM loaded: ${seed.products.length} products, ${seed.materials.length} materials`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { ensureBomSchema };
