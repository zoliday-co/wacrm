-- ============================================================
-- Niko assistant state.
--
-- Niko is a second assistant on the same WhatsApp number, routed to by
-- the sender's phone number (NIKO_PHONE_NUMBERS) rather than by how the
-- conversation started. Its per-conversation state — the current
-- request, the preferences it has learned, and recent completed
-- requests — lives here, mirroring `conversations.trip` (packages) and
-- `conversations.vibes` (Vibes).
--
-- NULL → this conversation has never been handled by Niko.
-- ============================================================

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS niko JSONB;
