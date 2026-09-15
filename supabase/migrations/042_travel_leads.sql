-- ============================================================
-- 042_travel_leads.sql — the travel lead, its versioned
-- requirement, and the append-only lead event log.
--
-- A travel lead EXTENDS a WACRM deal (the deal stays the sales
-- pipeline entity). It links to the existing contact and the
-- contact's WhatsApp conversation — no parallel traveller or
-- message tables.
--
-- Deduplication: `bot_session_id` is unique per account, so a
-- retried webhook cannot create a second lead. Phone is NOT a
-- uniqueness key — one contact may enquire many times.
--
-- Requirements are versioned (`travel_requirement_versions`) so
-- a re-quote never overwrites what the traveller first asked
-- for. `travel_leads` keeps a denormalised copy of the CURRENT
-- version's reporting fields (destination, dates, pax, budget)
-- so list/report queries don't need a join.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS travel_leads (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  deal_id UUID REFERENCES deals(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,

  bot_session_id TEXT,

  -- Attribution (Meta click-to-WhatsApp)
  source_type TEXT NOT NULL DEFAULT 'manual',
  campaign_id TEXT,
  campaign_name TEXT,
  adset_id TEXT,
  ad_id TEXT,
  ad_name TEXT,
  referral_data JSONB,

  -- Denormalised current requirement (reporting fields)
  traveller_name TEXT,
  destination_primary TEXT,
  destination_id UUID REFERENCES destinations(id) ON DELETE SET NULL,
  destinations JSONB NOT NULL DEFAULT '[]'::jsonb,
  departure_city TEXT,
  travel_start_date DATE,
  travel_end_date DATE,
  travel_month TEXT,
  dates_flexible BOOLEAN NOT NULL DEFAULT TRUE,
  flexibility_days INTEGER,
  nights INTEGER,
  days INTEGER,
  adults INTEGER NOT NULL DEFAULT 0,
  children INTEGER NOT NULL DEFAULT 0,
  infants INTEGER NOT NULL DEFAULT 0,
  child_ages JSONB NOT NULL DEFAULT '[]'::jsonb,
  room_count INTEGER,
  room_configuration TEXT,
  hotel_category TEXT,
  meal_plan TEXT,
  hotel_preferences JSONB NOT NULL DEFAULT '[]'::jsonb,
  vehicle_type TEXT,
  pickup_location TEXT,
  drop_location TEXT,
  budget_amount NUMERIC(12,2),
  budget_type TEXT CHECK (budget_type IS NULL OR budget_type IN ('total', 'per_person')),
  activities JSONB NOT NULL DEFAULT '[]'::jsonb,
  special_requests TEXT,
  qualification_summary TEXT,

  current_requirement_version INTEGER NOT NULL DEFAULT 1,

  status TEXT NOT NULL DEFAULT 'QUALIFIED' CHECK (status IN (
    'BOT_QUALIFYING', 'QUALIFIED', 'RFQ_SENT', 'AWAITING_SUPPLIER_QUOTES',
    'QUOTES_AVAILABLE', 'CALLBACK_REQUESTED', 'HUMAN_FOLLOWUP', 'REQUOTE',
    'NEGOTIATION', 'BOOKING_CONFIRMED', 'LOST'
  )),
  lost_reason TEXT,
  closed_at TIMESTAMPTZ,

  assigned_agent_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ,

  -- "What's next" surfaced on the lead header / dashboard.
  next_action_text TEXT,
  next_action_at TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_travel_leads_bot_session
  ON travel_leads(account_id, bot_session_id) WHERE bot_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_travel_leads_account_created ON travel_leads(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_travel_leads_deal ON travel_leads(deal_id);
CREATE INDEX IF NOT EXISTS idx_travel_leads_contact ON travel_leads(contact_id);
CREATE INDEX IF NOT EXISTS idx_travel_leads_conversation ON travel_leads(conversation_id);
CREATE INDEX IF NOT EXISTS idx_travel_leads_destination ON travel_leads(account_id, destination_primary);
CREATE INDEX IF NOT EXISTS idx_travel_leads_status ON travel_leads(account_id, status);
CREATE INDEX IF NOT EXISTS idx_travel_leads_agent ON travel_leads(assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_travel_leads_start_date ON travel_leads(travel_start_date);
CREATE INDEX IF NOT EXISTS idx_travel_leads_next_action ON travel_leads(account_id, next_action_at) WHERE next_action_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_travel_leads_campaign ON travel_leads(account_id, campaign_id) WHERE campaign_id IS NOT NULL;

ALTER TABLE travel_leads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS travel_leads_select ON travel_leads;
DROP POLICY IF EXISTS travel_leads_insert ON travel_leads;
DROP POLICY IF EXISTS travel_leads_update ON travel_leads;
DROP POLICY IF EXISTS travel_leads_delete ON travel_leads;
CREATE POLICY travel_leads_select ON travel_leads FOR SELECT USING (is_account_member(account_id));
CREATE POLICY travel_leads_insert ON travel_leads FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY travel_leads_update ON travel_leads FOR UPDATE USING (is_account_member(account_id, 'agent'));
CREATE POLICY travel_leads_delete ON travel_leads FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON travel_leads;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON travel_leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- travel_requirement_versions — immutable snapshots. V1 is the
-- bot's qualification; every agent edit appends a new version.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS travel_requirement_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  travel_lead_id UUID NOT NULL REFERENCES travel_leads(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,

  destination_primary TEXT,
  destinations JSONB NOT NULL DEFAULT '[]'::jsonb,
  departure_city TEXT,
  travel_start_date DATE,
  travel_end_date DATE,
  travel_month TEXT,
  dates_flexible BOOLEAN NOT NULL DEFAULT TRUE,
  flexibility_days INTEGER,
  nights INTEGER,
  days INTEGER,
  adults INTEGER NOT NULL DEFAULT 0,
  children INTEGER NOT NULL DEFAULT 0,
  infants INTEGER NOT NULL DEFAULT 0,
  child_ages JSONB NOT NULL DEFAULT '[]'::jsonb,
  room_count INTEGER,
  room_configuration TEXT,
  hotel_category TEXT,
  meal_plan TEXT,
  hotel_preferences JSONB NOT NULL DEFAULT '[]'::jsonb,
  vehicle_type TEXT,
  pickup_location TEXT,
  drop_location TEXT,
  budget_amount NUMERIC(12,2),
  budget_type TEXT,
  activities JSONB NOT NULL DEFAULT '[]'::jsonb,
  special_requests TEXT,

  change_reason TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (travel_lead_id, version)
);

CREATE INDEX IF NOT EXISTS idx_travel_requirement_versions_lead ON travel_requirement_versions(travel_lead_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_travel_requirement_versions_account ON travel_requirement_versions(account_id);

ALTER TABLE travel_requirement_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS travel_requirement_versions_select ON travel_requirement_versions;
DROP POLICY IF EXISTS travel_requirement_versions_insert ON travel_requirement_versions;
CREATE POLICY travel_requirement_versions_select ON travel_requirement_versions FOR SELECT USING (is_account_member(account_id));
CREATE POLICY travel_requirement_versions_insert ON travel_requirement_versions FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
-- No UPDATE / DELETE policies: versions are immutable.

ALTER TABLE travel_leads
  ADD COLUMN IF NOT EXISTS current_requirement_version_id UUID
    REFERENCES travel_requirement_versions(id) ON DELETE SET NULL;

-- ------------------------------------------------------------
-- travel_lead_events — the audit / timeline log. Append-only.
-- Raw WhatsApp messages are NOT copied here; the timeline query
-- merges `messages` at read time.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS travel_lead_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  travel_lead_id UUID NOT NULL REFERENCES travel_leads(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL DEFAULT 'system'
    CHECK (actor_type IN ('system', 'agent', 'bot', 'supplier', 'traveller')),
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  old_value JSONB,
  new_value JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_travel_lead_events_lead_created ON travel_lead_events(travel_lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_travel_lead_events_account_created ON travel_lead_events(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_travel_lead_events_type ON travel_lead_events(account_id, event_type);

ALTER TABLE travel_lead_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS travel_lead_events_select ON travel_lead_events;
DROP POLICY IF EXISTS travel_lead_events_insert ON travel_lead_events;
CREATE POLICY travel_lead_events_select ON travel_lead_events FOR SELECT USING (is_account_member(account_id));
CREATE POLICY travel_lead_events_insert ON travel_lead_events FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
-- No UPDATE / DELETE policies: the log is append-only.

-- Realtime: the lead detail page subscribes to its own lead's events
-- (filtered by travel_lead_id) to learn about new quotes / callbacks.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'travel_lead_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE travel_lead_events;
  END IF;
END $$;
