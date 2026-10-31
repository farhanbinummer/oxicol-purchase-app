// migrate.js - versioned, one-time schema/data migrations.
//
// Each step runs ONCE, inside a transaction, and is recorded in app_migrations. Steps only ADD
// (tables, columns, rows); nothing is dropped or rewritten silently. Anything the steps cannot
// decide for themselves (e.g. a legacy free-text item name that is not an exact catalogue match)
// is left flagged 'needs_review' for a person to resolve - see database/MIGRATION-NOTES.md.
//
// Runs automatically at server start, after the older ensure* helpers in notify.js / bom.js.

const { pool } = require('./database');
const { DEFAULTS, LEGACY_ROLES } = require('./permissions');
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
        if (!LEGACY_ROLES.includes(role)) continue; // roles added later are seeded by their own migration
        for (const key of keys.filter(k => k.startsWith('catalog.'))) {
          await db.query('INSERT INTO role_permissions (role, permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING', [role, key]);
        }
      }
    }
  },
  {
    // One person, several roles; scope (which branches) belongs to a role assignment; a remembered workspace.
    // users.role stays as the person's PRIMARY role so every existing query and screen keeps working.
    name: '007_roles_scopes_workspaces',
    async run(db) {
      await db.query(`
        CREATE TABLE IF NOT EXISTS user_roles (
          user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          role        VARCHAR(20) NOT NULL,
          assigned_at TIMESTAMP NOT NULL DEFAULT NOW(),
          PRIMARY KEY (user_id, role)
        );
        CREATE TABLE IF NOT EXISTS user_scopes (
          user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          role        VARCHAR(20) NOT NULL,
          scope_type  VARCHAR(20) NOT NULL,
          scope_value VARCHAR(60) NOT NULL,
          PRIMARY KEY (user_id, role, scope_type, scope_value)
        );
        CREATE TABLE IF NOT EXISTS user_workspace_prefs (
          user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          default_workspace VARCHAR(30),
          last_workspace    VARCHAR(30),
          updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
        )`);
      // Every existing person keeps exactly the one role and branch they have today.
      await db.query('INSERT INTO user_roles (user_id, role) SELECT id, role FROM users ON CONFLICT DO NOTHING');
      await db.query(`INSERT INTO user_scopes (user_id, role, scope_type, scope_value)
                       SELECT id, 'branch', 'branch', branch FROM users WHERE role = 'branch' AND branch IS NOT NULL
                       ON CONFLICT DO NOTHING`);
      // Two new roles (qc, manager) must be allowed in the two tables that listed the original ones.
      const NEW_LIST = "('branch','production','store','purchase','accounts','admin','qc','manager')";
      await db.query('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check');
      await db.query(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ${NEW_LIST})`);
      await db.query('ALTER TABLE role_permissions DROP CONSTRAINT IF EXISTS role_permissions_role_check');
      await db.query(`ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_role_check CHECK (role IN ('branch','production','store','purchase','accounts','qc','manager'))`);
    }
  },
  {
    // Permission keys that did not exist before. Existing action grants are never touched, so an administrator's
    // earlier edits stay. The one deliberate narrowing: the Stores role is NOT given the two restricted-field keys,
    // so it no longer receives prices or supplier bank details unless an administrator ticks them.
    name: '008_field_visibility_and_new_roles',
    async run(db) {
      for (const [role, keys] of Object.entries(DEFAULTS)) {
        if (!['branch', 'production', 'store', 'purchase', 'accounts', 'qc', 'manager'].includes(role)) continue; // later roles have their own steps
        const fresh = LEGACY_ROLES.includes(role) ? keys.filter(k => k.startsWith('field.') && k !== 'field.rd_technical') : keys.filter(k => !k.startsWith('rd.') && k !== 'field.rd_technical');
        for (const key of fresh) {
          await db.query('INSERT INTO role_permissions (role, permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING', [role, key]);
        }
      }
    }
  },
  {
    // R&D projects: requests, assessment, the eight stages and their checklists, tasks, notes and approvals.
    // Business dates are DATE columns (no time zone); moments are TIMESTAMPTZ. Nothing existing is changed except the two
    // role lists, which gain 'rd'.
    name: '009_rd_projects',
    async run(db) {
      await db.query(`
        CREATE TABLE IF NOT EXISTS rd_number_counters (
          period      CHAR(4) PRIMARY KEY,                 -- 'YYMM'
          last_serial INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS rd_projects (
          id                   SERIAL PRIMARY KEY,         -- stable internal id; the project number is a label
          project_number       VARCHAR(20) UNIQUE,         -- OXRD + serial + MM + YY; empty while a request is only a draft
          is_draft             BOOLEAN NOT NULL DEFAULT TRUE,
          title                VARCHAR(200) NOT NULL,
          project_type         VARCHAR(60),
          status               VARCHAR(20) NOT NULL DEFAULT 'Received'
                               CHECK (status IN ('Received','Under Review','Approved','In Lab Trials','Sample Sent','Plant Trial','Completed','On Hold','Rejected')),
          status_before_hold   VARCHAR(20),
          priority             VARCHAR(10) CHECK (priority IN ('High','Medium','Low')),
          department           VARCHAR(40),
          requested_by_user    INTEGER REFERENCES users(id),
          requested_by_name    VARCHAR(100),
          request_date         DATE,
          target_launch_date   DATE,
          target_tbc           BOOLEAN NOT NULL DEFAULT FALSE,
          customer_oem         VARCHAR(150),
          brand_product        VARCHAR(150),
          product_category     VARCHAR(60),
          base_system          VARCHAR(30),
          description          TEXT,
          application_method   TEXT,
          substrate            TEXT,
          end_user_market      TEXT,
          benchmark            TEXT,
          appearance_notes     TEXT,
          target_cost          NUMERIC(12,2),
          cost_basis           VARCHAR(10),
          labelling_claims     TEXT,
          monthly_volume       NUMERIC(14,2),
          volume_unit          VARCHAR(20),
          pack_sizes           TEXT,
          packaging_type       TEXT,
          voc_limit_required   BOOLEAN,
          voc_target_gl        NUMERIC(10,2),
          sds_ghs_required     BOOLEAN,
          restricted_substances TEXT,
          standards            TEXT,
          lead_user_id         INTEGER REFERENCES users(id),
          est_trial_days       INTEGER CHECK (est_trial_days IS NULL OR est_trial_days > 0),
          feasibility          VARCHAR(30),
          technical_approach   TEXT,                       -- confidential (field.rd_technical)
          risks                TEXT,                       -- confidential (field.rd_technical)
          completed_on         DATE,
          version              INTEGER NOT NULL DEFAULT 1, -- every change checks and bumps it, so two editors cannot overwrite each other
          imported_from        VARCHAR(80),
          created_by           INTEGER REFERENCES users(id),
          created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          submitted_at         TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS idx_rd_projects_status ON rd_projects(status);
        CREATE INDEX IF NOT EXISTS idx_rd_projects_lead ON rd_projects(lead_user_id);
        CREATE INDEX IF NOT EXISTS idx_rd_projects_requester ON rd_projects(requested_by_user);

        CREATE TABLE IF NOT EXISTS rd_requirements (
          id               SERIAL PRIMARY KEY,
          project_id       INTEGER NOT NULL REFERENCES rd_projects(id) ON DELETE CASCADE,
          position         INTEGER NOT NULL,
          parameter        VARCHAR(150) NOT NULL DEFAULT '',
          target           VARCHAR(250) NOT NULL DEFAULT '',
          acceptable_range VARCHAR(250) NOT NULL DEFAULT '',
          test_method      VARCHAR(250) NOT NULL DEFAULT '',
          benchmark_value  VARCHAR(250) NOT NULL DEFAULT '',
          remarks          VARCHAR(500) NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_rd_requirements_project ON rd_requirements(project_id);

        CREATE TABLE IF NOT EXISTS rd_project_members (
          project_id  INTEGER NOT NULL REFERENCES rd_projects(id) ON DELETE CASCADE,
          user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          added_by    INTEGER REFERENCES users(id),
          added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (project_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS rd_stages (
          id             SERIAL PRIMARY KEY,
          project_id     INTEGER NOT NULL REFERENCES rd_projects(id) ON DELETE CASCADE,
          stage_no       INTEGER NOT NULL CHECK (stage_no BETWEEN 1 AND 8),
          planned_date   DATE,
          actual_date    DATE,                              -- the completion date; set only when the stage is completed
          owner_user_id  INTEGER REFERENCES users(id),      -- explicit owner; empty means "the project lead"
          remarks        TEXT NOT NULL DEFAULT '',
          completed_at   TIMESTAMPTZ,                       -- when it was recorded
          completed_by   INTEGER REFERENCES users(id),
          review_flag    TEXT,                              -- set when an earlier stage was reopened after this one was completed
          version        INTEGER NOT NULL DEFAULT 1,
          UNIQUE (project_id, stage_no)
        );
        CREATE TABLE IF NOT EXISTS rd_stage_history (
          id          BIGSERIAL PRIMARY KEY,
          stage_id    INTEGER NOT NULL REFERENCES rd_stages(id) ON DELETE CASCADE,
          action      VARCHAR(20) NOT NULL CHECK (action IN ('completed','reopened')),
          action_date DATE,
          reason      TEXT,
          actor_id    INTEGER REFERENCES users(id),
          at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS rd_checklist_items (
          id        SERIAL PRIMARY KEY,
          stage_id  INTEGER NOT NULL REFERENCES rd_stages(id) ON DELETE CASCADE,
          position  INTEGER NOT NULL,
          label     VARCHAR(250) NOT NULL,
          done      BOOLEAN NOT NULL DEFAULT FALSE,
          done_by   INTEGER REFERENCES users(id),
          done_at   TIMESTAMPTZ
        );

        CREATE TABLE IF NOT EXISTS rd_tasks (
          id             SERIAL PRIMARY KEY,
          project_id     INTEGER NOT NULL REFERENCES rd_projects(id) ON DELETE CASCADE,
          stage_no       INTEGER CHECK (stage_no IS NULL OR stage_no BETWEEN 1 AND 8),
          title          VARCHAR(250) NOT NULL,
          description    TEXT NOT NULL DEFAULT '',
          status         VARCHAR(12) NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','blocked','done')),
          priority       VARCHAR(10) NOT NULL DEFAULT 'Medium' CHECK (priority IN ('High','Medium','Low')),
          assignee_id    INTEGER REFERENCES users(id),      -- one accountable person
          team           VARCHAR(40),                       -- a team task nobody has claimed yet (assignee empty)
          due_date       DATE,
          completed_at   TIMESTAMPTZ,
          created_by     INTEGER REFERENCES users(id),
          created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          version        INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_rd_tasks_project ON rd_tasks(project_id);
        CREATE INDEX IF NOT EXISTS idx_rd_tasks_assignee ON rd_tasks(assignee_id);

        CREATE TABLE IF NOT EXISTS rd_updates (
          id          BIGSERIAL PRIMARY KEY,
          project_id  INTEGER NOT NULL REFERENCES rd_projects(id) ON DELETE CASCADE,
          task_id     INTEGER REFERENCES rd_tasks(id) ON DELETE CASCADE,
          kind        VARCHAR(10) NOT NULL CHECK (kind IN ('comment','lab_note','system')),
          author_id   INTEGER REFERENCES users(id),
          author_name VARCHAR(100),
          body        TEXT NOT NULL,
          at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_rd_updates_project ON rd_updates(project_id, at DESC);

        CREATE TABLE IF NOT EXISTS rd_approvals (
          id             SERIAL PRIMARY KEY,
          project_id     INTEGER NOT NULL REFERENCES rd_projects(id) ON DELETE CASCADE,
          stage_no       INTEGER,
          kind           VARCHAR(20) NOT NULL CHECK (kind IN ('submission','rd_head','management','qc_signoff','customer','handover_ack')),
          decision       VARCHAR(10) NOT NULL CHECK (decision IN ('submitted','approved','rejected','returned')),
          decision_date  DATE,
          remarks        TEXT NOT NULL DEFAULT '',
          external_rep   VARCHAR(150),                      -- customer representative, for customer evidence
          evidence       TEXT NOT NULL DEFAULT '',          -- reference to the written evidence
          decided_by     INTEGER REFERENCES users(id),      -- the internal person who made or recorded the decision
          at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_rd_approvals_project ON rd_approvals(project_id);

        CREATE TABLE IF NOT EXISTS rd_user_projects (
          user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          project_id   INTEGER NOT NULL REFERENCES rd_projects(id) ON DELETE CASCADE,
          favourite    BOOLEAN NOT NULL DEFAULT FALSE,
          last_opened  TIMESTAMPTZ,
          PRIMARY KEY (user_id, project_id)
        )`);
      const NEW_LIST = "('branch','production','store','purchase','accounts','admin','qc','manager','rd')";
      await db.query('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check');
      await db.query(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ${NEW_LIST})`);
      await db.query('ALTER TABLE role_permissions DROP CONSTRAINT IF EXISTS role_permissions_role_check');
      await db.query(`ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_role_check CHECK (role IN ('branch','production','store','purchase','accounts','qc','manager','rd'))`);
    }
  },
  {
    // The R&D permission keys, seeded once. Existing grants are never touched. Only the R&D role may edit projects and only the
    // keys listed in permissions.js are granted; NO role receives an approval key (decision still needed), but administrators hold all.
    name: '010_rd_permissions',
    async run(db) {
      for (const [role, keys] of Object.entries(DEFAULTS)) {
        for (const key of keys.filter(k => k.startsWith('rd.') || k === 'field.rd_technical')) {
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
