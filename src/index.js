// src/index.js — Main Cloudflare Worker entry point.
//
// Architecture overview:
//   - HTTP GET /        → health check
//   - HTTP GET /ws      → WebSocket upgrade
//   - HTTP GET /debug   → non-authoritative stats (isolate-local only)
//   - All WebSocket traffic is handled in handleWebSocket()
//
// IMPORTANT: Without Durable Objects, this Worker has NO shared memory
// between isolates. `peers` is local to this isolate only. Relay only
// succeeds when the target peer is in the SAME isolate instance.
// KV provides advisory bootstrap data across instances (eventually consistent).
// The peer mesh — not this Worker — owns real topology and state.

import { CONFIG } from './config.js';
import { log } from './log.js';
import {
  ERROR_CODES,
  errorPayload,
} from './errors.js';
import {
  MSG,
  buildRegistered,
  buildBootstrapCandidates,
  buildIncomingRelay,
  buildRelayed,
  buildPong,
} from './protocol.js';
import {
  validateRegisterMessage,
  validatePeerId,
  validateNetworkId,
  validateCapabilities,
  validateRelayMessage,
} from './validation.js';
import { createRateLimiter } from './rate-limit.js';
import {
  writePeerAdvertisement,
  expirePeerAdvertisement,
  getBootstrapCandidates,
} from './kv.js';
import { tryParseJSON, generateId } from './util.js';
import { verifyAuth } from './auth.js';

// ── Isolate-local peer registry ───────────────────────────────────────────────
// Map<peerId, { socket, networkId, capabilities, regionHint, registeredAt }>
// This is best-effort only. It is NOT a global registry.
const peers = new Map();

// ── Main fetch handler ────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(
        JSON.stringify({ status: 'ok', service: 'peer.ooo signaling edge', ts: Date.now() }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Non-authoritative debug endpoint — isolate-local stats only
    if (url.pathname === '/debug' && request.method === 'GET') {
      return new Response(
        JSON.stringify({
          note: 'Isolate-local stats only. Not global. Not authoritative.',
          isolatePeerCount: peers.size,
          ts: Date.now(),
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // WebSocket upgrade
    if (url.pathname === '/ws' && request.method === 'GET') {
      const upgrade = request.headers.get('Upgrade');
      if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }
      return handleWebSocket(request, env);
    }

    return new Response('Not found', { status: 404 });
  },
};

// ── WebSocket handler ─────────────────────────────────────────────────────────

async function handleWebSocket(request, env) {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();

  // Connection context — mutable, scoped to this socket's lifetime.
  const ctx = {
    peerId:       null,
    networkId:    null,
    registered:   false,
    rateLimiter:  createRateLimiter(),
    lastActivity: Date.now(),
  };

  // Registration must arrive within REGISTER_TIMEOUT_MS.
  const registerTimer = setTimeout(() => {
    if (!ctx.registered) {
      log.warn('ws.register_timeout', {});
      server.send(errorPayload(ERROR_CODES.REGISTER_TIMEOUT, 'Registration timeout'));
      server.close(4008, 'register_timeout');
    }
  }, CONFIG.REGISTER_TIMEOUT_MS);

  // Idle timeout (if configured).
  let idleTimer = null;
  function resetIdle() {
    ctx.lastActivity = Date.now();
    if (CONFIG.IDLE_TIMEOUT_MS > 0) {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        log.warn('ws.idle_timeout', { peerId: ctx.peerId, networkId: ctx.networkId });
        server.close(4009, 'idle_timeout');
      }, CONFIG.IDLE_TIMEOUT_MS);
    }
  }
  resetIdle();

  server.addEventListener('message', async (event) => {
    resetIdle();

    // ── Size check ────────────────────────────────────────────────────────────
    const raw = event.data;
    const byteLen = typeof raw === 'string'
      ? new TextEncoder().encode(raw).length
      : raw.byteLength ?? 0;

    if (byteLen > CONFIG.MAX_MESSAGE_BYTES) {
      log.warn('ws.message_too_large', { peerId: ctx.peerId, byteLen });
      server.send(errorPayload(ERROR_CODES.MESSAGE_TOO_LARGE, 'Message exceeds size limit'));
      server.close(4007, 'message_too_large');
      return;
    }

    // ── Rate limit ────────────────────────────────────────────────────────────
    if (!ctx.rateLimiter.check()) {
      log.warn('ws.rate_limit', { peerId: ctx.peerId });
      server.send(errorPayload(ERROR_CODES.RATE_LIMIT_EXCEEDED, 'Rate limit exceeded'));
      server.close(4029, 'rate_limit_exceeded');
      return;
    }

    // ── Parse JSON ────────────────────────────────────────────────────────────
    const [msg, parseErr] = tryParseJSON(typeof raw === 'string' ? raw : '');
    if (parseErr || typeof msg !== 'object' || msg === null) {
      server.send(errorPayload(ERROR_CODES.INVALID_JSON, 'Could not parse message as JSON'));
      return;
    }

    if (typeof msg.type !== 'string') {
      server.send(errorPayload(ERROR_CODES.INVALID_MESSAGE, 'Message must have a string "type" field'));
      return;
    }

    // ── Dispatch ──────────────────────────────────────────────────────────────
    try {
      await dispatch(msg, ctx, server, env, request);
    } catch (err) {
      log.error('ws.dispatch_error', { type: msg.type, err: String(err) });
      server.send(errorPayload(ERROR_CODES.INTERNAL_ERROR, 'Internal server error'));
    }
  });

  server.addEventListener('close', () => {
    clearTimeout(registerTimer);
    clearTimeout(idleTimer);
    cleanup(ctx, env);
    log.info('ws.closed', { peerId: ctx.peerId, networkId: ctx.networkId });
  });

  server.addEventListener('error', (err) => {
    clearTimeout(registerTimer);
    clearTimeout(idleTimer);
    cleanup(ctx, env);
    log.error('ws.error', { peerId: ctx.peerId, err: String(err) });
  });

  return new Response(null, { status: 101, webSocket: client });
}

