const PSP_VERSION = "1.0";

const DISCOVERY_TYPES = new Set(["announce", "withdraw", "discover", "peer_list", "redirect"]);
const NEGOTIATION_TYPES = new Set(["connect_request", "connect_accept", "connect_reject", "offer", "answer", "ice_candidate", "ice_end", "renegotiate"]);
const CONTROL_TYPES = new Set(["ping", "pong", "bye", "error", "ack"]);
const EXTENSION_TYPES = new Set(["ext"]);

const MESSAGE_TYPES = new Set([
  ...DISCOVERY_TYPES, ...NEGOTIATION_TYPES, ...CONTROL_TYPES, ...EXTENSION_TYPES
]);

const RELAY_TYPES = new Set([
  "connect_request", "connect_accept", "connect_reject",
  "offer", "answer", "ice_candidate", "ice_end", "renegotiate",
  "bye", "error", "ack", "ext", "peer_list", "redirect"
]);

const DEFAULT_TTL_MS = 30_000;
const MAX_TTL_MS = 120_000;
const MAX_MESSAGE_SIZE = 64 * 1024;
const MAX_BATCH = 50;

const livePeers = new Map(); // key: "network:peerId" -> { peerId, network, socket, lastSeen }
const networkSubscribers = new Map(); // key: network -> Set of sockets

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const upgrade = request.headers.get("Upgrade");

    if (upgrade && upgrade.toLowerCase() === "websocket") {
      if (url.pathname !== "/ws") {
        return jsonResponse({ ok: false, error: "WebSocket endpoint is /ws" }, 404);
      }
      return handleWebSocket(request, env, ctx);
    }

    if (url.pathname === "/ws") {
      return jsonResponse({ ok: false, error: "Expected WebSocket upgrade on /ws" }, 426);
    }

    if (url.pathname === "/health") {
      return jsonResponse({ ok: true, version: PSP_VERSION, peers: livePeers.size }, 200);
    }

    return env.ASSETS?.fetch(request) ?? new Response("Not Found", { status: 404 });
  }
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

// Broadcast peer list to all connected peers in a network
async function broadcastPeerList(db, network) {
  const sockets = networkSubscribers.get(network);
  if (!sockets || sockets.size === 0) return;

  const now = Date.now();
  const result = await db.prepare(`
    SELECT peer_id, session_id, updated_at_ms
    FROM psp_announcements
    WHERE network = ?1 AND expires_at_ms > ?2
    ORDER BY peer_id ASC
    LIMIT ?3
  `).bind(network, now, MAX_BATCH).all();

  const peers = (result.results || []).map(row => ({
    peer_id: row.peer_id,
    session_id: row.session_id,
    timestamp: row.updated_at_ms
  }));

  const message = {
    psp_version: PSP_VERSION,
    type: "peer_list",
    network,
    from: "bootstrap-relay",
    to: null,
    message_id: crypto.randomUUID(),
    timestamp: Date.now(),
    ttl_ms: DEFAULT_TTL_MS,
    body: { peers }
  };

  const payload = JSON.stringify(message);
  for (const socket of sockets) {
    try {
      socket.send(payload);
    } catch (e) {
      sockets.delete(socket);
    }
  }
}

// ===================== D1 Database Functions =====================

async function upsertAnnouncement(db, message) {
  const now = Date.now();
  const ttl = Math.min(message.ttl_ms || DEFAULT_TTL_MS, MAX_TTL_MS);
  const expiresAt = now + ttl;

  await db.prepare(`
    INSERT INTO psp_announcements (network, peer_id, session_id, expires_at_ms, updated_at_ms)
    VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT(network, peer_id) DO UPDATE SET
      session_id = excluded.session_id,
      expires_at_ms = excluded.expires_at_ms,
      updated_at_ms = excluded.updated_at_ms
  `).bind(message.network, message.from, message.session_id || null, expiresAt, now).run();
}

async function deleteAnnouncement(db, network, peerId) {
  await db.prepare(`DELETE FROM psp_announcements WHERE network = ?1 AND peer_id = ?2`)
    .bind(network, peerId).run();
}

async function findPeers(db, network, requesterPeerId) {
  const now = Date.now();
  const result = await db.prepare(`
    SELECT peer_id, session_id, updated_at_ms
    FROM psp_announcements
    WHERE network = ?1 AND peer_id != ?2 AND expires_at_ms > ?3
    ORDER BY peer_id ASC
    LIMIT ?4
  `).bind(network, requesterPeerId, now, MAX_BATCH).all();

  return (result.results || []).map(row => ({
    peer_id: row.peer_id,
    session_id: row.session_id,
    timestamp: row.updated_at_ms
  }));
}

