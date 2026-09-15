-- ============================================================
-- 041_travel_foundation.sql — Oliday travel layer: settings,
-- destinations, suppliers, supplier↔destination mapping, and a
-- stage key on pipeline stages so the Oliday pipeline can map
-- lead statuses onto WACRM deal stages.
--
-- Tenancy follows migration 017: every table carries
-- `account_id` and every policy goes through
-- `is_account_member(account_id, min_role)`. Audit columns
-- (`created_by`) point at auth.users with ON DELETE SET NULL so
-- removing a teammate never destroys travel history.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ------------------------------------------------------------
-- pipeline_stages.stage_key — machine key for a stage so code can
-- move a deal to "QUALIFIED" without matching on a renamable name.
-- NULL for every non-travel stage.
-- ------------------------------------------------------------
ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS stage_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_pipeline_stages_stage_key
  ON pipeline_stages(pipeline_id, stage_key) WHERE stage_key IS NOT NULL;

-- ------------------------------------------------------------
-- travel_settings — one row per account. Every configurable knob
-- the spec calls out lives here (supplier fan-out, notification
-- threshold, reminders, tax model, margin guardrails).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS travel_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  pipeline_id UUID REFERENCES pipelines(id) ON DELETE SET NULL,

  currency TEXT NOT NULL DEFAULT 'INR',

  -- Supplier matching / RFQ
  max_suppliers_per_rfq INTEGER NOT NULL DEFAULT 5 CHECK (max_suppliers_per_rfq BETWEEN 1 AND 50),
  min_quotes_before_notification INTEGER NOT NULL DEFAULT 3 CHECK (min_quotes_before_notification BETWEEN 1 AND 50),
  rfq_deadline_hours INTEGER NOT NULL DEFAULT 24 CHECK (rfq_deadline_hours BETWEEN 1 AND 720),
  supplier_quote_token_ttl_hours INTEGER NOT NULL DEFAULT 72 CHECK (supplier_quote_token_ttl_hours BETWEEN 1 AND 2160),
  supplier_reminder_hours INTEGER NOT NULL DEFAULT 4 CHECK (supplier_reminder_hours BETWEEN 1 AND 720),
  supplier_max_reminders INTEGER NOT NULL DEFAULT 2 CHECK (supplier_max_reminders BETWEEN 0 AND 10),
  auto_send_rfq BOOLEAN NOT NULL DEFAULT TRUE,
  auto_notify_traveller BOOLEAN NOT NULL DEFAULT TRUE,

  -- Approved WhatsApp templates (optional). When set, the supplier
  -- RFQ / traveller "quotes ready" sends use the template (works
  -- outside the 24h window); otherwise a plain text send is tried.
  supplier_rfq_template_name TEXT,
  supplier_rfq_template_language TEXT,
  traveller_quotes_ready_template_name TEXT,
  traveller_quotes_ready_template_language TEXT,

  -- Callback link lifetime
  callback_token_ttl_hours INTEGER NOT NULL DEFAULT 168 CHECK (callback_token_ttl_hours BETWEEN 1 AND 2160),

  -- Tax model. Not a legal assumption — configurable per account.
  gst_rate NUMERIC(5,2) NOT NULL DEFAULT 5.00 CHECK (gst_rate >= 0 AND gst_rate <= 100),
  gst_taxable_base TEXT NOT NULL DEFAULT 'selling_price'
    CHECK (gst_taxable_base IN ('selling_price', 'markup')),

  -- Pricing defaults + guardrails
  default_markup_type TEXT NOT NULL DEFAULT 'percent' CHECK (default_markup_type IN ('percent', 'fixed')),
  default_markup_value NUMERIC(12,2) NOT NULL DEFAULT 15.00 CHECK (default_markup_value >= 0),
  margin_warning_pct NUMERIC(5,2) NOT NULL DEFAULT 8.00 CHECK (margin_warning_pct >= 0 AND margin_warning_pct <= 100),
  -- When set, traveller quotes below this margin need admin approval
  -- before they can be sent. NULL = never require approval.
  margin_approval_pct NUMERIC(5,2) CHECK (margin_approval_pct IS NULL OR (margin_approval_pct >= 0 AND margin_approval_pct <= 100)),
  traveller_quote_validity_days INTEGER NOT NULL DEFAULT 7 CHECK (traveller_quote_validity_days BETWEEN 1 AND 365),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE travel_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS travel_settings_select ON travel_settings;