// ── Message dispatcher ────────────────────────────────────────────────────────

async function dispatch(msg, ctx, server, env, request) {
  const kv = env.PEERS;

  switch (msg.type) {

    // ── register ──────────────────────────────────────────────────────────────
    case MSG.REGISTER: {
      if (ctx.registered) {
        server.send(errorPayload(ERROR_CODES.DUPLICATE_REGISTER, 'Already registered on this connection'));
        return;
      }

      const validated = validateRegisterMessage(msg);
      if (!validated.ok) {
        server.send(JSON.stringify(validated.error));
        return;
      }

      // Optional auth hook — noop unless AUTH_REQUIRED is true.
      const authResult = await verifyAuth(validated.auth, env);
      if (!authResult.ok) {
        server.send(errorPayload(ERROR_CODES.UNAUTHORIZED, authResult.reason));
        server.close(4001, 'unauthorized');
        return;
      }

      const { peerId, networkId, capabilities, regionHint } = validated;

      ctx.peerId    = peerId;
      ctx.networkId = networkId;
      ctx.registered = true;

      // Register in isolate-local map (best-effort, not global).
      peers.set(peerId, { socket: server, networkId, capabilities, regionHint, registeredAt: Date.now() });

      // Write advisory advertisement to KV (fire-and-forget).
      if (kv) {
        writePeerAdvertisement(kv, networkId, peerId, capabilities, regionHint).catch(() => {});
      }

      log.info('ws.registered', { peerId, networkId, regionHint });
      server.send(buildRegistered(peerId, networkId));
      return;
    }

    // ── advertise ─────────────────────────────────────────────────────────────
    case MSG.ADVERTISE: {
      if (!ctx.registered) {
        server.send(errorPayload(ERROR_CODES.NOT_REGISTERED, 'Must register before advertising'));
        return;
      }

      const caps = validateCapabilities(msg.capabilities);
      if (!caps.ok) {
        server.send(JSON.stringify(caps.error));
        return;
      }

      // Update isolate-local record.
      const entry = peers.get(ctx.peerId);
      if (entry) entry.capabilities = caps.value;

      // Refresh advisory KV advertisement.
      if (kv) {
        writePeerAdvertisement(kv, ctx.networkId, ctx.peerId, caps.value, entry?.regionHint ?? null)
          .catch(() => {});
      }

      log.info('ws.advertise', { peerId: ctx.peerId, networkId: ctx.networkId });
      server.send(JSON.stringify({ type: 'advertised', ts: Date.now() }));
      return;
    }

    // ── get_bootstrap ─────────────────────────────────────────────────────────
    case MSG.GET_BOOTSTRAP: {
      if (!ctx.registered) {
        server.send(errorPayload(ERROR_CODES.NOT_REGISTERED, 'Must register before requesting bootstrap'));
        return;
      }

      // Allow overriding networkId for cross-network lookup? No — scope to registered network.
      let targetNet = ctx.networkId;
      if (msg.networkId !== undefined) {
        const netV = validateNetworkId(msg.networkId);
        if (!netV.ok) {
          server.send(JSON.stringify(netV.error));
          return;
        }
        // Only allow querying your own registered network.
        if (netV.value !== ctx.networkId) {
          server.send(errorPayload(ERROR_CODES.NETWORK_MISMATCH, 'networkId does not match your registered network'));
          return;
        }
        targetNet = netV.value;
      }

      let candidates = [];
      if (kv) {
        candidates = await getBootstrapCandidates(kv, targetNet, ctx.peerId);
      }

      log.info('ws.bootstrap', { peerId: ctx.peerId, networkId: targetNet, count: candidates.length });
      server.send(buildBootstrapCandidates(targetNet, candidates));
      return;
    }

    // ── relay ─────────────────────────────────────────────────────────────────
    case MSG.RELAY: {
      if (!ctx.registered) {
        server.send(errorPayload(ERROR_CODES.NOT_REGISTERED, 'Must register before relaying'));
        return;
      }

      const relayV = validateRelayMessage(msg);
      if (!relayV.ok) {
        server.send(JSON.stringify(relayV.error));
        return;
      }

      const { toPeerId } = relayV;

      // If fromPeerId is specified in the message, it must match the socket identity.
      if (msg.fromPeerId !== undefined) {
        const fromV = validatePeerId(msg.fromPeerId);
        if (!fromV.ok || fromV.value !== ctx.peerId) {
          server.send(errorPayload(ERROR_CODES.INVALID_PEER_ID, 'fromPeerId does not match your registered identity'));
          return;
        }
      }

      // Check that target is in this isolate's peer map.
      const target = peers.get(toPeerId);

      if (!target) {
        // Target is not in this isolate. This is expected and normal.
        // The caller must use their mesh for fallback routing.
        log.info('ws.relay_miss', { from: ctx.peerId, to: toPeerId, relayType: msg.relayType });
        server.send(errorPayload(
          ERROR_CODES.TARGET_NOT_CONNECTED,
          'Target peer is not connected to this edge node. Try another bootstrap candidate or direct mesh route.',
          { toPeerId, messageId: msg.messageId }
        ));
        return;
      }

      // Verify target is in the same network.
      if (target.networkId !== ctx.networkId) {
        server.send(errorPayload(ERROR_CODES.NETWORK_MISMATCH, 'Target peer is in a different network'));
        return;
      }

      // Deliver the relay message to the target socket.
      try {
        target.socket.send(
          buildIncomingRelay(
            ctx.peerId,
            ctx.networkId,
            msg.relayType,
            msg.payload,
            msg.messageId,
            msg.timestamp
          )
        );
      } catch (err) {
        // Target socket may have closed between lookup and send.
        log.warn('ws.relay_send_failed', { from: ctx.peerId, to: toPeerId, err: String(err) });
        server.send(errorPayload(
          ERROR_CODES.TARGET_NOT_CONNECTED,
          'Relay delivery failed — target may have disconnected',
          { toPeerId, messageId: msg.messageId }
        ));
        peers.delete(toPeerId);
        return;
      }

      log.info('ws.relayed', { from: ctx.peerId, to: toPeerId, relayType: msg.relayType });
      server.send(buildRelayed(toPeerId, msg.messageId));
      return;
    }

    // ── ping ──────────────────────────────────────────────────────────────────
    case MSG.PING: {
      server.send(buildPong(msg.ts ?? Date.now()));
      return;
    }

    // ── unregister ────────────────────────────────────────────────────────────
    case MSG.UNREGISTER: {
      if (!ctx.registered) {
        server.send(errorPayload(ERROR_CODES.NOT_REGISTERED, 'Not registered'));
        return;
      }
      cleanup(ctx, env);
      log.info('ws.unregistered', { peerId: ctx.peerId, networkId: ctx.networkId });
      server.send(JSON.stringify({ type: 'unregistered', ts: Date.now() }));
      server.close(1000, 'unregistered');
      return;
    }

    default:
      server.send(errorPayload(ERROR_CODES.INVALID_MESSAGE, `Unknown message type: ${msg.type}`));
  }
}

// ── Cleanup helper ────────────────────────────────────────────────────────────

function cleanup(ctx, env) {
  if (ctx.peerId) {
    peers.delete(ctx.peerId);
    // Advisory: mark KV record as expiring soon (best-effort, fire-and-forget).
    if (env?.PEERS && ctx.networkId) {
      expirePeerAdvertisement(env.PEERS, ctx.networkId, ctx.peerId).catch(() => {});
    }
  }
  ctx.registered = false;
}
