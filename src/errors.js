// src/errors.js — PSP v1.0 error codes.

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
  MISSING_FIELD:        'missing_field',
  UNSUPPORTED_VERSION:  'unsupported_version',
  UNKNOWN_SESSION:      'unknown_session',
  EXPIRED_MESSAGE:      'expired_message',
  INVALID_SDP:          'invalid_sdp',
  INVALID_CANDIDATE:    'invalid_candidate',
  IDENTITY_MISMATCH:    'identity_mismatch',
};

/**
 * Build a structured PSP error body object (not serialized).
 * Use buildError() from protocol.js to get the full PSP envelope string.
 */
export function makeError(code, reason) {
  return { code, reason, fatal: false };
}
