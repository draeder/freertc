// src/log.js — Structured logging helpers.
// Uses console.log/warn/error which Cloudflare Workers forwards to `wrangler tail`.
// Never logs raw SDP, full relay payloads, or oversized blobs.

/**
 * Build a log record and emit it via console.
 * @param {'info'|'warn'|'error'} level
 * @param {string} event - Short event name, e.g. 'ws.register'.
 * @param {object} [ctx] - Safe context fields (peerId, networkId, code, etc.)
 */
function emit(level, event, ctx = {}) {
  const record = {
    ts: new Date().toISOString(),
    level,
    event,
    ...sanitize(ctx),
  };
  // eslint-disable-next-line no-console
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](
    JSON.stringify(record)
  );
}

/**
 * Strip any field whose key suggests it might contain sensitive or oversized data.
 * This is a lightweight guard — callers should not pass raw payloads anyway.
 */
function sanitize(ctx) {
  const safe = {};
  const blocklist = ['sdp', 'payload', 'token', 'auth', 'secret', 'password'];
  for (const [k, v] of Object.entries(ctx)) {
    if (blocklist.some((b) => k.toLowerCase().includes(b))) {
      safe[k] = '[redacted]';
    } else if (typeof v === 'string' && v.length > 200) {
      safe[k] = v.slice(0, 200) + '…';
    } else {
      safe[k] = v;
    }
  }
  return safe;
}

export const log = {
  info:  (event, ctx) => emit('info',  event, ctx),
  warn:  (event, ctx) => emit('warn',  event, ctx),
  error: (event, ctx) => emit('error', event, ctx),
};
