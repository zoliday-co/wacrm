-- Ensure the two destination roots added after the original travel seed exist
-- for every current account. The application seed remains the source for
-- child destinations and is now safe to rerun to fill any missing entries.
INSERT INTO destinations (account_id, name, slug, aliases)
SELECT id, 'Maharashtra', 'maharashtra', '{}'::TEXT[]
FROM accounts
ON CONFLICT (account_id, slug) DO NOTHING;

INSERT INTO destinations (account_id, name, slug, aliases)
SELECT id, 'Uttar Pradesh', 'uttar-pradesh', ARRAY['up', 'u.p.']::TEXT[]
FROM accounts
ON CONFLICT (account_id, slug) DO NOTHING;
