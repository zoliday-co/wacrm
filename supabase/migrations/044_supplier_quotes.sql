-- ============================================================
-- 044_supplier_quotes.sql — supplier (B2B) quotes and their
-- optional line items.
--
-- Every revision is a NEW row (`version` increments per
-- rfq_supplier); the previous row is flipped to REVISED, never
-- overwritten. `rfq_suppliers.latest_quote_id` points at the
-- newest one. Money is NUMERIC — never floating point.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS supplier_quotes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  rfq_id UUID NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  rfq_supplier_id UUID NOT NULL REFERENCES rfq_suppliers(id) ON DELETE CASCADE,
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  travel_lead_id UUID NOT NULL REFERENCES travel_leads(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,

  currency TEXT NOT NULL DEFAULT 'INR',
  hotel_cost NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (hotel_cost >= 0),
  transport_cost NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (transport_cost >= 0),
  activities_cost NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (activities_cost >= 0),
  other_cost NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (other_cost >= 0),
  subtotal NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  supplier_tax_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (supplier_tax_amount >= 0),
  total_supplier_cost NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total_supplier_cost >= 0),

  hotel_details JSONB NOT NULL DEFAULT '[]'::jsonb,
  transport_details JSONB NOT NULL DEFAULT '{}'::jsonb,
  activity_details JSONB NOT NULL DEFAULT '[]'::jsonb,

  inclusions TEXT,
  exclusions TEXT,
  cancellation_policy TEXT,
  valid_until DATE,
  supplier_notes TEXT,

  status TEXT NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN (
    'DRAFT', 'SUBMITTED', 'REVISED', 'SHORTLISTED', 'SELECTED', 'REJECTED', 'EXPIRED'
  )),
  -- Internal (agent-only) notes about this quote — never shown to the supplier.
  internal_notes TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Seconds between the RFQ send and this submission (response-time metric).
  response_seconds INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (rfq_supplier_id, version)
);

CREATE INDEX IF NOT EXISTS idx_supplier_quotes_lead ON supplier_quotes(travel_lead_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_quotes_rfq ON supplier_quotes(rfq_id);
CREATE INDEX IF NOT EXISTS idx_supplier_quotes_supplier ON supplier_quotes(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_quotes_account_created ON supplier_quotes(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_quotes_status ON supplier_quotes(account_id, status);

ALTER TABLE supplier_quotes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS supplier_quotes_select ON supplier_quotes;
DROP POLICY IF EXISTS supplier_quotes_insert ON supplier_quotes;
DROP POLICY IF EXISTS supplier_quotes_update ON supplier_quotes;
CREATE POLICY supplier_quotes_select ON supplier_quotes FOR SELECT USING (is_account_member(account_id));
CREATE POLICY supplier_quotes_insert ON supplier_quotes FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY supplier_quotes_update ON supplier_quotes FOR UPDATE USING (is_account_member(account_id, 'agent'));
-- No DELETE policy: quotes are history.

DROP TRIGGER IF EXISTS set_updated_at ON supplier_quotes;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON supplier_quotes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Back-reference from the recipient to its newest quote.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rfq_suppliers_latest_quote_fkey'
  ) THEN
    ALTER TABLE rfq_suppliers
      ADD CONSTRAINT rfq_suppliers_latest_quote_fkey
      FOREIGN KEY (latest_quote_id) REFERENCES supplier_quotes(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ------------------------------------------------------------
-- supplier_quote_items — optional line-level breakdown.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS supplier_quote_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  supplier_quote_id UUID NOT NULL REFERENCES supplier_quotes(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN (
    'HOTEL', 'CAB', 'HOUSEBOAT', 'ACTIVITY', 'TRANSFER', 'MEAL', 'GUIDE', 'OTHER'
  )),
  description TEXT NOT NULL,
  day_number INTEGER,
  quantity NUMERIC(10,2) NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  unit_cost NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_supplier_quote_items_quote ON supplier_quote_items(supplier_quote_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_supplier_quote_items_account ON supplier_quote_items(account_id);

ALTER TABLE supplier_quote_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS supplier_quote_items_select ON supplier_quote_items;
DROP POLICY IF EXISTS supplier_quote_items_modify ON supplier_quote_items;
CREATE POLICY supplier_quote_items_select ON supplier_quote_items FOR SELECT USING (is_account_member(account_id));
CREATE POLICY supplier_quote_items_modify ON supplier_quote_items FOR ALL
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));

-- Realtime: agents viewing a lead see "new supplier quote" live.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'supplier_quotes'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE supplier_quotes;
  END IF;
END $$;
