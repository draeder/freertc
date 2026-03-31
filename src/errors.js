// src/errors.js — Centralized structured error codes and factory helpers.
// All errors sent to clients follow the { type: 'error', code, message } shape.

export const ERROR_CODES = {
  INVALID_JSON:         'invalid_json',
  INVALID_MESSAGE:      'invalid_message',
  INVALID_PEER_ID:      'invalid_peer_id',
  INVALID_NETWORK_ID:   'invalid_network_id',
  NOT_REGISTERED:       'not_registered',
  REGISTER_TIMEOUT:     'register_timeout',
  DUPLICATE_REGISTER:   'duplicate_register',
  NETWORK_MISMATCH:     'network_mismatch',
  TARGET_NOT_CONNECTED: 'target_not_connected',
  RATE_LIMIT_EXCEEDED:  'rate_limit_exceeded',
  MESSAGE_TOO_LARGE:    'message_too_large',
  UNAUTHORIZED:         'unauthorized',
  INTERNAL_ERROR:       'internal_error',
  INVALID_RELAY_TYPE:   'invalid_relay_type',
  MISSING_FIELD:        'missing_field',
};

/**
 * Build a structured error payload to send to a client.
 * @param {string} code - One of ERROR_CODES values.
 * @param {string} message - Human-readable detail.
 * @param {object} [extra] - Optional additional fields to merge in.
 * @returns {object}
 */
export function makeError(code, message, extra = {}) {
  return {
    type: 'error',
    code,
    message,
    ts: Date.now(),
    ...extra,
  };
}

/**
 * Serialize a structured error to a JSON string for WebSocket send.
 * @param {string} code
 * @param {string} message
 * @param {object} [extra]
 * @returns {string}
 */
export function errorPayload(code, message, extra = {}) {
  return JSON.stringify(makeError(code, message, extra));
}
