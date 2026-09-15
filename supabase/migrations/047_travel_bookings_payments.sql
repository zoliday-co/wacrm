-- ============================================================
-- 047_travel_bookings_payments.sql — bookings with immutable
-- financial snapshots, customer + supplier payments, and the
-- booking-number sequence.
--
-- A booking freezes the accepted traveller quote, the selected
-- supplier quote, the itinerary and the requirement into JSONB
-- snapshots plus typed money columns. Later edits to quotes or
-- settings never change what a booking reports.
--
-- Balances (`amount_received`, `customer_balance`,
-- `supplier_amount_paid`, `supplier_balance`) are maintained by
-- triggers on the payment tables so they can never drift from
-- the payment rows — the DB is the single source of truth.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  booking_number TEXT NOT NULL,

  travel_lead_id UUID REFERENCES travel_leads(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  deal_id UUID REFERENCES deals(id) ON DELETE SET NULL,
  selected_supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  supplier_quote_id UUID REFERENCES supplier_quotes(id) ON DELETE SET NULL,
  traveller_quote_id UUID REFERENCES traveller_quotes(id) ON DELETE SET NULL,
  itinerary_id UUID REFERENCES itineraries(id) ON DELETE SET NULL,

  traveller_name TEXT,
  destination_primary TEXT,
  travel_start_date DATE,
  travel_end_date DATE,
  nights INTEGER,
  adults INTEGER NOT NULL DEFAULT 0,
  children INTEGER NOT NULL DEFAULT 0,
  infants INTEGER NOT NULL DEFAULT 0,

  status TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN (
    'CONFIRMED', 'PARTIALLY_PAID', 'FULLY_PAID', 'UPCOMING', 'ONGOING', 'COMPLETED', 'CANCELLED'
  )),

  currency TEXT NOT NULL DEFAULT 'INR',
  supplier_cost NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (supplier_cost >= 0),
  markup_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  selling_price_before_tax NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (selling_price_before_tax >= 0),
  gst_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  gst_taxable_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  gst_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (gst_amount >= 0),
  traveller_total NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (traveller_total >= 0),
  gross_profit NUMERIC(12,2) NOT NULL DEFAULT 0,
  margin_pct NUMERIC(7,4) NOT NULL DEFAULT 0,

  amount_received NUMERIC(12,2) NOT NULL DEFAULT 0,
  customer_balance NUMERIC(12,2) NOT NULL DEFAULT 0,
  supplier_amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0,
  supplier_balance NUMERIC(12,2) NOT NULL DEFAULT 0,

  financial_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  itinerary_snapshot JSONB,
  requirement_snapshot JSONB,
  supplier_quote_snapshot JSONB,

  cancellation_reason TEXT,
  notes TEXT,

  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  UNIQUE (account_id, booking_number)
);

-- One booking per accepted traveller quote — the acceptance path is
-- idempotent because of this index, not because of application logic.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_traveller_quote
  ON bookings(traveller_quote_id) WHERE traveller_quote_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bookings_account_created ON bookings(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_lead ON bookings(travel_lead_id);
CREATE INDEX IF NOT EXISTS idx_bookings_contact ON bookings(contact_id);
CREATE INDEX IF NOT EXISTS idx_bookings_supplier ON bookings(selected_supplier_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(account_id, status);
CREATE INDEX IF NOT EXISTS idx_bookings_start ON bookings(account_id, travel_start_date);

ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bookings_select ON bookings;
DROP POLICY IF EXISTS bookings_insert ON bookings;
DROP POLICY IF EXISTS bookings_update ON bookings;
CREATE POLICY bookings_select ON bookings FOR SELECT USING (is_account_member(account_id));
CREATE POLICY bookings_insert ON bookings FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY bookings_update ON bookings FOR UPDATE USING (is_account_member(account_id, 'agent'));
-- No DELETE policy: bookings are cancelled, never deleted.

DROP TRIGGER IF EXISTS set_updated_at ON bookings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- travel_tasks.booking_id FK (table created in 046 before bookings existed).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'travel_tasks_booking_id_fkey'
  ) THEN
    ALTER TABLE travel_tasks
      ADD CONSTRAINT travel_tasks_booking_id_fkey
      FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE;
  END IF;
END $$;

-- ------------------------------------------------------------
-- booking_counters + next_booking_number(account, year)
-- Human-friendly ids: OLI-2026-00124, per account, per year.
-- SECURITY DEFINER so the row lock happens regardless of caller
-- RLS; the function only touches the caller-supplied account row
-- and the API always passes the authenticated account.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS booking_counters (
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  last_number INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, year)
);
ALTER TABLE booking_counters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS booking_counters_select ON booking_counters;
CREATE POLICY booking_counters_select ON booking_counters FOR SELECT USING (is_account_member(account_id));

