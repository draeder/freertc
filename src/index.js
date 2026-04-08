// src/index.js — Main Cloudflare Worker entry point.
//
// Architecture overview:
//   - HTTP GET /        → health check
//   - HTTP GET /ws      → WebSocket upgrade
//   - HTTP GET /debug   → non-authoritative stats (isolate-local only)
//   - All WebSocket traffic is handled in handleWebSocket()
//
// IMPORTANT: Without Durable Objects, this Worker has NO shared memory
// between isolates. `peers` is local to this isolate only. Relay attempts
// same-isolate delivery only; if the target is absent a NOT_CONNECTED error
// is returned. KV provides advisory bootstrap data across instances
// (eventually consistent). The peer mesh — not this Worker — owns real
// topology and state.

import { CONFIG } from './config.js';
import { log } from './log.js';
import {
  ERROR_CODES,
} from './errors.js';
import {
  MSG,
  RELAY_TYPES,
  buildAck,
  buildPeerList,
  buildPong,
  buildError,
} from './protocol.js';
import {
  validatePspEnvelope,
  validateAnnounceMessage,
  validateSignalingMessage,
} from './validation.js';
import { createRateLimiter } from './rate-limit.js';
import {
  warmupKv,
  createKv,
  getKvAsync,
  getKvDiagnostics,
  writePeerAdvertisement,
  expirePeerAdvertisement,
  getBootstrapCandidates,
  enqueueRelayMessage,
  dequeueRelayMessages,
} from './kv.js';
import { tryParseJSON } from './util.js';
import { verifyAuth } from './auth.js';

// ── Isolate-local peer registry ───────────────────────────────────────────────
// Map<peerId, { socket, networkId, capabilities, regionHint, registeredAt }>
// This is best-effort only. It is NOT a global registry.
const peers = new Map();

