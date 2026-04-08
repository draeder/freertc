// src/config.js — Tunable constants for the peer.ooo Worker.
// Adjust these values to tune abuse resistance, discovery bounds,
// and advisory KV behavior. These are deliberately conservative defaults.

export const CONFIG = {
  // ── Peer ID constraints ────────────────────────────────────────────────────
  // peerId must be a lowercase hex string within these byte-length bounds.
  // 16 hex chars = 8 bytes (64-bit), 128 hex chars = 64 bytes (512-bit).
  PEER_ID_MIN_HEX: 16,
  PEER_ID_MAX_HEX: 128,

  // ── Network ID constraints ─────────────────────────────────────────────────
  // networkId is a human-readable safe identifier (alphanumeric + hyphens).
  NETWORK_ID_MIN_LEN: 1,
  NETWORK_ID_MAX_LEN: 64,

  // ── Registration timeout ───────────────────────────────────────────────────
  // If a peer does not send a valid `register` message within this many
  // milliseconds of connecting, the socket is closed.
  REGISTER_TIMEOUT_MS: 10_000,

  // ── Message limits ─────────────────────────────────────────────────────────
  // Maximum raw WebSocket message size in bytes. Reject and close on violation.
  MAX_MESSAGE_BYTES: 16_384, // 16 KiB — enough for ICE candidates + small SDP

  // ── Rate limiting ──────────────────────────────────────────────────────────
  // Max messages per socket in a rolling window.
  RATE_LIMIT_WINDOW_MS: 10_000,
  RATE_LIMIT_MAX_MESSAGES: 120,

  // ── Bootstrap discovery ────────────────────────────────────────────────────
  // Maximum number of candidates returned in a bootstrap response.
  BOOTSTRAP_MAX_CANDIDATES: 20,
  // Advisory freshness cutoff — entries older than this are filtered out.
  // Peers should still expect stale data and verify candidates themselves.
  BOOTSTRAP_STALE_MS: 5 * 60_000, // 5 minutes
  // Active freshness cutoff used for auto-discovery.
  // Peers refresh advertisements periodically; older entries are ignored.
  BOOTSTRAP_ACTIVE_MS: 5 * 60_000, // 5 minutes — matches BOOTSTRAP_STALE_MS

  // ── KV TTL ────────────────────────────────────────────────────────────────
  // Advisory TTL for peer advertisement records in KV (in seconds).
  // This is a soft hint to KV; the Worker also does freshness filtering.
  KV_PEER_TTL_SECONDS: 600, // 10 minutes

  // ── Metadata limits ───────────────────────────────────────────────────────
  // Max number of keys allowed in capabilities/metadata objects.
  MAX_CAPABILITIES_KEYS: 8,
  // Max byte length of any single capability value.
  MAX_CAPABILITY_VALUE_LEN: 128,

  // ── Optional auth ─────────────────────────────────────────────────────────
  // Set AUTH_REQUIRED to true to require a bearer token in register messages.
  // AUTH_SECRET is the shared secret used to verify tokens (HMAC-SHA-256).
  // In production, set this via a Worker secret: wrangler secret put AUTH_SECRET
  AUTH_REQUIRED: false,

  // ── Idle keepalive ────────────────────────────────────────────────────────
  // If a socket has not sent any message in this many ms, close it.
  // 0 = disabled. Cloudflare also enforces its own WebSocket timeouts.
  IDLE_TIMEOUT_MS: 120_000, // 2 minutes
};
