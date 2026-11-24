-- A load test's peer (src/relay-limits.js): 1, and never listed to other
-- relays. Everyone else's is NULL.
ALTER TABLE psp_announcements ADD COLUMN local_only INTEGER;