CREATE OR REPLACE FUNCTION next_booking_number(p_account_id UUID, p_prefix TEXT DEFAULT 'OLI')
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_year INTEGER := EXTRACT(YEAR FROM NOW())::INTEGER;
  v_next INTEGER;
BEGIN
  INSERT INTO booking_counters (account_id, year, last_number)
  VALUES (p_account_id, v_year, 1)
  ON CONFLICT (account_id, year)
  DO UPDATE SET last_number = booking_counters.last_number + 1
  RETURNING last_number INTO v_next;
  RETURN format('%s-%s-%s', p_prefix, v_year, lpad(v_next::TEXT, 5, '0'));
END;
$$;
ALTER FUNCTION next_booking_number(UUID, TEXT) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION next_booking_number(UUID, TEXT) TO authenticated, service_role;

-- ------------------------------------------------------------
-- booking_items — operational line items (hotel confirmations,
-- cab / driver details, vouchers…). Minimal now; shaped so ops
-- features can grow without a schema redesign.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS booking_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN (
    'HOTEL', 'CAB', 'HOUSEBOAT', 'ACTIVITY', 'TRANSFER', 'FLIGHT', 'TRAIN', 'GUIDE', 'VOUCHER', 'OTHER'
  )),
  title TEXT NOT NULL,
  description TEXT,
  supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  start_date DATE,
  end_date DATE,
  confirmation_number TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'REQUESTED', 'CONFIRMED', 'CANCELLED')),
  amount NUMERIC(12,2),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_booking_items_booking ON booking_items(booking_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_booking_items_account ON booking_items(account_id);

ALTER TABLE booking_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS booking_items_select ON booking_items;
DROP POLICY IF EXISTS booking_items_modify ON booking_items;
CREATE POLICY booking_items_select ON booking_items FOR SELECT USING (is_account_member(account_id));
CREATE POLICY booking_items_modify ON booking_items FOR ALL
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS set_updated_at ON booking_items;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON booking_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- customer_payments
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'INR',
  payment_method TEXT NOT NULL DEFAULT 'UPI' CHECK (payment_method IN (
    'UPI', 'BANK_TRANSFER', 'PAYMENT_GATEWAY', 'CASH', 'CARD', 'OTHER'
  )),
  transaction_reference TEXT,
  payment_status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (payment_status IN (
    'PENDING', 'RECEIVED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED'
  )),
  refunded_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  notes TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_payments_booking ON customer_payments(booking_id, payment_date DESC);
CREATE INDEX IF NOT EXISTS idx_customer_payments_account_date ON customer_payments(account_id, payment_date DESC);

ALTER TABLE customer_payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customer_payments_select ON customer_payments;
DROP POLICY IF EXISTS customer_payments_insert ON customer_payments;
DROP POLICY IF EXISTS customer_payments_update ON customer_payments;
CREATE POLICY customer_payments_select ON customer_payments FOR SELECT USING (is_account_member(account_id));
CREATE POLICY customer_payments_insert ON customer_payments FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY customer_payments_update ON customer_payments FOR UPDATE USING (is_account_member(account_id, 'agent'));
-- No DELETE: payments are corrected via status (REFUNDED / FAILED), never removed.

DROP TRIGGER IF EXISTS set_updated_at ON customer_payments;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON customer_payments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- supplier_payments
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS supplier_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'INR',
  payment_method TEXT NOT NULL DEFAULT 'BANK_TRANSFER' CHECK (payment_method IN (
    'UPI', 'BANK_TRANSFER', 'PAYMENT_GATEWAY', 'CASH', 'CARD', 'OTHER'
  )),
  transaction_reference TEXT,
  status TEXT NOT NULL DEFAULT 'PAID' CHECK (status IN ('SCHEDULED', 'PAID', 'FAILED', 'CANCELLED')),
  due_date DATE,
  paid_at TIMESTAMPTZ,
  notes TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_supplier_payments_booking ON supplier_payments(booking_id);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_supplier ON supplier_payments(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_account_due ON supplier_payments(account_id, due_date) WHERE status = 'SCHEDULED';

ALTER TABLE supplier_payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS supplier_payments_select ON supplier_payments;
DROP POLICY IF EXISTS supplier_payments_insert ON supplier_payments;
DROP POLICY IF EXISTS supplier_payments_update ON supplier_payments;
CREATE POLICY supplier_payments_select ON supplier_payments FOR SELECT USING (is_account_member(account_id));
CREATE POLICY supplier_payments_insert ON supplier_payments FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY supplier_payments_update ON supplier_payments FOR UPDATE USING (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS set_updated_at ON supplier_payments;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON supplier_payments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- Balance maintenance. Recomputes the four balance columns on the
-- booking from its payment rows whenever a payment row changes.
-- Exact NUMERIC arithmetic; also derives the PAID status tier for
-- bookings that are not yet travelling / done / cancelled.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION recompute_booking_balances(p_booking_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_received NUMERIC(12,2);
  v_supplier_paid NUMERIC(12,2);
  v_total NUMERIC(12,2);
  v_cost NUMERIC(12,2);
  v_status TEXT;
  v_new_status TEXT;
BEGIN
  SELECT COALESCE(SUM(
    CASE payment_status
      WHEN 'RECEIVED' THEN amount
      WHEN 'PARTIALLY_REFUNDED' THEN amount - refunded_amount
      ELSE 0
    END), 0)
  INTO v_received
  FROM customer_payments WHERE booking_id = p_booking_id;

  SELECT COALESCE(SUM(CASE status WHEN 'PAID' THEN amount ELSE 0 END), 0)
  INTO v_supplier_paid
  FROM supplier_payments WHERE booking_id = p_booking_id;

  SELECT traveller_total, supplier_cost, status
  INTO v_total, v_cost, v_status
  FROM bookings WHERE id = p_booking_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_new_status := v_status;
  IF v_status IN ('CONFIRMED', 'PARTIALLY_PAID', 'FULLY_PAID') THEN
    IF v_received >= v_total AND v_total > 0 THEN
      v_new_status := 'FULLY_PAID';
    ELSIF v_received > 0 THEN
      v_new_status := 'PARTIALLY_PAID';
    ELSE
      v_new_status := 'CONFIRMED';
    END IF;
  END IF;

  UPDATE bookings
  SET amount_received = v_received,
      customer_balance = v_total - v_received,
      supplier_amount_paid = v_supplier_paid,
      supplier_balance = v_cost - v_supplier_paid,
      status = v_new_status
  WHERE id = p_booking_id;
END;
$$;
ALTER FUNCTION recompute_booking_balances(UUID) OWNER TO postgres;

CREATE OR REPLACE FUNCTION trg_recompute_booking_balances()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM recompute_booking_balances(OLD.booking_id);
    RETURN OLD;
  END IF;
  PERFORM recompute_booking_balances(NEW.booking_id);
  RETURN NEW;
END;
$$;
ALTER FUNCTION trg_recompute_booking_balances() OWNER TO postgres;

DROP TRIGGER IF EXISTS recompute_balances ON customer_payments;
CREATE TRIGGER recompute_balances AFTER INSERT OR UPDATE OR DELETE ON customer_payments
  FOR EACH ROW EXECUTE FUNCTION trg_recompute_booking_balances();
DROP TRIGGER IF EXISTS recompute_balances ON supplier_payments;
CREATE TRIGGER recompute_balances AFTER INSERT OR UPDATE OR DELETE ON supplier_payments
  FOR EACH ROW EXECUTE FUNCTION trg_recompute_booking_balances();

-- Initialise balances on insert (customer_balance = total, supplier_balance = cost).
CREATE OR REPLACE FUNCTION trg_init_booking_balances()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.customer_balance := NEW.traveller_total - NEW.amount_received;
  NEW.supplier_balance := NEW.supplier_cost - NEW.supplier_amount_paid;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS init_balances ON bookings;
CREATE TRIGGER init_balances BEFORE INSERT ON bookings
  FOR EACH ROW EXECUTE FUNCTION trg_init_booking_balances();
