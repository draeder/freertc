// src/validation.js — PSP v1.0 input validation and normalization.
// All external input must pass through these functions before use.

import { CONFIG } from './config.js';
import { ERROR_CODES, makeError } from './errors.js';
import { PSP_VERSION } from './protocol.js';

// Allowed characters in networkId: lowercase alphanumeric and hyphens.
const NETWORK_ID_RE = /^[a-z0-9][a-z0-9\-]*[a-z0-9]$|^[a-z0-9]$/;
// peerId must be hex digits only.
const PEER_ID_HEX_RE = /^[0-9a-f]+$/;

/**
 * Validate a PSP envelope — required fields present and version matches.
 * Returns { ok: true } or { ok: false, error }.
 * @param {object} msg
 * @returns {{ ok: boolean, error?: object }}
 */
export function validatePspEnvelope(msg) {
  if (msg.psp_version !== PSP_VERSION) {
    return fail(ERROR_CODES.UNSUPPORTED_VERSION,
      `psp_version must be "${PSP_VERSION}"; got "${msg.psp_version}"`);
  }
  if (typeof msg.type !== 'string') {
    return fail(ERROR_CODES.INVALID_MESSAGE, 'PSP envelope missing string "type"');
  }
  if (typeof msg.network !== 'string') {
    return fail(ERROR_CODES.MISSING_FIELD, 'PSP envelope missing string "network"');
  }
  if (typeof msg.from !== 'string') {
    return fail(ERROR_CODES.MISSING_FIELD, 'PSP envelope missing string "from"');
  }
  if (typeof msg.message_id !== 'string' || msg.message_id.length === 0) {
    return fail(ERROR_CODES.MISSING_FIELD, 'PSP envelope missing "message_id"');
  }
  if (typeof msg.timestamp !== 'number') {
    return fail(ERROR_CODES.MISSING_FIELD, 'PSP envelope missing numeric "timestamp"');
  }
  if (typeof msg.body !== 'object' || msg.body === null || Array.isArray(msg.body)) {
    return fail(ERROR_CODES.MISSING_FIELD, 'PSP envelope missing "body" object');
  }
  return { ok: true };
}

/**
 * Validate and normalize a peerId.
 * Returns { ok: true, value } or { ok: false, error }.
 * @param {unknown} raw
 * @returns {{ ok: boolean, value?: string, error?: object }}
 */
export function validatePeerId(raw) {
  if (typeof raw !== 'string') {
    return fail(ERROR_CODES.INVALID_PEER_ID, 'peerId must be a string');
  }
  const v = raw.toLowerCase().trim();
  if (v.length < CONFIG.PEER_ID_MIN_HEX || v.length > CONFIG.PEER_ID_MAX_HEX) {
    return fail(
      ERROR_CODES.INVALID_PEER_ID,
      `peerId must be ${CONFIG.PEER_ID_MIN_HEX}–${CONFIG.PEER_ID_MAX_HEX} hex chars`
    );
  }
  if (!PEER_ID_HEX_RE.test(v)) {
    return fail(ERROR_CODES.INVALID_PEER_ID, 'peerId must be lowercase hex');
  }
  return { ok: true, value: v };
}

/**
 * Validate and normalize a networkId.
 * Returns { ok: true, value } or { ok: false, error }.
 * @param {unknown} raw
 * @returns {{ ok: boolean, value?: string, error?: object }}
 */
export function validateNetworkId(raw) {
  if (typeof raw !== 'string') {
    return fail(ERROR_CODES.INVALID_NETWORK_ID, 'networkId must be a string');
  }
  const v = raw.toLowerCase().trim();
  if (
    v.length < CONFIG.NETWORK_ID_MIN_LEN ||
    v.length > CONFIG.NETWORK_ID_MAX_LEN
  ) {
    return fail(
      ERROR_CODES.INVALID_NETWORK_ID,
      `networkId must be ${CONFIG.NETWORK_ID_MIN_LEN}–${CONFIG.NETWORK_ID_MAX_LEN} chars`
    );
  }
  if (!NETWORK_ID_RE.test(v)) {
    return fail(
      ERROR_CODES.INVALID_NETWORK_ID,
      'networkId must be lowercase alphanumeric with optional internal hyphens'
    );
  }
  return { ok: true, value: v };
}