// ── Main fetch handler ────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    // Start MongoDB connection eagerly so it's ready by the time register arrives.
    warmupKv(env);

    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(
        JSON.stringify({ status: 'ok', service: 'webrtc signaling edge', ts: Date.now() }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Non-authoritative debug endpoint — isolate-local stats only
    if (url.pathname === '/debug' && request.method === 'GET') {
      return new Response(
        JSON.stringify({
          note: 'Isolate-local stats only. Not global. Not authoritative.',
          isolatePeerCount: peers.size,
          mongo: getKvDiagnostics(),
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
      server.send(buildError('', ERROR_CODES.REGISTER_TIMEOUT, 'Registration timeout', true));
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
      server.send(buildError(ctx.networkId, ERROR_CODES.MESSAGE_TOO_LARGE, 'Message exceeds size limit', true, ctx.peerId));
      server.close(4007, 'message_too_large');
      return;
    }

    // ── Rate limit ────────────────────────────────────────────────────────────
    if (!ctx.rateLimiter.check()) {
      log.warn('ws.rate_limit', { peerId: ctx.peerId });
      server.send(buildError(ctx.networkId, ERROR_CODES.RATE_LIMIT_EXCEEDED, 'Rate limit exceeded', true, ctx.peerId));
      server.close(4029, 'rate_limit_exceeded');
      return;
    }

    // ── Parse JSON ────────────────────────────────────────────────────────────
    const [msg, parseErr] = tryParseJSON(typeof raw === 'string' ? raw : '');
    if (parseErr || typeof msg !== 'object' || msg === null) {
      server.send(buildError('', ERROR_CODES.INVALID_JSON, 'Could not parse message as JSON', false, null));
      return;
    }

    // ── PSP envelope check ────────────────────────────────────────────────────
    const envResult = validatePspEnvelope(msg);
    if (!envResult.ok) {
      server.send(buildError('', ERROR_CODES.INVALID_MESSAGE, envResult.error.reason, false, null));
      return;
    }

    // ── Dispatch ──────────────────────────────────────────────────────────────
    try {
      await dispatch(msg, ctx, server, env, request);
    } catch (err) {
      log.error('ws.dispatch_error', { type: msg.type, err: String(err) });
      server.send(buildError(ctx.networkId, ERROR_CODES.INTERNAL_ERROR, 'Internal server error', false, ctx.peerId, msg.message_id));
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
  const kv = createKv(env);

  // ── Helper: PSP error to this socket ────────────────────────────────────────
  function err(code, reason, fatal = false) {
    return server.send(buildError(ctx.networkId, code, reason, fatal, ctx.peerId, msg.message_id));
  }

  switch (msg.type) {

    // ── announce ──────────────────────────────────────────────────────────────
    case MSG.ANNOUNCE: {
      const validated = validateAnnounceMessage(msg);
      if (!validated.ok) {
        server.send(buildError('', validated.error.code, validated.error.reason, false, null, msg.message_id));
        return;
      }

      const { peerId, networkId, capabilities, hints } = validated;

      // Re-announce / heartbeat from an already-registered peer.
      if (ctx.registered) {
        if (ctx.peerId !== peerId || ctx.networkId !== networkId) {
          err(ERROR_CODES.DUPLICATE_REGISTER, 'Cannot change identity on an established connection');
          return;
        }
        // Update capabilities and refresh KV advertisement.
        const entry = peers.get(ctx.peerId);
        if (entry) {
          entry.capabilities = capabilities;
          entry.hints = hints;
        }
        getKvAsync(env).then((readyKv) => {
          if (readyKv) writePeerAdvertisement(readyKv, networkId, peerId, capabilities, entry?.regionHint ?? null).catch(() => {});
        }).catch(() => {});
        server.send(buildAck(networkId, msg.message_id, peerId));
        log.info('ws.reannounce', { peerId, networkId });
        return;
      }

      // Optional auth hook.
      const authResult = await verifyAuth(validated.auth, env);
      if (!authResult.ok) {
        err(ERROR_CODES.UNAUTHORIZED, authResult.reason, true);
        server.close(4001, 'unauthorized');
        return;
      }

      ctx.peerId    = peerId;
      ctx.networkId = networkId;
      ctx.registered = true;

      peers.set(peerId, {
        socket:       server,
        networkId,
        capabilities: capabilities ?? {},
        hints:        hints ?? null,
        regionHint:   null,
        registeredAt: Date.now(),
      });

      // ── Push same-isolate peers to newcomer & notify them of newcomer ─────
      const localCandidates = [];
      for (const [existingId, existingEntry] of peers.entries()) {
        if (existingId === peerId) continue;
        if (existingEntry.networkId !== networkId) continue;
        localCandidates.push({
          peer_id:   existingId,
          network:   networkId,
          roles:     [],
          last_seen: existingEntry.registeredAt ?? Date.now(),
          hints:     existingEntry.hints ?? {},
        });
        // Notify the existing peer about the newcomer.
        try {
          existingEntry.socket.send(buildPeerList(networkId, [{
            peer_id:   peerId,
            network:   networkId,
            roles:     [],
            last_seen: Date.now(),
            hints:     hints ?? {},
          }], existingId));
        } catch { /* socket may have closed */ }
      }

      // Write advisory advertisement to MongoDB.
      getKvAsync(env).then((readyKv) => {
        if (readyKv && peers.has(peerId)) {
          writePeerAdvertisement(readyKv, networkId, peerId, capabilities, null).catch(() => {});
        }
      }).catch(() => {});

      log.info('ws.registered', { peerId, networkId });
      server.send(buildAck(networkId, msg.message_id, peerId));

      if (localCandidates.length > 0) {
        server.send(buildPeerList(networkId, localCandidates, peerId));
      }

      // Cross-isolate peers from MongoDB.
      getKvAsync(env).then((readyKv) => {
        if (!readyKv) return;
        return getBootstrapCandidates(readyKv, networkId, peerId).then((crossCandidates) => {
          if (crossCandidates.length > 0) {
            const pspPeers = crossCandidates.map((c) => ({
              peer_id:   c.peerId,
              network:   networkId,
              roles:     [],
              last_seen: c.advertisedAt ?? Date.now(),
              hints:     c.capabilities ?? {},
            }));
            try { server.send(buildPeerList(networkId, pspPeers, peerId)); } catch {}
          }
        });
      }).catch(() => {});
      return;
    }

    // ── discover ──────────────────────────────────────────────────────────────
    case MSG.DISCOVER: {
      if (!ctx.registered) {
        err(ERROR_CODES.NOT_REGISTERED, 'Must announce before discovering peers');
        return;
      }

      let targetNet = ctx.networkId;
      if (msg.network !== undefined && msg.network !== ctx.networkId) {
        err(ERROR_CODES.NETWORK_MISMATCH, 'network does not match your registered network');
        return;
      }

      const excludePeerIds = new Set([ctx.peerId]);
      if (Array.isArray(msg.body?.exclude_peers)) {
        msg.body.exclude_peers.forEach((id) => excludePeerIds.add(id));
      }
      const limit = typeof msg.body?.limit === 'number' ? msg.body.limit : undefined;

      let candidates = [];
      const readyKv = await getKvAsync(env);
      if (readyKv) {
        candidates = await getBootstrapCandidates(readyKv, targetNet, ctx.peerId, limit, excludePeerIds);
      }

      const pspPeers = candidates.map((c) => ({
        peer_id:   c.peerId,
        network:   targetNet,
        roles:     [],
        last_seen: c.advertisedAt ?? Date.now(),
        hints:     c.capabilities ?? {},
      }));

      log.info('ws.discover', { peerId: ctx.peerId, count: pspPeers.length });
      server.send(buildPeerList(targetNet, pspPeers, ctx.peerId));
      return;
    }

    // ── signaling relay (offer / answer / ice_candidate / ice_end / bye / renegotiate) ──
    default: {
      if (RELAY_TYPES.has(msg.type)) {
        if (!ctx.registered) {
          err(ERROR_CODES.NOT_REGISTERED, 'Must announce before sending signaling messages');
          return;
        }

        const sigV = validateSignalingMessage(msg, ctx.peerId);
        if (!sigV.ok) {
          server.send(buildError(ctx.networkId, sigV.error.code, sigV.error.reason, false, ctx.peerId, msg.message_id));
          return;
        }

        const { toPeerId } = sigV;

        // Verify target is in the same network.
        const target = peers.get(toPeerId);

        if (!target) {
          // Enqueue for cross-isolate delivery (picked up on target's next ping).
          getKvAsync(env).then(async (readyKv) => {
            if (!readyKv) return;
            await enqueueRelayMessage(readyKv, toPeerId, ctx.networkId, msg);
          }).catch(() => {});
          return;
        }

        if (target.networkId !== ctx.networkId) {
          err(ERROR_CODES.NETWORK_MISMATCH, 'Target peer is in a different network');
          return;
        }

        // Forward the PSP message verbatim.
        try {
          target.socket.send(JSON.stringify(msg));
        } catch (sendErr) {
          log.warn('ws.relay_send_failed', { from: ctx.peerId, to: toPeerId, err: String(sendErr) });
          err(ERROR_CODES.TARGET_NOT_CONNECTED, 'Relay delivery failed — target may have disconnected');
          peers.delete(toPeerId);
          return;
        }

        log.info('ws.relayed', { from: ctx.peerId, to: toPeerId, type: msg.type });
        return;
      }

      // Unknown non-relay type.
      err(ERROR_CODES.INVALID_MESSAGE, `Unknown PSP message type: ${msg.type}`);
    }

    // ── ping ──────────────────────────────────────────────────────────────────
    case MSG.PING: {
      if (ctx.registered) {
        const entry = peers.get(ctx.peerId);
        getKvAsync(env).then(async (readyKv) => {
          if (!readyKv) return;
          // Refresh advertisement.
          await writePeerAdvertisement(readyKv, ctx.networkId, ctx.peerId, entry?.capabilities ?? {}, entry?.regionHint ?? null);
          // Deliver any queued cross-isolate signaling messages.
          const pending = await dequeueRelayMessages(readyKv, ctx.peerId, ctx.networkId);
          for (const item of pending) {
            try {
              server.send(JSON.stringify(item));
              log.info('ws.relay_delivered', { to: ctx.peerId, from: item.from, type: item.type });
            } catch { /* socket closed */ }
          }
        }).catch(() => {});
      }
      const nonce = msg.body?.nonce ?? null;
      server.send(buildPong(ctx.networkId, nonce, msg.message_id, ctx.peerId));
      return;
    }

    // ── withdraw ──────────────────────────────────────────────────────────────
    case MSG.WITHDRAW: {
      if (!ctx.registered) {
        err(ERROR_CODES.NOT_REGISTERED, 'Not registered');
        return;
      }
      cleanup(ctx, env);
      log.info('ws.withdrawn', { peerId: ctx.peerId, networkId: ctx.networkId });
      server.send(buildAck(ctx.networkId, msg.message_id, ctx.peerId));
      server.close(1000, 'withdrawn');
      return;
    }
  }
}

// ── Cleanup helper ────────────────────────────────────────────────────────────

function cleanup(ctx, env) {
  if (ctx.peerId) {
    peers.delete(ctx.peerId);
    if (ctx.networkId) {
      getKvAsync(env)
        .then((kv) => expirePeerAdvertisement(kv, ctx.networkId, ctx.peerId))
        .catch(() => {});
    }
  }
  ctx.registered = false;
}

