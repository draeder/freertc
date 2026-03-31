// src/validation.js — Strict input validation and normalization.
// All external input must pass through these functions before use.

import { CONFIG } from './config.js';
import { ERROR_CODES, makeError } from './errors.js';

// Allowed characters in networkId: lowercase alphanumeric and hyphens.
const NETWORK_ID_RE = /^[a-z0-9][a-z0-9\-]*[a-z0-9]$|^[a-z0-9]$/;
// peerId must be hex digits only.
const PEER_ID_HEX_RE = /^[0-9a-f]+$/;

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
 * Validate the relay message fields.
 * @param {object} msg - Already-parsed message object.
 * @returns {{ ok: boolean, error?: object }}
 */
const VALID_RELAY_TYPES = new Set([
  'offer', 'answer', 'candidate', 'renegotiate', 'bye',
]);

export function validateRelayMessage(msg) {
  if (!msg.toPeerId) {
    return fail(ERROR_CODES.MISSING_FIELD, 'relay requires toPeerId');
  }
  const toPeer = validatePeerId(msg.toPeerId);
  if (!toPeer.ok) return toPeer;

  if (!msg.relayType || !VALID_RELAY_TYPES.has(msg.relayType)) {
    return fail(
      ERROR_CODES.INVALID_RELAY_TYPE,
      `relayType must be one of: ${[...VALID_RELAY_TYPES].join(', ')}`
    );
  }
  if (!msg.messageId || typeof msg.messageId !== 'string' || msg.messageId.length > 64) {
    return fail(ERROR_CODES.MISSING_FIELD, 'relay requires a messageId string (max 64 chars)');
  }
  if (!msg.timestamp || typeof msg.timestamp !== 'number') {
    return fail(ERROR_CODES.MISSING_FIELD, 'relay requires a numeric timestamp');
  }
  // payload is required for offer/answer/candidate; optional for bye
  if (msg.relayType !== 'bye' && msg.payload === undefined) {
    return fail(ERROR_CODES.MISSING_FIELD, `relayType "${msg.relayType}" requires a payload`);
  }
  return { ok: true, toPeerId: toPeer.value };
}

/**
 * Validate a `register` message.
 * @param {object} msg
 * @returns {{ ok: boolean, peerId?: string, networkId?: string, error?: object }}
 */
export function validateRegisterMessage(msg) {
  if (!msg.peerId) return fail(ERROR_CODES.MISSING_FIELD, 'register requires peerId');
  if (!msg.networkId) return fail(ERROR_CODES.MISSING_FIELD, 'register requires networkId');
  if (!msg.timestamp || typeof msg.timestamp !== 'number') {
    return fail(ERROR_CODES.MISSING_FIELD, 'register requires a numeric timestamp');
  }

  const peer = validatePeerId(msg.peerId);
  if (!peer.ok) return peer;

  const net = validateNetworkId(msg.networkId);
  if (!net.ok) return net;

  const caps = validateCapabilities(msg.capabilities);
  if (!caps.ok) return caps;

  return {
    ok: true,
    peerId: peer.value,
    networkId: net.value,
    capabilities: caps.value,
    regionHint: typeof msg.regionHint === 'string' ? msg.regionHint.slice(0, 32) : null,
    auth: msg.auth,
  };
}

// ── Internal helper ───────────────────────────────────────────────────────────

function fail(code, message) {
  return { ok: false, error: makeError(code, message) };
}
