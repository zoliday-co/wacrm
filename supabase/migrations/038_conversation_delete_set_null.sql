-- ============================================================
-- Conversation deletion (the inbox "Delete conversation" action).
--
-- `deals.conversation_id` was created with no ON DELETE rule (NO
-- ACTION), so deleting a conversation that a deal links to failed
-- with an FK violation. The deal outlives the chat thread — detach
-- it instead. Every other referencing table already cascades
-- (messages, message_actions, notifications) or sets null
-- (flow_runs, ai_usage_log).
-- ============================================================

ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_conversation_id_fkey;
ALTER TABLE deals ADD CONSTRAINT deals_conversation_id_fkey
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL;
