// src/protocol.js — Message type constants and outbound message builders.
// Centralizes the wire protocol so changes propagate everywhere.

// ── Inbound message types (client → Worker) ───────────────────────────────────
export const MSG = {
  REGISTER:      'register',
  ADVERTISE:     'advertise',
  GET_BOOTSTRAP: 'get_bootstrap',
  RELAY:         'relay',
  PING:          'ping',
  UNREGISTER:    'unregister',
};

// ── Outbound message types (Worker → client) ──────────────────────────────────
export const OUT = {
  REGISTERED:          'registered',
  BOOTSTRAP_CANDIDATES: 'bootstrap_candidates',
  INCOMING_RELAY:      'incoming_relay',
  RELAYED:             'relayed',
  PONG:                'pong',
  ERROR:               'error',
};

// ── Outbound message builders ─────────────────────────────────────────────────

export function buildRegistered(peerId, networkId, extra = {}) {
  return JSON.stringify({
    type: OUT.REGISTERED,
    peerId,
    networkId,
    ts: Date.now(),
    ...extra,
  });
}

export function buildBootstrapCandidates(networkId, candidates) {
  return JSON.stringify({
    type: OUT.BOOTSTRAP_CANDIDATES,
    networkId,
    // Candidates are advisory and may be stale. Peers must verify liveness.
    candidates,
    ts: Date.now(),
  });
}

export function buildIncomingRelay(fromPeerId, networkId, relayType, payload, messageId, timestamp) {
  return JSON.stringify({
    type: OUT.INCOMING_RELAY,
    fromPeerId,
    networkId,
    relayType,
    // Only include payload if present (bye messages may omit it)
    ...(payload !== undefined ? { payload } : {}),
    messageId,
    originalTimestamp: timestamp,
    ts: Date.now(),
  });
}

export function buildRelayed(toPeerId, messageId) {
  return JSON.stringify({
    type: OUT.RELAYED,
    toPeerId,
    messageId,
    ts: Date.now(),
  });
}

export function buildPong(ts) {
  return JSON.stringify({
    type: OUT.PONG,
    ts,
    serverTs: Date.now(),
  });
}
