-- D1 schema for freertc signaling relay

CREATE TABLE IF NOT EXISTS psp_announcements (
  network TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  session_id TEXT,
  expires_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (network, peer_id)
);

CREATE INDEX IF NOT EXISTS idx_announcements_network_expires
  ON psp_announcements (network, expires_at_ms);

CREATE TABLE IF NOT EXISTS psp_relay (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  network TEXT NOT NULL,
  to_peer_id TEXT NOT NULL,
  type TEXT NOT NULL,
  session_id TEXT,
  message_json TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_relay_lookup
  ON psp_relay (network, to_peer_id, created_at_ms);

CREATE INDEX IF NOT EXISTS idx_relay_lookup_ordered
  ON psp_relay (network, to_peer_id, created_at_ms, id);

CREATE INDEX IF NOT EXISTS idx_relay_expires
  ON psp_relay (expires_at_ms);

-- Federated relay registry (populated on hub workers)
CREATE TABLE IF NOT EXISTS psp_relays (
  url TEXT PRIMARY KEY,
  name TEXT,
  registered_at_ms INTEGER NOT NULL,
  last_seen_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_relays_last_seen
  ON psp_relays (last_seen_ms);

-- Bounded Kademlia relay routing table and replicated provider records.
CREATE TABLE IF NOT EXISTS psp_kad_nodes (
  node_id TEXT PRIMARY KEY,
  bucket_index INTEGER NOT NULL,
  url TEXT NOT NULL,
  record_json TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  last_seen_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_kad_nodes_bucket_seen
  ON psp_kad_nodes (bucket_index, last_seen_ms DESC);

CREATE INDEX IF NOT EXISTS idx_kad_nodes_expires
  ON psp_kad_nodes (expires_at_ms);

CREATE TABLE IF NOT EXISTS psp_kad_records (
  routing_key TEXT NOT NULL,
  owner_node_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (routing_key, owner_node_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_kad_records_lookup
  ON psp_kad_records (routing_key, expires_at_ms, sequence DESC);

CREATE INDEX IF NOT EXISTS idx_kad_records_expires
  ON psp_kad_records (expires_at_ms);
