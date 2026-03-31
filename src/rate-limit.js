// src/rate-limit.js — Per-socket sliding-window rate limiter.
// Cloudflare Workers have no shared memory between isolates, so this
// enforces per-connection limits only within the current request context.

import { CONFIG } from './config.js';

/**
 * Create a new rate limiter state object for a single WebSocket connection.
 * Call `check()` for every inbound message; returns true if the message
 * should be processed, false if it should be rejected.
 *
 * @returns {{ check: () => boolean, reset: () => void }}
 */
export function createRateLimiter() {
  // Ring buffer of message timestamps within the current window.
  let timestamps = [];

  return {
    /**
     * Returns true if the message is within the allowed rate.
     * Returns false if the rate limit has been exceeded.
     */
    check() {
      const cutoff = Date.now() - CONFIG.RATE_LIMIT_WINDOW_MS;
      // Drop timestamps that have fallen outside the window.
      timestamps = timestamps.filter((t) => t > cutoff);
      if (timestamps.length >= CONFIG.RATE_LIMIT_MAX_MESSAGES) {
        return false;
      }
      timestamps.push(Date.now());
      return true;
    },

    /** Reset state, e.g. after re-registration. */
    reset() {
      timestamps = [];
    },
  };
}
