-- What a peer is, when it says (an announce's capabilities.role, such as
-- "storage"): relays store it and list it, so peers in a scope can tell
-- the kinds of peer apart before they dial. Most peers have none.
ALTER TABLE psp_announcements ADD COLUMN role TEXT;
