-- ============================================================
-- Schema v4: an editable role-permission matrix.
-- Run AFTER db-setup.sql, schema-v2.sql and schema-v3.sql.
-- Run with:  psql -U postgres -d oxicol -f database/schema-v4.sql
--
-- User management and this matrix itself are deliberately NOT stored
-- here - they stay hardcoded to admin in the backend, so a bad edit
-- here can never lock everyone out or let a role grant itself admin.
-- ============================================================

CREATE TABLE role_permissions (
  id              SERIAL PRIMARY KEY,
  role            VARCHAR(20) NOT NULL
                  CHECK (role IN ('branch','production','store','purchase','accounts')),
  permission_key  VARCHAR(60) NOT NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (role, permission_key)
);
CREATE INDEX idx_role_permissions_role ON role_permissions(role);
