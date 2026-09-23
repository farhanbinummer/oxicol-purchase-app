-- ============================================================
-- Oxicol Purchase App - database setup
-- Run with:  psql -U postgres -f database/db-setup.sql
-- (psql meta-commands \c below only work in psql, not pgAdmin's query tool.
--  In pgAdmin: create DB "oxicol" by hand, connect to it, run from the SET line down.)
-- ============================================================

-- Drop and recreate so the script can be re-run cleanly on a dev machine.
DROP DATABASE IF EXISTS oxicol;
CREATE DATABASE oxicol;
\c oxicol

-- Shared trigger: keeps updated_at current on every UPDATE.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------- 1. suppliers ----------
CREATE TABLE suppliers (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(150) NOT NULL,
  contact_person  VARCHAR(100),
  phone           VARCHAR(20),
  email           VARCHAR(150),
  bank_name       VARCHAR(100),
  account_number  VARCHAR(30),
  ifsc_code       VARCHAR(15),
  status          VARCHAR(10) NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'inactive')),
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ---------- 2. purchase_orders ----------
CREATE TABLE purchase_orders (
  id             SERIAL PRIMARY KEY,
  po_number      VARCHAR(30) NOT NULL UNIQUE,          -- OXI-PO-YYYYMMDD-NNN
  po_date        DATE NOT NULL DEFAULT CURRENT_DATE,
  supplier_id    INTEGER NOT NULL REFERENCES suppliers(id),
  subtotal       NUMERIC(14,2) NOT NULL CHECK (subtotal >= 0),
  cgst_amount    NUMERIC(14,2) NOT NULL DEFAULT 0,
  sgst_amount    NUMERIC(14,2) NOT NULL DEFAULT 0,
  igst_amount    NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_amount   NUMERIC(14,2) NOT NULL CHECK (total_amount >= 0),
  delivery_date  DATE,
  status         VARCHAR(20) NOT NULL DEFAULT 'created'
                 CHECK (status IN ('created','payment_pending','payment_done',
                                   'in_transit','delivered','closed')),
  notes          TEXT,
  created_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE TRIGGER trg_po_updated BEFORE UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- 3. po_items ----------
CREATE TABLE po_items (
  id           SERIAL PRIMARY KEY,
  po_id        INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  item_name    VARCHAR(200) NOT NULL,
  quantity     NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  unit         VARCHAR(20) NOT NULL,
  rate         NUMERIC(12,2) NOT NULL CHECK (rate >= 0),
  line_amount  NUMERIC(14,2) NOT NULL CHECK (line_amount >= 0),  -- quantity x rate
  hsn_code     VARCHAR(10)
);

-- ---------- 4. payments ----------
CREATE TABLE payments (
  id            SERIAL PRIMARY KEY,
  payment_id    VARCHAR(30) NOT NULL UNIQUE,            -- PAY-YYYYMMDD-NNN
  po_id         INTEGER NOT NULL REFERENCES purchase_orders(id),
  supplier_id   INTEGER NOT NULL REFERENCES suppliers(id),
  payment_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  amount        NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  payment_mode  VARCHAR(20) NOT NULL DEFAULT 'bank_transfer'
                CHECK (payment_mode IN ('bank_transfer','cheque','cash')),
  utr_number    VARCHAR(50),
  approved_by   VARCHAR(100),
  status        VARCHAR(20) NOT NULL DEFAULT 'initiated'
                CHECK (status IN ('initiated','confirmed','failed')),
  notes         TEXT,
  created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);
-- The same bank UTR must never be recorded twice.
CREATE UNIQUE INDEX uq_payments_utr ON payments(utr_number) WHERE utr_number IS NOT NULL;

-- ---------- 5. grn_notes ----------
CREATE TABLE grn_notes (
  id                SERIAL PRIMARY KEY,
  grn_number        VARCHAR(30) NOT NULL UNIQUE,        -- GRN-YYYYMMDD-NNN
  grn_date          DATE NOT NULL DEFAULT CURRENT_DATE,
  po_id             INTEGER NOT NULL REFERENCES purchase_orders(id),
  received_by       VARCHAR(100) NOT NULL,
  total_items       INTEGER NOT NULL DEFAULT 0,
  status            VARCHAR(20) NOT NULL DEFAULT 'pending_qc'
                    CHECK (status IN ('pending_qc','approved','rejected')),
  qc_notes          TEXT,
  storage_location  VARCHAR(100),
  condition         VARCHAR(10) NOT NULL DEFAULT 'Good'
                    CHECK (condition IN ('Good','Damaged','Short')),
  created_at        TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ---------- 6. grn_items ----------
CREATE TABLE grn_items (
  id                 SERIAL PRIMARY KEY,
  grn_id             INTEGER NOT NULL REFERENCES grn_notes(id) ON DELETE CASCADE,
  item_name          VARCHAR(200) NOT NULL,
  po_quantity        NUMERIC(12,3) NOT NULL,
  received_quantity  NUMERIC(12,3) NOT NULL CHECK (received_quantity >= 0),
  variance           NUMERIC(12,3) NOT NULL,            -- received - po (negative = short)
  condition          VARCHAR(10) NOT NULL DEFAULT 'Good'
                     CHECK (condition IN ('Good','Damaged','Short'))
);

-- Indexes on foreign keys / common filters
CREATE INDEX idx_po_supplier   ON purchase_orders(supplier_id);
CREATE INDEX idx_po_status     ON purchase_orders(status);
CREATE INDEX idx_items_po      ON po_items(po_id);
CREATE INDEX idx_payments_po   ON payments(po_id);
CREATE INDEX idx_grn_po        ON grn_notes(po_id);
CREATE INDEX idx_grn_items_grn ON grn_items(grn_id);

-- ---------- Sample suppliers ----------
INSERT INTO suppliers (name, contact_person, phone, email, bank_name, account_number, ifsc_code) VALUES
 ('Chemical House Ltd',  'Rajesh', '9876543210', 'rajesh@chem.com',  'ICICI Bank',   '1234567890123', 'ICIC0000001'),
 ('Paint Supplies Inc',  'Amit',   '9876543211', 'amit@paint.com',   'HDFC Bank',    '1234567891234', 'HDFC0000001'),
 ('Packaging Solutions', 'Vikas',  '9876543212', 'vikas@pack.com',   'Federal Bank', '1234567892345', 'FDRL0000001');