async function insertRelayMessage(db, message) {
  const now = Date.now();
  const ttl = Math.min(message.ttl_ms || DEFAULT_TTL_MS, MAX_TTL_MS);
  const expiresAt = now + ttl;

  await db.prepare(`
    INSERT INTO psp_relay (network, to_peer_id, type, session_id, message_json, expires_at_ms, created_at_ms)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
  `).bind(
    message.network,
    message.to,
    message.type,
    message.session_id || null,
    JSON.stringify(message),
    expiresAt,
    now
  ).run();
}

async function fetchRelayMessages(db, network, toPeerId) {
  const now = Date.now();
  const result = await db.prepare(`
    SELECT id, message_json
    FROM psp_relay
    WHERE network = ?1 AND to_peer_id = ?2 AND expires_at_ms > ?3
    ORDER BY created_at_ms ASC
    LIMIT ?4
  `).bind(network, toPeerId, now, MAX_BATCH).all();

  return (result.results || []).map(row => ({
    id: row.id,
    message: JSON.parse(row.message_json)
  }));
}

async function deliverQueuedRelayMessages(db, socket, network, peerId) {
  if (!db) return 0;

  const queued = await fetchRelayMessages(db, network, peerId);
  if (queued.length === 0) return 0;

  console.log(`[OUT] Delivering ${queued.length} queued messages to ${peerId}`);
  const deliveredIds = [];
  for (const { id, message: queuedMsg } of queued) {
    try {
      socket.send(JSON.stringify(queuedMsg));
      deliveredIds.push(id);
    } catch (err) {
      console.error(`[OUT] Failed to deliver queued message:`, err?.message);
    }
  }

  if (deliveredIds.length > 0) {
    await deleteRelayMessagesById(db, deliveredIds);
  }

  return deliveredIds.length;
}

async function deleteRelayMessagesById(db, ids) {
  if (!ids.length) return;
  const placeholders = ids.map((_, i) => `?${i + 1}`).join(", ");
  await db.prepare(`DELETE FROM psp_relay WHERE id IN (${placeholders})`)
    .bind(...ids).run();
}

async function cleanupExpired(db) {
  const now = Date.now();
  await db.prepare(`DELETE FROM psp_announcements WHERE expires_at_ms <= ?1`).bind(now).run();
  await db.prepare(`DELETE FROM psp_relay WHERE expires_at_ms <= ?1`).bind(now).run();
}

// ===================== WebSocket Handler =====================

function handleWebSocket(request, env, ctx) {
  const { 0: client, 1: server } = new WebSocketPair();

  let peerKey = null;
  let network = null;
  let peerId = null;

  function cleanupPeerState() {
    const currentNetwork = network;

    if (!network || !peerId) {
      return currentNetwork;
    }

    const currentPeerId = peerId;
    const key = `${currentNetwork}:${currentPeerId}`;

    livePeers.delete(key);
    peerKey = null;
    peerId = null;
    network = null;

    if (env.DB) {
      ctx.waitUntil(
        deleteAnnouncement(env.DB, currentNetwork, currentPeerId)
          .then(() => broadcastPeerList(env.DB, currentNetwork))
          .catch(() => {})
      );
    }

    return currentNetwork;
  }

  server.addEventListener("message", async (event) => {
    try {
      const result = await handleClientMessage(server, event.data, env, ctx, peerKey, network);
      if (result) {
        peerKey = result.peerKey;
        network = result.network;
        peerId = result.peerId;
      }
    } catch (err) {
      console.error("[WS] Error:", err?.message || String(err));
      try {
        server.send(JSON.stringify({
          psp_version: PSP_VERSION, type: "error",
          from: env.RELAY_PEER_ID || "relay", to: "client",
          body: { error: err?.message || "Unknown error" }
        }));
      } catch {}
    }
  });

  server.addEventListener("close", () => {
    const subscriberNetwork = cleanupPeerState();
    if (subscriberNetwork) {
      const sockets = networkSubscribers.get(subscriberNetwork);
      if (sockets) {
        sockets.delete(server);
      }
    }
  });

  server.addEventListener("error", () => {
    const subscriberNetwork = cleanupPeerState();
    if (subscriberNetwork) {
      const sockets = networkSubscribers.get(subscriberNetwork);
      if (sockets) {
        sockets.delete(server);
      }
    }
  });

  server.accept();

  return new Response(null, { status: 101, webSocket: client });
}

