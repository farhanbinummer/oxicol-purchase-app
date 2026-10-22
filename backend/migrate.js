// migrate.js - versioned, one-time schema/data migrations.
//
// Each step runs ONCE, inside a transaction, and is recorded in app_migrations. Steps only ADD
// (tables, columns, rows); nothing is dropped or rewritten silently. Anything the steps cannot
// decide for themselves (e.g. a legacy free-text item name that is not an exact catalogue match)
// is left flagged 'needs_review' for a person to resolve - see database/MIGRATION-NOTES.md.
//
// Runs automatically at server start, after the older ensure* helpers in notify.js / bom.js.

const { pool } = require('./database');
const { DEFAULTS } = require('./permissions');
const { packSizeFromName } = require('./catalog-search');

// Finished goods named in the BOM sheet's "No BOM data" tab. They exist in the catalogue so a branch can
// request them; with no recipe, planning for them is BLOCKED until someone adds one (this is deliberate).
const PRODUCTS_WITHOUT_RECIPE = [
  'DU COLOUR FOAM 5KG', 'HK ENGINE PROTECTIVE COATING 500ML', 'HK GLASS POSLISH COMPOUND 100 GM',
  'HK GOLDEN GLAZE WAX 1LTR', 'HK RAIN OUT 200ML', 'HK RAIN REPELLENT 100ML', 'HK TYRE DRESSER 200ML',
  'HK PVA CHAMOIS', 'HK WHEEL CLEANER TOUCHLESS 300ML'
];

