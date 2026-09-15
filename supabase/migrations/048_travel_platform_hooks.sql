-- ============================================================
-- 048_travel_platform_hooks.sql — small hooks into existing
-- WACRM tables so the travel layer plugs into notifications and
-- the inbox without parallel infrastructure.
--
--   1. notifications: new travel types + a `travel_lead_id`
--      column so the Notifications page can deep-link to the
--      lead instead of only to a conversation.
--   2. conversations: `travel_lead_id` back-reference so the
--      inbox can show "this thread has an open Kerala lead" and
--      jump to it.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS travel_lead_id UUID REFERENCES travel_leads(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_notifications_travel_lead ON notifications(travel_lead_id);

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
  'conversation_assigned',
  'travel_lead_assigned',
  'travel_callback_requested',
  'travel_supplier_quote_received',
  'travel_quotes_ready',
  'travel_quote_accepted',
  'travel_task_due',
  'travel_quote_approval_requested'
));

-- conversations ↔ latest travel lead (nullable; set on ingestion).
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS travel_lead_id UUID REFERENCES travel_leads(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_travel_lead ON conversations(travel_lead_id);
