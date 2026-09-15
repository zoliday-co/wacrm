-- ============================================================
-- 043_travel_rfqs.sql — RFQs and their supplier recipients.
--
-- An RFQ is generated from ONE requirement version (so RFQ V2
-- always points at the requirement it was built from). Each
-- recipient row carries the hashed opaque token that unlocks the
-- public supplier quote form — the plaintext token lives only in
-- the WhatsApp message we send; a leaked DB row cannot be used to
-- open the form.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS rfqs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  travel_lead_id UUID NOT NULL REFERENCES travel_leads(id) ON DELETE CASCADE,
  requirement_version_id UUID REFERENCES travel_requirement_versions(id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
    'DRAFT', 'SENT', 'PARTIALLY_RESPONDED', 'RESPONDED', 'CLOSED', 'CANCELLED'
  )),
  recipient_count INTEGER NOT NULL DEFAULT 0,
  response_count INTEGER NOT NULL DEFAULT 0,
  traveller_notified_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  notes TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (travel_lead_id, version)
);

CREATE INDEX IF NOT EXISTS idx_rfqs_account_created ON rfqs(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rfqs_lead ON rfqs(travel_lead_id);
CREATE INDEX IF NOT EXISTS idx_rfqs_status ON rfqs(account_id, status);
CREATE INDEX IF NOT EXISTS idx_rfqs_expires ON rfqs(expires_at) WHERE status IN ('SENT', 'PARTIALLY_RESPONDED');

ALTER TABLE rfqs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rfqs_select ON rfqs;
DROP POLICY IF EXISTS rfqs_insert ON rfqs;
DROP POLICY IF EXISTS rfqs_update ON rfqs;
DROP POLICY IF EXISTS rfqs_delete ON rfqs;
CREATE POLICY rfqs_select ON rfqs FOR SELECT USING (is_account_member(account_id));
CREATE POLICY rfqs_insert ON rfqs FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY rfqs_update ON rfqs FOR UPDATE USING (is_account_member(account_id, 'agent'));
CREATE POLICY rfqs_delete ON rfqs FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON rfqs;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON rfqs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- rfq_suppliers — one row per supplier the RFQ went to.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rfq_suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  rfq_id UUID NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN (
    'PENDING', 'SENT', 'RESPONDED', 'DECLINED', 'EXPIRED', 'SELECTED', 'REJECTED'
  )),
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ,
  responded_at TIMESTAMPTZ,
  reminder_count INTEGER NOT NULL DEFAULT 0,
  last_reminder_at TIMESTAMPTZ,
  -- Last WhatsApp send failure (kept so an agent can retry from the UI).
  send_error TEXT,
  send_attempts INTEGER NOT NULL DEFAULT 0,
  sent_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  -- Opaque quote-form token: SHA-256 hash only.
  quote_token_hash TEXT UNIQUE,
  quote_token_expires_at TIMESTAMPTZ,
  quote_token_revoked_at TIMESTAMPTZ,
  latest_quote_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (rfq_id, supplier_id)
);

CREATE INDEX IF NOT EXISTS idx_rfq_suppliers_rfq ON rfq_suppliers(rfq_id);
CREATE INDEX IF NOT EXISTS idx_rfq_suppliers_supplier ON rfq_suppliers(supplier_id);
CREATE INDEX IF NOT EXISTS idx_rfq_suppliers_account ON rfq_suppliers(account_id);
CREATE INDEX IF NOT EXISTS idx_rfq_suppliers_pending_reminder
  ON rfq_suppliers(sent_at) WHERE status = 'SENT';

ALTER TABLE rfq_suppliers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rfq_suppliers_select ON rfq_suppliers;
DROP POLICY IF EXISTS rfq_suppliers_insert ON rfq_suppliers;
DROP POLICY IF EXISTS rfq_suppliers_update ON rfq_suppliers;
DROP POLICY IF EXISTS rfq_suppliers_delete ON rfq_suppliers;
CREATE POLICY rfq_suppliers_select ON rfq_suppliers FOR SELECT USING (is_account_member(account_id));
CREATE POLICY rfq_suppliers_insert ON rfq_suppliers FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY rfq_suppliers_update ON rfq_suppliers FOR UPDATE USING (is_account_member(account_id, 'agent'));
CREATE POLICY rfq_suppliers_delete ON rfq_suppliers FOR DELETE USING (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS set_updated_at ON rfq_suppliers;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON rfq_suppliers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
