-- ============================================================
-- 045_traveller_quotes_itineraries.sql — B2C traveller quotes,
-- itineraries, and the opaque public-access tokens used by the
-- callback page and the traveller quote share page.
--
-- Supplier quote (B2B cost to Oliday) and traveller quote (B2C
-- price to the traveller) are DIFFERENT entities. Every money
-- field the traveller quote derives from (supplier cost, markup,
-- discount, GST) is stored on the row so a booking can snapshot
-- it and history stays exact even if settings change later.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS traveller_quotes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  travel_lead_id UUID NOT NULL REFERENCES travel_leads(id) ON DELETE CASCADE,
  supplier_quote_id UUID REFERENCES supplier_quotes(id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1,
  title TEXT,
  currency TEXT NOT NULL DEFAULT 'INR',

  supplier_cost NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (supplier_cost >= 0),
  markup_type TEXT NOT NULL DEFAULT 'percent' CHECK (markup_type IN ('percent', 'fixed')),
  markup_value NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (markup_value >= 0),
  markup_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (markup_amount >= 0),
  discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  discount_reason TEXT,
  selling_price_before_tax NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (selling_price_before_tax >= 0),
  gst_rate NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (gst_rate >= 0),
  gst_taxable_base TEXT NOT NULL DEFAULT 'selling_price' CHECK (gst_taxable_base IN ('selling_price', 'markup')),
  gst_taxable_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (gst_taxable_amount >= 0),
  gst_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (gst_amount >= 0),
  traveller_total NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (traveller_total >= 0),
  gross_profit NUMERIC(12,2) NOT NULL DEFAULT 0,
  margin_pct NUMERIC(7,4) NOT NULL DEFAULT 0,

  inclusions TEXT,
  exclusions TEXT,
  cancellation_policy TEXT,
  notes TEXT,
  revision_reason TEXT,

  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
    'DRAFT', 'SENT', 'VIEWED', 'REVISED', 'ACCEPTED', 'REJECTED', 'EXPIRED'
  )),
  approval_status TEXT NOT NULL DEFAULT 'not_required'
    CHECK (approval_status IN ('not_required', 'pending', 'approved', 'rejected')),
  approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  valid_until DATE,
  sent_at TIMESTAMPTZ,
  viewed_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  -- WhatsApp message we sent with the share link (if any).
  sent_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  send_error TEXT,

  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (travel_lead_id, version)
);

CREATE INDEX IF NOT EXISTS idx_traveller_quotes_lead ON traveller_quotes(travel_lead_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_traveller_quotes_account_created ON traveller_quotes(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_traveller_quotes_status ON traveller_quotes(account_id, status);
CREATE INDEX IF NOT EXISTS idx_traveller_quotes_supplier_quote ON traveller_quotes(supplier_quote_id);

ALTER TABLE traveller_quotes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS traveller_quotes_select ON traveller_quotes;
DROP POLICY IF EXISTS traveller_quotes_insert ON traveller_quotes;
DROP POLICY IF EXISTS traveller_quotes_update ON traveller_quotes;
CREATE POLICY traveller_quotes_select ON traveller_quotes FOR SELECT USING (is_account_member(account_id));
CREATE POLICY traveller_quotes_insert ON traveller_quotes FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY traveller_quotes_update ON traveller_quotes FOR UPDATE USING (is_account_member(account_id, 'agent'));
-- No DELETE policy: quote versions are history.

DROP TRIGGER IF EXISTS set_updated_at ON traveller_quotes;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON traveller_quotes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- itineraries + itinerary_days — versioned per lead. Manual now;
-- an AI generator later just writes the same rows.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS itineraries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  travel_lead_id UUID NOT NULL REFERENCES travel_leads(id) ON DELETE CASCADE,
  traveller_quote_id UUID REFERENCES traveller_quotes(id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL,
  summary TEXT,
  hero_image_url TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'FINAL', 'ARCHIVED')),
  -- 'manual' | 'ai' | 'template' — how this version came to be.
  generated_by TEXT NOT NULL DEFAULT 'manual',
  extras JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (travel_lead_id, version)
);

CREATE INDEX IF NOT EXISTS idx_itineraries_lead ON itineraries(travel_lead_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_itineraries_account ON itineraries(account_id, created_at DESC);

ALTER TABLE itineraries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS itineraries_select ON itineraries;
DROP POLICY IF EXISTS itineraries_insert ON itineraries;
DROP POLICY IF EXISTS itineraries_update ON itineraries;
CREATE POLICY itineraries_select ON itineraries FOR SELECT USING (is_account_member(account_id));
CREATE POLICY itineraries_insert ON itineraries FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY itineraries_update ON itineraries FOR UPDATE USING (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS set_updated_at ON itineraries;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON itineraries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS itinerary_days (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  itinerary_id UUID NOT NULL REFERENCES itineraries(id) ON DELETE CASCADE,
  day_number INTEGER NOT NULL CHECK (day_number > 0),
  date DATE,
  title TEXT NOT NULL,
  description TEXT,
  hotel TEXT,
  meals TEXT,
  transport TEXT,
  activities JSONB NOT NULL DEFAULT '[]'::jsonb,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (itinerary_id, day_number)
);

CREATE INDEX IF NOT EXISTS idx_itinerary_days_itinerary ON itinerary_days(itinerary_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_itinerary_days_account ON itinerary_days(account_id);

ALTER TABLE itinerary_days ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS itinerary_days_select ON itinerary_days;
DROP POLICY IF EXISTS itinerary_days_modify ON itinerary_days;
CREATE POLICY itinerary_days_select ON itinerary_days FOR SELECT USING (is_account_member(account_id));
CREATE POLICY itinerary_days_modify ON itinerary_days FOR ALL
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));

-- ------------------------------------------------------------
-- travel_access_tokens — opaque, hashed, expiring, revocable
-- tokens for the public traveller surfaces:
--   kind = 'callback'         → /trip/callback/[token]
--   kind = 'traveller_quote'  → /q/[token]
-- (Supplier quote-form tokens live on rfq_suppliers.)
-- Server-only: no client write policy; members may read for
-- visibility (the hash is useless without the plaintext).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS travel_access_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('callback', 'traveller_quote')),
  token_hash TEXT NOT NULL UNIQUE,
  travel_lead_id UUID NOT NULL REFERENCES travel_leads(id) ON DELETE CASCADE,
  subject_id UUID,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  first_used_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  use_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_travel_access_tokens_lead ON travel_access_tokens(travel_lead_id, kind);
CREATE INDEX IF NOT EXISTS idx_travel_access_tokens_account ON travel_access_tokens(account_id);

ALTER TABLE travel_access_tokens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS travel_access_tokens_select ON travel_access_tokens;
CREATE POLICY travel_access_tokens_select ON travel_access_tokens FOR SELECT USING (is_account_member(account_id));
-- Inserts / revocations happen server-side via the service role only.