DROP POLICY IF EXISTS travel_settings_insert ON travel_settings;
DROP POLICY IF EXISTS travel_settings_update ON travel_settings;
DROP POLICY IF EXISTS travel_settings_delete ON travel_settings;
CREATE POLICY travel_settings_select ON travel_settings FOR SELECT USING (is_account_member(account_id));
CREATE POLICY travel_settings_insert ON travel_settings FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY travel_settings_update ON travel_settings FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY travel_settings_delete ON travel_settings FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON travel_settings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON travel_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- destinations — hierarchical (Kerala ├ Munnar ├ Thekkady …).
-- `aliases` lets matching accept "Kerela"/"kerala backwaters".
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS destinations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  parent_id UUID REFERENCES destinations(id) ON DELETE SET NULL,
  aliases TEXT[] NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_destinations_account ON destinations(account_id);
CREATE INDEX IF NOT EXISTS idx_destinations_parent ON destinations(parent_id);

ALTER TABLE destinations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS destinations_select ON destinations;
DROP POLICY IF EXISTS destinations_insert ON destinations;
DROP POLICY IF EXISTS destinations_update ON destinations;
DROP POLICY IF EXISTS destinations_delete ON destinations;
CREATE POLICY destinations_select ON destinations FOR SELECT USING (is_account_member(account_id));
CREATE POLICY destinations_insert ON destinations FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY destinations_update ON destinations FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY destinations_delete ON destinations FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON destinations;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON destinations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- suppliers — DMCs, hotels, transporters… `contact_id` links the
-- supplier to the WACRM contact/conversation used for RFQ sends
-- so supplier replies land in the shared inbox like any thread.
-- Soft-deleted via `deleted_at` so historical quotes keep their
-- supplier.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS suppliers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  company_name TEXT,
  primary_contact_name TEXT,
  phone TEXT,
  whatsapp_phone TEXT,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'BLACKLISTED')),
  supplier_type TEXT NOT NULL DEFAULT 'DMC'
    CHECK (supplier_type IN ('DMC', 'HOTEL', 'TRANSPORTER', 'ACTIVITY_PROVIDER', 'GUIDE', 'MULTI_SERVICE')),
  rating NUMERIC(3,2) CHECK (rating IS NULL OR (rating >= 0 AND rating <= 5)),
  notes TEXT,
  payment_terms TEXT,
  preferred BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  deleted_at TIMESTAMPTZ,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_suppliers_account ON suppliers(account_id);
CREATE INDEX IF NOT EXISTS idx_suppliers_account_active ON suppliers(account_id) WHERE active AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_suppliers_contact ON suppliers(contact_id);

ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS suppliers_select ON suppliers;
DROP POLICY IF EXISTS suppliers_insert ON suppliers;
DROP POLICY IF EXISTS suppliers_update ON suppliers;
DROP POLICY IF EXISTS suppliers_delete ON suppliers;
CREATE POLICY suppliers_select ON suppliers FOR SELECT USING (is_account_member(account_id));
CREATE POLICY suppliers_insert ON suppliers FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY suppliers_update ON suppliers FOR UPDATE USING (is_account_member(account_id, 'agent'));
CREATE POLICY suppliers_delete ON suppliers FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON suppliers;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- supplier_destinations — one supplier serves many destinations.
-- `priority` is ascending (1 = first choice) within a destination.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS supplier_destinations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  destination_id UUID NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL DEFAULT 100,
  preferred BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  service_types TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (supplier_id, destination_id)
);

CREATE INDEX IF NOT EXISTS idx_supplier_destinations_destination ON supplier_destinations(destination_id) WHERE active;
CREATE INDEX IF NOT EXISTS idx_supplier_destinations_supplier ON supplier_destinations(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_destinations_account ON supplier_destinations(account_id);

ALTER TABLE supplier_destinations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS supplier_destinations_select ON supplier_destinations;
DROP POLICY IF EXISTS supplier_destinations_modify ON supplier_destinations;
CREATE POLICY supplier_destinations_select ON supplier_destinations FOR SELECT USING (is_account_member(account_id));
CREATE POLICY supplier_destinations_modify ON supplier_destinations FOR ALL
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));
