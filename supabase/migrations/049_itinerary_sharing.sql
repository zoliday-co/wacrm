-- Secure public links for branded traveller itineraries.
ALTER TABLE travel_access_tokens
  DROP CONSTRAINT IF EXISTS travel_access_tokens_kind_check;

ALTER TABLE travel_access_tokens
  ADD CONSTRAINT travel_access_tokens_kind_check
  CHECK (kind IN ('callback', 'traveller_quote', 'itinerary'));

