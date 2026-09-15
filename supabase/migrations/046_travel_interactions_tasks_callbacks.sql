-- ============================================================
-- 046_travel_interactions_tasks_callbacks.sql — human-side
-- records: call logs / notes (lead_interactions), follow-up
-- tasks (travel_tasks — WACRM has no task module to reuse), and
-- traveller callback requests.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS lead_interactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  travel_lead_id UUID NOT NULL REFERENCES travel_leads(id) ON DELETE CASCADE,
  interaction_type TEXT NOT NULL CHECK (interaction_type IN ('CALL', 'NOTE', 'FOLLOW_UP', 'MEETING', 'SYSTEM')),
  agent_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  summary TEXT NOT NULL,
  details TEXT,
  outcome TEXT,
  -- Call-specific
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  next_follow_up_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lead_interactions_lead ON lead_interactions(travel_lead_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_interactions_account ON lead_interactions(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_interactions_agent ON lead_interactions(agent_id);
CREATE INDEX IF NOT EXISTS idx_lead_interactions_follow_up ON lead_interactions(account_id, next_follow_up_at) WHERE next_follow_up_at IS NOT NULL;

ALTER TABLE lead_interactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lead_interactions_select ON lead_interactions;
DROP POLICY IF EXISTS lead_interactions_insert ON lead_interactions;
DROP POLICY IF EXISTS lead_interactions_update ON lead_interactions;
DROP POLICY IF EXISTS lead_interactions_delete ON lead_interactions;
CREATE POLICY lead_interactions_select ON lead_interactions FOR SELECT USING (is_account_member(account_id));
CREATE POLICY lead_interactions_insert ON lead_interactions FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY lead_interactions_update ON lead_interactions FOR UPDATE USING (is_account_member(account_id, 'agent'));
CREATE POLICY lead_interactions_delete ON lead_interactions FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON lead_interactions;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON lead_interactions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- travel_tasks
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS travel_tasks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  travel_lead_id UUID REFERENCES travel_leads(id) ON DELETE CASCADE,
  booking_id UUID,
  title TEXT NOT NULL,
  description TEXT,
  task_type TEXT NOT NULL DEFAULT 'GENERAL' CHECK (task_type IN (
    'GENERAL', 'CALL', 'FOLLOW_UP', 'CALLBACK', 'SUPPLIER', 'PAYMENT', 'OPERATIONS'
  )),
  assigned_to UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  priority TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  due_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED')),
  -- Follow-up reminders: the cron notifies the assignee once when a
  -- task comes due (`reminded_at` prevents repeats) and optionally at
  -- `remind_at` ahead of the due time.
  remind_at TIMESTAMPTZ,
  reminded_at TIMESTAMPTZ,
  -- Idempotency key for system-generated tasks (e.g. one callback task per request).
  source_key TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_travel_tasks_source_key
  ON travel_tasks(account_id, source_key) WHERE source_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_travel_tasks_lead ON travel_tasks(travel_lead_id);
CREATE INDEX IF NOT EXISTS idx_travel_tasks_booking ON travel_tasks(booking_id);
CREATE INDEX IF NOT EXISTS idx_travel_tasks_assignee_open ON travel_tasks(assigned_to, due_at) WHERE status IN ('OPEN', 'IN_PROGRESS');
CREATE INDEX IF NOT EXISTS idx_travel_tasks_account_due ON travel_tasks(account_id, due_at) WHERE status IN ('OPEN', 'IN_PROGRESS');
CREATE INDEX IF NOT EXISTS idx_travel_tasks_reminder_pending ON travel_tasks(due_at) WHERE status IN ('OPEN', 'IN_PROGRESS') AND reminded_at IS NULL;

ALTER TABLE travel_tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS travel_tasks_select ON travel_tasks;
DROP POLICY IF EXISTS travel_tasks_insert ON travel_tasks;
DROP POLICY IF EXISTS travel_tasks_update ON travel_tasks;
DROP POLICY IF EXISTS travel_tasks_delete ON travel_tasks;
CREATE POLICY travel_tasks_select ON travel_tasks FOR SELECT USING (is_account_member(account_id));
CREATE POLICY travel_tasks_insert ON travel_tasks FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY travel_tasks_update ON travel_tasks FOR UPDATE USING (is_account_member(account_id, 'agent'));
CREATE POLICY travel_tasks_delete ON travel_tasks FOR DELETE USING (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS set_updated_at ON travel_tasks;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON travel_tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- callback_requests — traveller-chosen call slots.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS callback_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  travel_lead_id UUID NOT NULL REFERENCES travel_leads(id) ON DELETE CASCADE,
  preferred_date DATE,
  preferred_time TIME,
  time_window TEXT CHECK (time_window IS NULL OR time_window IN ('NOW', 'MORNING', 'AFTERNOON', 'EVENING', 'SPECIFIC')),
  scheduled_at TIMESTAMPTZ,
  traveller_note TEXT,
  status TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (status IN (
    'REQUESTED', 'SCHEDULED', 'COMPLETED', 'MISSED', 'CANCELLED'
  )),
  assigned_agent_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  task_id UUID REFERENCES travel_tasks(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_callback_requests_lead ON callback_requests(travel_lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_callback_requests_account_sched ON callback_requests(account_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_callback_requests_agent ON callback_requests(assigned_agent_id) WHERE status IN ('REQUESTED', 'SCHEDULED');

ALTER TABLE callback_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS callback_requests_select ON callback_requests;
DROP POLICY IF EXISTS callback_requests_insert ON callback_requests;
DROP POLICY IF EXISTS callback_requests_update ON callback_requests;
CREATE POLICY callback_requests_select ON callback_requests FOR SELECT USING (is_account_member(account_id));
CREATE POLICY callback_requests_insert ON callback_requests FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY callback_requests_update ON callback_requests FOR UPDATE USING (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS set_updated_at ON callback_requests;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON callback_requests
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'callback_requests'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE callback_requests;
  END IF;
END $$;