const STEPS = [
  {
    name: '001_catalogue',
    async run(db) {
      await db.query(`
        ALTER TABLE products
          ADD COLUMN IF NOT EXISTS code      VARCHAR(30),
          ADD COLUMN IF NOT EXISTS category  VARCHAR(60) NOT NULL DEFAULT 'Finished goods',
          ADD COLUMN IF NOT EXISTS pack_size VARCHAR(30),
          ADD COLUMN IF NOT EXISTS base_unit VARCHAR(20) NOT NULL DEFAULT 'Nos';
        ALTER TABLE raw_materials
          ADD COLUMN IF NOT EXISTS category VARCHAR(60) NOT NULL DEFAULT 'Raw material',
          ADD COLUMN IF NOT EXISTS active   BOOLEAN NOT NULL DEFAULT true;
        CREATE TABLE IF NOT EXISTS product_aliases (
          id          SERIAL PRIMARY KEY,
          product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          alias       VARCHAR(100) NOT NULL,
          alias_norm  VARCHAR(100) NOT NULL UNIQUE
        );
        CREATE INDEX IF NOT EXISTS idx_product_aliases_product ON product_aliases(product_id);`);
      for (const n of PRODUCTS_WITHOUT_RECIPE) {
        await db.query('INSERT INTO products (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [n]);
      }
      await db.query("UPDATE products SET code = 'FG-' || LPAD(id::text, 4, '0') WHERE code IS NULL");
      await db.query('CREATE UNIQUE INDEX IF NOT EXISTS ux_products_code ON products(code)');
      const all = await db.query('SELECT id, name FROM products WHERE pack_size IS NULL');
      for (const p of all.rows) {
        const ps = packSizeFromName(p.name);
        if (ps) await db.query('UPDATE products SET pack_size = $1 WHERE id = $2', [ps, p.id]);
      }
      // Packaging vs raw material was INFERRED from the unit guessed when the BOM was first loaded.
      await db.query("UPDATE raw_materials SET category = 'Packaging' WHERE unit = 'Nos'");
    }
  },
  {
    name: '002_recipe_versions',
    async run(db) {
      await db.query(`
        CREATE TABLE IF NOT EXISTS recipe_versions (
          id               SERIAL PRIMARY KEY,
          product_id       INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          version          INTEGER NOT NULL,
          effective_from   DATE NOT NULL DEFAULT CURRENT_DATE,
          base_output_qty  NUMERIC(14,6) NOT NULL DEFAULT 1 CHECK (base_output_qty > 0),
          base_output_unit VARCHAR(20) NOT NULL DEFAULT 'Nos',
          wastage_included BOOLEAN NOT NULL DEFAULT true,
          wastage_pct      NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (wastage_pct >= 0),
          status           VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','retired')),
          created_by       INTEGER,
          created_at       TIMESTAMP NOT NULL DEFAULT NOW(),
          UNIQUE (product_id, version)
        );
        ALTER TABLE bom_lines ADD COLUMN IF NOT EXISTS recipe_id INTEGER REFERENCES recipe_versions(id) ON DELETE CASCADE;`);
      // The sheet's quantities came from real batch records and "include normal wastage" -> wastage_included = true.
      await db.query(`
        INSERT INTO recipe_versions (product_id, version)
        SELECT DISTINCT l.product_id, 1 FROM bom_lines l
         WHERE NOT EXISTS (SELECT 1 FROM recipe_versions r WHERE r.product_id = l.product_id)`);
      await db.query(`
        UPDATE bom_lines l SET recipe_id = r.id FROM recipe_versions r
         WHERE r.product_id = l.product_id AND r.version = 1 AND l.recipe_id IS NULL`);
      // Versions of one product share materials, so uniqueness moves from (product, material) to (recipe, material).
      await db.query('ALTER TABLE bom_lines DROP CONSTRAINT IF EXISTS bom_lines_product_id_material_id_key');
      await db.query('CREATE UNIQUE INDEX IF NOT EXISTS ux_bom_lines_recipe_material ON bom_lines(recipe_id, material_id)');
      await db.query('CREATE INDEX IF NOT EXISTS idx_bom_lines_recipe ON bom_lines(recipe_id)');
    }
  },
  {
    name: '003_request_items_catalogue_link',
    async run(db) {
      await db.query(`
        ALTER TABLE branch_request_items
          ADD COLUMN IF NOT EXISTS product_id INTEGER REFERENCES products(id),
          ADD COLUMN IF NOT EXISTS mapping_status VARCHAR(12) NOT NULL DEFAULT 'needs_review'
            CHECK (mapping_status IN ('mapped','needs_review'))`);
      // Only an EXACT, unambiguous match (ignoring case and spacing) is linked automatically.
      await db.query(`
        UPDATE branch_request_items i SET product_id = p.id, mapping_status = 'mapped'
          FROM products p
         WHERE i.product_id IS NULL
           AND LOWER(REGEXP_REPLACE(TRIM(i.item_name), '\\s+', ' ', 'g')) = LOWER(REGEXP_REPLACE(TRIM(p.name), '\\s+', ' ', 'g'))`);
      await db.query('CREATE INDEX IF NOT EXISTS idx_branch_items_product ON branch_request_items(product_id)');
    }
  },
  {
    name: '004_audit_log',
    async run(db) {
      await db.query(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id          BIGSERIAL PRIMARY KEY,
          at          TIMESTAMP NOT NULL DEFAULT NOW(),
          actor_id    INTEGER,
          actor_name  VARCHAR(100),
          actor_role  VARCHAR(20),
          action      VARCHAR(60) NOT NULL,
          entity      VARCHAR(40) NOT NULL,
          entity_id   INTEGER,
          summary     TEXT,
          before_data JSONB,
          after_data  JSONB,
          reason      TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);`);
    }
  },
  {
    name: '005_material_plans',
    async run(db) {
      await db.query(`
        CREATE TABLE IF NOT EXISTS material_plans (
          id          SERIAL PRIMARY KEY,
          request_id  INTEGER NOT NULL UNIQUE REFERENCES branch_stock_requests(id),
          indent_id   INTEGER REFERENCES production_indents(id),
          basis       VARCHAR(40) NOT NULL,
          inputs      JSONB NOT NULL,
          created_by  INTEGER,
          created_at  TIMESTAMP NOT NULL DEFAULT NOW()
        )`);
    }
  },
  {
    name: '006_catalogue_permissions',
    async run(db) {
      // New permission keys only. Existing grants are never touched, so edits an admin made stay as they are.
      for (const [role, keys] of Object.entries(DEFAULTS)) {
        for (const key of keys.filter(k => k.startsWith('catalog.'))) {
          await db.query('INSERT INTO role_permissions (role, permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING', [role, key]);
        }
      }
    }
  }
];

async function runMigrations() {
  await pool.query(`CREATE TABLE IF NOT EXISTS app_migrations (name VARCHAR(80) PRIMARY KEY, applied_at TIMESTAMP NOT NULL DEFAULT NOW())`);
  const done = new Set((await pool.query('SELECT name FROM app_migrations')).rows.map(r => r.name));
  for (const step of STEPS) {
    if (done.has(step.name)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await step.run(client);
      await client.query('INSERT INTO app_migrations (name) VALUES ($1)', [step.name]);
      await client.query('COMMIT');
      console.log('Migration applied:', step.name);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`Migration ${step.name} failed: ${err.message}`);
    } finally {
      client.release();
    }
  }
}

module.exports = { runMigrations, STEPS };
