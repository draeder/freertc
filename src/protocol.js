// src/protocol.js — PSP v1.0 message type constants and outbound builders.

export const PSP_VERSION = '1.0';
export const SERVER_ID   = 'server';

// ── Inbound message types (client → Worker) ───────────────────────────────────
export const MSG = {
  ANNOUNCE:      'announce',
  WITHDRAW:      'withdraw',
  DISCOVER:      'discover',
  PING:          'ping',
  // Peer-to-peer signaling (server routes from .from → .to)
  OFFER:         'offer',
  ANSWER:        'answer',
  ICE_CANDIDATE: 'ice_candidate',
  ICE_END:       'ice_end',
  BYE:           'bye',
  RENEGOTIATE:   'renegotiate',
};

// Set of message types that the server routes peer-to-peer
export const RELAY_TYPES = new Set([
  MSG.OFFER, MSG.ANSWER, MSG.ICE_CANDIDATE, MSG.ICE_END, MSG.BYE, MSG.RENEGOTIATE,
]);

// ── PSP envelope builder ──────────────────────────────────────────────────────

function newMsgId() {
  const bytes = new Uint8Array(8);
  (globalThis.crypto ?? globalThis.webcrypto).getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function buildPsp(type, network, body, opts = {}) {
  return JSON.stringify({
    psp_version: PSP_VERSION,
    type,
    network: network ?? '',
    from:       SERVER_ID,
    to:         opts.to         ?? null,
    session_id: opts.session_id ?? null,
    message_id: newMsgId(),
    timestamp:  Date.now(),
    reply_to:   opts.reply_to  ?? null,
    ttl_ms:     opts.ttl_ms    ?? null,
    body:       body ?? {},
  });
}

// ── Outbound message builders ─────────────────────────────────────────────────

export function buildAck(network, refMessageId, toId) {
  return buildPsp('ack', network,
    { ref_message_id: refMessageId, status: 'ok' },
    { to: toId, reply_to: refMessageId },
  );
}

export function buildPeerList(network, peers, toId) {
  return buildPsp('peer_list', network, { peers }, { to: toId });
}

export function buildPong(network, nonce, refMessageId, toId) {
  return buildPsp('pong', network, { nonce }, { to: toId, reply_to: refMessageId });
}

export function buildError(network, code, reason, fatal, toId, refMessageId) {
  return buildPsp('error', network ?? '', {
    code,
    reason,
    fatal: fatal ?? false,
  }, {
    to:       toId         ?? null,
    reply_to: refMessageId ?? null,
  });
}
