-- ============================================================
-- Schema v2: Branch Stock Requests, Production Indents,
-- Consolidation links, Invoices and 3-Way Matching.
-- Adds to the tables created by db-setup.sql - run it AFTER that file.
-- Run with:  psql -U postgres -d oxicol -f database/schema-v2.sql
-- ============================================================

-- ---------- branch_stock_requests ----------
CREATE TABLE branch_stock_requests (
  id                  SERIAL PRIMARY KEY,
  request_number      VARCHAR(30) NOT NULL UNIQUE,        -- REQ-YYYYMMDD-NNN
  branch              VARCHAR(20) NOT NULL
                       CHECK (branch IN ('Kannur','Thrissur','Trivandrum','Ernakulam')),
  requested_by        VARCHAR(100) NOT NULL,
  delivery_needed_by  DATE,
  status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','approved','po_raised','rejected')),
  created_at          TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE TABLE branch_request_items (
  id          SERIAL PRIMARY KEY,
  request_id  INTEGER NOT NULL REFERENCES branch_stock_requests(id) ON DELETE CASCADE,
  item_name   VARCHAR(200) NOT NULL,
  quantity    NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  unit        VARCHAR(20) NOT NULL
);
CREATE INDEX idx_branch_items_req ON branch_request_items(request_id);

-- ---------- production_indents ----------
CREATE TABLE production_indents (
  id               SERIAL PRIMARY KEY,
  indent_number    VARCHAR(30) NOT NULL UNIQUE,           -- IND-YYYYMMDD-NNN
  production_head  VARCHAR(100) NOT NULL,
  status           VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','po_raised','rejected')),
  created_at       TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE TABLE production_indent_items (
  id           SERIAL PRIMARY KEY,
  indent_id    INTEGER NOT NULL REFERENCES production_indents(id) ON DELETE CASCADE,
  item_name    VARCHAR(200) NOT NULL,
  quantity     NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  unit         VARCHAR(20) NOT NULL,
  required_by  DATE,
  priority     VARCHAR(10) NOT NULL DEFAULT 'normal'
               CHECK (priority IN ('low','normal','high','urgent'))
);
CREATE INDEX idx_prod_items_ind ON production_indent_items(indent_id);

-- ---------- po_source_links: which requests/indents a PO was raised from ----------
CREATE TABLE po_source_links (
  id           SERIAL PRIMARY KEY,
  po_id        INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  source_type  VARCHAR(12) NOT NULL CHECK (source_type IN ('branch','production')),
  source_id    INTEGER NOT NULL
);
CREATE INDEX idx_source_links_po ON po_source_links(po_id);
CREATE INDEX idx_source_links_src ON po_source_links(source_type, source_id);

-- ---------- purchase_invoices (one invoice per PO for this MVP) ----------
CREATE TABLE purchase_invoices (
  id              SERIAL PRIMARY KEY,
  invoice_number  VARCHAR(50) NOT NULL,
  po_id           INTEGER NOT NULL UNIQUE REFERENCES purchase_orders(id),
  invoice_date    DATE NOT NULL,
  invoice_amount  NUMERIC(14,2) NOT NULL CHECK (invoice_amount >= 0),
  gst_number      VARCHAR(20),
  status          VARCHAR(20) NOT NULL DEFAULT 'uploaded'
                  CHECK (status IN ('uploaded','matched','variance','mismatch')),
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ---------- three_way_match: one row per match run (PO vs GRN vs Invoice) ----------
CREATE TABLE three_way_match (
  id               SERIAL PRIMARY KEY,
  invoice_id       INTEGER NOT NULL REFERENCES purchase_invoices(id),
  po_id            INTEGER NOT NULL REFERENCES purchase_orders(id),
  po_total         NUMERIC(14,2) NOT NULL,
  grn_total        NUMERIC(14,2) NOT NULL,   -- goods received, valued at PO rates + GST
  invoice_total    NUMERIC(14,2) NOT NULL,
  variance_amount  NUMERIC(14,2) NOT NULL,   -- invoice_total - grn_total
  status           VARCHAR(20) NOT NULL CHECK (status IN ('matched','variance','mismatch')),
  notes            TEXT,
  created_at       TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_3way_po ON three_way_match(po_id);

-- ---------- purchase_orders: allow the new later-stage statuses ----------
ALTER TABLE purchase_orders DROP CONSTRAINT purchase_orders_status_check;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_status_check
  CHECK (status IN ('created','payment_pending','payment_done','in_transit','delivered',
                     'invoice_matched','variance_flagged','posted_to_tally','closed'));
