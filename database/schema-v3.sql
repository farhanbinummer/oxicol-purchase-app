-- ============================================================
-- Schema v3: department-wise user accounts and login.
-- Run AFTER db-setup.sql and schema-v2.sql.
-- Run with:  psql -U postgres -d oxicol -f database/schema-v3.sql
-- ============================================================

-- ---------- users ----------
CREATE TABLE users (
  id             SERIAL PRIMARY KEY,
  username       VARCHAR(50) NOT NULL UNIQUE,
  password_hash  VARCHAR(100) NOT NULL,
  name           VARCHAR(100) NOT NULL,
  role           VARCHAR(20) NOT NULL
                 CHECK (role IN ('branch','production','store','purchase','accounts','admin')),
  -- Only set (and only meaningful) when role = 'branch': which branch this login belongs to.
  branch         VARCHAR(20)
                 CHECK (branch IN ('Kannur','Thrissur','Trivandrum','Ernakulam')),
  active         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT branch_role_needs_branch CHECK (
    (role = 'branch' AND branch IS NOT NULL) OR (role <> 'branch' AND branch IS NULL)
  )
);

-- ---------- sessions: one row per logged-in device/browser ----------
CREATE TABLE sessions (
  token       VARCHAR(64) PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMP NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

-- ---------- "who did it" trail on the records that matter ----------
ALTER TABLE branch_stock_requests ADD COLUMN created_by INTEGER REFERENCES users(id);
ALTER TABLE production_indents    ADD COLUMN created_by INTEGER REFERENCES users(id);
ALTER TABLE purchase_orders       ADD COLUMN created_by INTEGER REFERENCES users(id);
ALTER TABLE payments              ADD COLUMN created_by INTEGER REFERENCES users(id);
ALTER TABLE grn_notes             ADD COLUMN created_by INTEGER REFERENCES users(id);
ALTER TABLE purchase_invoices     ADD COLUMN created_by INTEGER REFERENCES users(id);
