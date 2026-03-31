// src/util.js — Miscellaneous utility helpers.

/**
 * Generate a random hex peer ID of `byteLength` bytes using the Web Crypto API.
 * The default is 32 bytes = 64 hex chars.
 * @param {number} [byteLength=32]
 * @returns {string} lowercase hex string
 */
export function generatePeerId(byteLength = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate a short random string suitable for a messageId or shard key.
 * @returns {string}
 */
export function generateId() {
  return generatePeerId(8);
}

/**
 * Return current Unix timestamp in milliseconds.
 * @returns {number}
 */
export function now() {
  return Date.now();
}

/**
 * Clamp a number between min and max (inclusive).
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Safe JSON.parse — returns [value, null] on success, [null, error] on failure.
 * @param {string} text
 * @returns {[any, null] | [null, Error]}
 */
export function tryParseJSON(text) {
  try {
    return [JSON.parse(text), null];
  } catch (e) {
    return [null, e];
  }
}

/**
 * Pick only the allowed keys from an object (safe shallow copy).
 * @param {object} obj
 * @param {string[]} keys
 * @returns {object}
 */
export function pick(obj, keys) {
  const result = {};
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      result[k] = obj[k];
    }
  }
  return result;
}
