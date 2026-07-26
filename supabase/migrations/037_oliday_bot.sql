-- ============================================================
-- 037_oliday_bot
--
-- Foundation for the Oliday enquiry bot + three correctness fixes
-- the bot's acceptance tests depend on (and that benefit the CRM
-- generally):
--
--   1. Contact opt-out (STOP/UNSUBSCRIBE) — contacts.opted_out gates
--      every automated send path (flows, automations, AI auto-reply,
--      broadcasts). Nothing existed before; automated messages could
--      not be stopped by the recipient.
--   2. Inbound webhook idempotency — Meta retries deliveries on slow
--      acks. There was no unique constraint on messages.message_id,
--      so a redelivery inserted a duplicate row AND re-dispatched the
--      engines (duplicate bot replies). A partial unique index on
--      customer messages turns the race into a unique-violation the
--      webhook can catch and treat as "already processed".
--   3. Bot conversation state — qualification slots (trip), shown /
--      selected packages, and how the conversation started
--      (entry_context), all on the existing conversations table so
--      the human inbox and the bot share one thread of record.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ------------------------------------------------------------
-- contacts: opt-out + click-to-WhatsApp ad referral metadata
-- ------------------------------------------------------------
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS opted_out BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS opted_out_at TIMESTAMPTZ;
-- Raw `messages[].referral` payload from the Cloud API webhook
-- (source_id, headline, body, ctwa_clid, ...). Stored on first
-- contact so a lead from a Meta/Instagram ad keeps its attribution.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS referral JSONB;

-- Broadcast planning filters on this; without an index every plan is
-- a full scan of the account's contacts.
CREATE INDEX IF NOT EXISTS idx_contacts_opted_out
  ON contacts (account_id) WHERE opted_out;

-- ------------------------------------------------------------
-- conversations: bot qualification state
-- ------------------------------------------------------------
-- The trip slots (§10 of the bot spec). Slots are the source of
-- truth for "what do we still need to ask" — not the transcript.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS trip JSONB NOT NULL DEFAULT '{}'::jsonb;
-- [{promo_id, h_id, name, per_person}] — the packages last presented,
-- so "tell me more about the 2nd one" can resolve without a re-search.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS shown_packages JSONB;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS selected_package JSONB;
-- 'deal_link' | 'ad' | 'site_cta' | 'cold' — how the enquiry arrived.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS entry_context TEXT;

-- ------------------------------------------------------------
-- messages: inbound idempotency
-- ------------------------------------------------------------
-- Scoped to customer rows only: outbound rows reuse this column for
-- Meta send ids and migration 009 deliberately left it non-unique
-- (status updates match on it without .single()). Inbound wamids are
-- globally unique per Meta, so a duplicate here is always a webhook
-- redelivery.
--
-- Pre-clean any duplicates a pre-037 deploy accumulated (keep the
-- earliest row) so the unique index can build.
DELETE FROM messages m
USING messages keeper
WHERE m.sender_type = 'customer'
  AND m.message_id IS NOT NULL
  AND keeper.sender_type = 'customer'
  AND keeper.message_id = m.message_id
  AND keeper.created_at < m.created_at;

CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_inbound_wamid
  ON messages (message_id)
  WHERE sender_type = 'customer' AND message_id IS NOT NULL;

-- ------------------------------------------------------------
-- ai_configs: allow the Gemini provider
-- ------------------------------------------------------------
-- Migration 029 pinned provider to ('openai','anthropic'). The Oliday
-- bot runs on Google Gemini (same BYO-key pattern — the key lives
-- encrypted in api_key like the others).
ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_provider_check;
ALTER TABLE ai_configs ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'gemini'));

-- ai_usage_log has its own provider CHECK (migration 029). Without
-- widening it too, every Gemini usage row is rejected — and since
-- `logAiUsage` deliberately swallows its own errors (it must never
-- add latency to a customer-facing send), the failure is silent:
-- token spend simply never shows in Settings → AI usage.
ALTER TABLE ai_usage_log DROP CONSTRAINT IF EXISTS ai_usage_log_provider_check;
ALTER TABLE ai_usage_log ADD CONSTRAINT ai_usage_log_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'gemini'));