async function handleClientMessage(socket, rawData, env, ctx, prevPeerKey = null, prevNetwork = null) {
  try {
    if (!rawData) return null;
    if (rawData.length > MAX_MESSAGE_SIZE) return null;

    let message;
    try { 
      message = JSON.parse(rawData); 
    } catch (e) {
      socket.send(JSON.stringify({
        psp_version: PSP_VERSION, type: "error",
        from: env.RELAY_PEER_ID || "relay", to: "client",
        body: { error: "Invalid JSON" }
      }));
      return null;
    }

    if (!validEnvelope(message)) {
      socket.send(JSON.stringify({
        psp_version: PSP_VERSION, type: "error",
        from: env.RELAY_PEER_ID || "relay", to: message?.from || "unknown",
        body: { error: "Invalid PSP envelope" }
      }));
      return null;
    }

    const { network, from: peerId, type } = message;
    const db = env.DB;
    const peerKey = `${network}:${peerId}`;

    // Subscribe to network on first message and whenever network changes on the same socket.
    if (!prevPeerKey || prevNetwork !== network) {
      if (prevNetwork && prevNetwork !== network) {
        const oldSockets = networkSubscribers.get(prevNetwork);
        if (oldSockets) {
          oldSockets.delete(socket);
        }
      }
      if (!networkSubscribers.has(network)) {
        networkSubscribers.set(network, new Set());
      }
      networkSubscribers.get(network).add(socket);
      console.log(`[NET] Peer ${peerId} subscribed to ${network}`);
    }

    // Track live peer
    livePeers.set(peerKey, { peerId, network, socket, lastSeen: Date.now() });

    if (type === "announce") {
      if (db) {
        await upsertAnnouncement(db, message);
        await deliverQueuedRelayMessages(db, socket, network, peerId);
      }
      
      // Only broadcast peer_list when the peer is newly joining, not on heartbeat re-announces.
      // prevPeerKey === peerKey means same peer on the same socket sending a periodic keep-alive;
      // no topology change occurred, so no need to push a new list to everyone.
      const isHeartbeat = prevPeerKey === peerKey;
      if (!isHeartbeat && db) {
        console.log(`[NET] Broadcasting peer_list for ${network} after new announce from ${peerId}`);
        broadcastPeerList(db, network).catch((err) => console.error(`[Broadcast error]`, err?.message));
      }

    } else if (type === "withdraw") {
      if (db) {
        await deleteAnnouncement(db, network, peerId);
      }
      livePeers.delete(peerKey);
      if (db) {
        broadcastPeerList(db, network).catch(() => {});
      }

    } else if (type === "discover") {
      if (db) {
        broadcastPeerList(db, network).catch(() => {});
      }

    } else if (type === "ping") {
      socket.send(JSON.stringify({
        psp_version: PSP_VERSION, type: "pong", network,
        from: env.RELAY_PEER_ID || "relay", to: peerId,
        message_id: crypto.randomUUID(), timestamp: Date.now(),
        ttl_ms: DEFAULT_TTL_MS, body: {}
      }));
      if (db) {
        await deliverQueuedRelayMessages(db, socket, network, peerId);
      }

    } else if (type === "bye") {
      if (db) {
        await deleteAnnouncement(db, network, peerId);
      }
      livePeers.delete(peerKey);
      if (db) {
        broadcastPeerList(db, network).catch(() => {});
      }

    } else if (RELAY_TYPES.has(type)) {
      // RTC negotiation messages - relay immediately if online, queue if offline
      if (!message.to) return { peerKey, network, peerId };

      // Try immediate delivery to live peer
      const liveKey = `${network}:${message.to}`;
      const live = livePeers.get(liveKey);
      let deliveredLive = false;
      if (live) {
        try {
          live.socket.send(rawData);
          deliveredLive = true;
          console.log(`[RELAY] Delivered ${type} from ${peerId} to ${message.to} immediately`);
        } catch (err) {
          console.error(`[RELAY] Failed to deliver to ${message.to}:`, err?.message);
        }
      }

      if (!deliveredLive && db) {
        await insertRelayMessage(db, message);
        if (!live) {
          console.log(`[RELAY] Peer ${message.to} offline, queued ${type} in DB`);
        } else {
          console.log(`[RELAY] Queued ${type} for ${message.to} after live delivery failure`);
        }
      } else if (!deliveredLive) {
        console.warn(`[RELAY] Could not deliver ${type} to ${message.to}; persistence unavailable`);
      }
    }

    ctx.waitUntil(cleanupExpired(db).catch(() => {}));
    return { peerKey, network, peerId };
  } catch (err) {
    console.error("[Handler] Error:", err?.message || String(err));
    return null;
  }
}

function validEnvelope(msg) {
  return (
    typeof msg === "object" && msg !== null &&
    msg.psp_version === PSP_VERSION &&
    typeof msg.type === "string" && MESSAGE_TYPES.has(msg.type) &&
    typeof msg.from === "string" && msg.from.trim() &&
    typeof msg.network === "string" && msg.network.trim() &&
    typeof msg.message_id === "string" &&
    typeof msg.timestamp === "number"
  );
}