/**
 * Validate and normalize capabilities/metadata object.
 * Accepts undefined (no caps) or a plain object with bounded keys/values.
 * @param {unknown} raw
 * @returns {{ ok: boolean, value?: object, error?: object }}
 */
export function validateCapabilities(raw) {
  if (raw === undefined || raw === null) {
    return { ok: true, value: null };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return fail(ERROR_CODES.INVALID_MESSAGE, 'capabilities must be a plain object');
  }
  const keys = Object.keys(raw);
  if (keys.length > CONFIG.MAX_CAPABILITIES_KEYS) {
    return fail(
      ERROR_CODES.INVALID_MESSAGE,
      `capabilities may have at most ${CONFIG.MAX_CAPABILITIES_KEYS} keys`
    );
  }
  const safe = {};
  for (const k of keys) {
    if (typeof k !== 'string' || k.length > 64) {
      return fail(ERROR_CODES.INVALID_MESSAGE, 'capability key too long or not a string');
    }
    const val = raw[k];
    if (
      typeof val !== 'string' &&
      typeof val !== 'number' &&
      typeof val !== 'boolean'
    ) {
      return fail(ERROR_CODES.INVALID_MESSAGE, `capability value for "${k}" must be a scalar`);
    }
    if (typeof val === 'string' && val.length > CONFIG.MAX_CAPABILITY_VALUE_LEN) {
      return fail(
        ERROR_CODES.INVALID_MESSAGE,
        `capability value for "${k}" exceeds ${CONFIG.MAX_CAPABILITY_VALUE_LEN} chars`
      );
    }
    safe[k] = val;
  }
  return { ok: true, value: safe };
}

/**
 * Validate a PSP `announce` message (registration / heartbeat).
 * Reads identity from PSP envelope fields.
 * @param {object} msg - Full PSP envelope.
 * @returns {{ ok: boolean, peerId?: string, networkId?: string, capabilities?: object, error?: object }}
 */
export function validateAnnounceMessage(msg) {
  const peer = validatePeerId(msg.from);
  if (!peer.ok) return peer;

  const net = validateNetworkId(msg.network);
  if (!net.ok) return net;

  const caps = validateCapabilities(msg.body?.capabilities);
  if (!caps.ok) return caps;

  return {
    ok: true,
    peerId:       peer.value,
    networkId:    net.value,
    capabilities: caps.value,
    instanceId:   typeof msg.body?.instance_id === 'string' ? msg.body.instance_id.slice(0, 64) : null,
    hints:        typeof msg.body?.hints === 'object' && msg.body.hints !== null ? msg.body.hints : null,
    auth:         msg.body?.auth,
  };
}

/**
 * Validate a PSP signaling relay message (offer/answer/ice_candidate/ice_end/bye/renegotiate).
 * Checks that `to` and `session_id` are present and that `from` matches the socket identity.
 * @param {object} msg - Full PSP envelope.
 * @param {string} ctxPeerId - The registered peerId for this socket.
 * @returns {{ ok: boolean, toPeerId?: string, error?: object }}
 */
export function validateSignalingMessage(msg, ctxPeerId) {
  // `from` must match the registered identity.
  const fromV = validatePeerId(msg.from);
  if (!fromV.ok) return fromV;
  if (fromV.value !== ctxPeerId) {
    return fail(ERROR_CODES.IDENTITY_MISMATCH, '"from" does not match your registered peerId');
  }

  if (!msg.to || typeof msg.to !== 'string') {
    return fail(ERROR_CODES.MISSING_FIELD, 'signaling message requires a "to" field');
  }
  const toV = validatePeerId(msg.to);
  if (!toV.ok) return toV;

  if (!msg.session_id || typeof msg.session_id !== 'string') {
    return fail(ERROR_CODES.MISSING_FIELD, 'signaling message requires a "session_id" field');
  }

  return { ok: true, toPeerId: toV.value };
}

// ── Internal helper ───────────────────────────────────────────────────────────

function fail(code, reason) {
  return { ok: false, error: makeError(code, reason) };
}
