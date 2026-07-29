-- ============================================================
-- Oliday Vibes routing state.
--
-- A conversation that entered through a Vibes surface (the
-- `(vibes:<tripId>)` tag or a generic Vibes enquiry) is handled by
-- the Vibes agent instead of the packages agent. The route decision
-- is sticky per conversation and lives here, together with the Vibes
-- agent's slot state (name, fromCity, month, groupType, …), mirroring
-- how `conversations.trip` backs the packages agent.
--
-- NULL → packages route (the default for every existing row).
-- ============================================================

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS vibes JSONB;
