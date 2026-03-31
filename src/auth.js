// src/auth.js — Optional authentication hook for peer registration.
//
// By default this is a no-op (all anonymous peers are allowed).
// Enable it by setting AUTH_REQUIRED = true in src/config.js and
// adding an AUTH_SECRET Worker secret: `wrangler secret put AUTH_SECRET`.
//
// What this does:
//   - Checks for an optional `auth.token` field in the register message.
//   - If AUTH_REQUIRED is true, verifies the token as an HMAC-SHA-256 bearer.
//   - If AUTH_REQUIRED is false, accepts any peer regardless of token presence.
//
// What this does NOT protect:
//   - It does not prevent Sybil attacks on the overlay (the mesh must handle that).
//   - It does not prevent a valid token holder from impersonating another peerId.
//   - It is a coarse admission control, not end-to-end identity proof.
//
// For production overlay-layer auth, implement HMAC/JWT on the peer ID itself
// and verify it in the mesh, not only at the signaling edge.

import { CONFIG } from './config.js';

/**
 * Verify an optional auth object from a register message.
 *
 * @param {unknown} auth - The `auth` field from the register message.
 * @param {object} env  - Worker environment (may contain AUTH_SECRET binding).
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function verifyAuth(auth, env) {
  if (!CONFIG.AUTH_REQUIRED) {
    // Auth is disabled — all peers are accepted.
    return { ok: true };
  }

  if (!auth || typeof auth !== 'object') {
    return { ok: false, reason: 'auth object required' };
  }

  const token = auth.token;
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: 'auth.token is required when auth is enabled' };
  }

  const secret = env?.AUTH_SECRET;
  if (!secret) {
    // Server is misconfigured — fail closed.
    return { ok: false, reason: 'server auth is misconfigured' };
  }

  try {
    const verified = await verifyHmacBearer(token, secret);
    if (!verified) {
      return { ok: false, reason: 'invalid auth token' };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'auth verification failed' };
  }
}

/**
 * Verify a simple HMAC-SHA-256 bearer token.
 * Token format: base64url(payload) + '.' + base64url(HMAC-SHA-256(payload, secret))
 *
 * This is a minimal stub. Replace with JWT or your overlay's auth scheme.
 *
 * @param {string} token
 * @param {string} secret
 * @returns {Promise<boolean>}
 */
async function verifyHmacBearer(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 2) return false;

  const [payloadB64, sigB64] = parts;
  const enc = new TextEncoder();

  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const sig = base64urlDecode(sigB64);
  const data = enc.encode(payloadB64);

  return crypto.subtle.verify('HMAC', key, sig, data);
}

function base64urlDecode(str) {
  // Pad to multiple of 4, replace URL-safe chars.
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return Uint8Array.from(atob(padded + pad), (c) => c.charCodeAt(0));
}
