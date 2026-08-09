const PSP_VERSION = "1.0";
const WORKER_VERSION = "0.1.32";

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
const RELAY_EXPIRY_MS = 5 * 60_000;       // relay entry expires after 5 min without heartbeat
const FEDERATION_INTERVAL_MS = 2 * 60_000; // re-heartbeat every 2 min per isolate
const DEFAULT_HUB_URL = "wss://peer.ooo/ws"; // default bootstrap hub

const livePeers = new Map(); // key: JSON [network, room, peerId]
const networkSubscribers = new Map(); // key: JSON [network, room] -> Set of sockets

function normalizeRoom(value) {
  return typeof value === "string" ? value.trim() : "";
}

function scopeKey(network, room) {
  return JSON.stringify([network, room]);
}

function peerScopeKey(network, room, peerId) {
  return JSON.stringify([network, room, peerId]);
}

let lastFederationMs = 0; // tracks last heartbeat time within this isolate

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const upgrade = request.headers.get("Upgrade");

    // Heartbeat: self-register and sync with hub every FEDERATION_INTERVAL_MS
    if (env.RELAY_URL && env.DB) {
      const now = Date.now();
      if (now - lastFederationMs > FEDERATION_INTERVAL_MS) {
        lastFederationMs = now;
        ctx.waitUntil((async () => {
          const selfUrl = normalizeRelayUrl(env.RELAY_URL);
          if (!selfUrl) return;
          await upsertRelay(env.DB, selfUrl, env.RELAY_NAME || null).catch(() => {});
          const hubUrl = env.GLOBAL_RELAY_URL || DEFAULT_HUB_URL;
          // Skip registering with hub if we ARE the hub
          if (normalizeRelayUrl(hubUrl) !== selfUrl) {
            await registerWithHub({ ...env, GLOBAL_RELAY_URL: hubUrl }, selfUrl).catch(() => {});
          }
        })());
      }
    }

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
      return jsonResponse({
        ok: true,
        version: WORKER_VERSION,
        protocol_version: PSP_VERSION,
        peers: livePeers.size
      }, 200);
    }

    // Federation: relay registry endpoints (any worker can serve these from its own D1)
    if (url.pathname === "/api/v1/relays") {
      if (request.method === "GET") {
        return handleListRelays(env);
      }
      if (request.method === "POST") {
        return handleRegisterRelay(request, env);
      }
      return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
    }

    if (url.pathname === "/api/v1/peers") {
      if (request.method === "GET") {
        return handleListPeers(request, env);
      }
      return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
    }

    if (url.pathname === "/api/v1/relay") {
      if (request.method === "POST") {
        return handleRelayForward(request, env);
      }
      return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
    }

    return env.ASSETS?.fetch(request) ?? new Response("Not Found", { status: 404 });
  }
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
  });
}

// ===================== Federation =====================

async function handleListRelays(env) {
  if (!env.DB) return jsonResponse({ ok: false, error: "No database" }, 503);
  const relays = await listRelays(env.DB);
  return jsonResponse({ ok: true, relays });
}

async function handleRegisterRelay(request, env) {
  if (!env.DB) return jsonResponse({ ok: false, error: "No database" }, 503);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ ok: false, error: "Invalid JSON" }, 400); }
  if (!body?.url || typeof body.url !== "string") {
    return jsonResponse({ ok: false, error: "Missing url" }, 400);
  }
  const normalizedUrl = normalizeRelayUrl(body.url);
  if (!normalizedUrl) {
    return jsonResponse({ ok: false, error: "Invalid relay url" }, 400);
  }
  await upsertRelay(env.DB, normalizedUrl, body.name || null);
  const relays = await listRelays(env.DB);
  return jsonResponse({ ok: true, relays });
}

async function handleListPeers(request, env) {
  if (!env.DB) return jsonResponse({ ok: false, error: "No database" }, 503);
  const url = new URL(request.url);
  const network = (url.searchParams.get("network") || "").trim();
  const room = (url.searchParams.get("room") || url.searchParams.get("session_id") || "").trim();
  const excludePeerId = (url.searchParams.get("exclude") || "").trim();
  if (!network) return jsonResponse({ ok: false, error: "Missing network" }, 400);
  if (!room) return jsonResponse({ ok: false, error: "Missing room" }, 400);
  const peers = await findPeers(env.DB, network, room, excludePeerId);
  return jsonResponse({ ok: true, peers });
}

async function handleRelayForward(request, env) {
  if (!env.DB) return jsonResponse({ ok: false, error: "No database" }, 503);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ ok: false, error: "Invalid JSON" }, 400); }
  const message = body?.message || body;
  if (!validEnvelope(message)) {
    return jsonResponse({ ok: false, error: "Invalid PSP envelope" }, 400);
  }
  if (!RELAY_TYPES.has(message.type)) {
    return jsonResponse({ ok: false, error: "Unsupported relay message type" }, 400);
  }
  if (!message.to || typeof message.to !== "string") {
    return jsonResponse({ ok: false, error: "Missing destination peer" }, 400);
  }
  const room = normalizeRoom(message.session_id);
  const liveKey = peerScopeKey(message.network, room, message.to);
  const live = livePeers.get(liveKey);
  if (live) {
    try {
      live.socket.send(JSON.stringify(message));
      return jsonResponse({ ok: true, delivered: true }, 200);
    } catch {}
  }
  await insertRelayMessage(env.DB, message);
  return jsonResponse({ ok: true, delivered: false, queued: true }, 202);
}

// POST to the global hub; cache returned relay list into own D1 so both sides know each other
async function registerWithHub(env, selfUrl) {
  const resp = await fetch(`${relayHttpBase(normalizeRelayUrl(env.GLOBAL_RELAY_URL))}/api/v1/relays`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: selfUrl, name: env.RELAY_NAME || null })
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  const relays = data.relays || [];
  // Cache peer relays locally so discover/forward works without hitting hub each time
  if (env.DB) {
    await Promise.all(
      relays
        .filter(r => r.url && r.url !== selfUrl)
        .map(r => upsertRelay(env.DB, r.url, r.name || null).catch(() => {}))
    );
  }
  return relays;
}

// Get peer relay URLs from own D1 (excludes self); works for both hub and contributors
async function getPeerRelayUrls(db, selfUrl) {
  if (!db) return [];
  const relays = await listRelays(db);
  return relays.map(r => r.url).filter(u => u !== selfUrl);
}

// Normalize any relay URL to a canonical wss:// WebSocket URL
function normalizeRelayUrl(url) {
  if (!url) return null;
  let u = url.trim();
  // Convert http(s):// to ws(s)://
  u = u.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
  // Ensure it ends with /ws
  if (!u.endsWith("/ws")) u = u.replace(/\/$/, "") + "/ws";
  return u;
}

// Derive HTTP base URL from a wss:// relay URL (wss://peer.ooo/ws → https://peer.ooo)
function relayHttpBase(wsUrl) {
  return wsUrl.replace(/^wss?:\/\//, (m) => m === "wss://" ? "https://" : "http://").replace(/\/ws$/, "");
}

// Query a remote relay's HTTP peer-list endpoint.
async function queryRelayForPeers(relayUrl, network, room, requesterPeerId) {
  try {
    const base = relayHttpBase(relayUrl);
    const params = new URLSearchParams({ network, room });
    if (requesterPeerId) params.set("exclude", requesterPeerId);
    const resp = await fetch(`${base}/api/v1/peers?${params.toString()}`);
    if (!resp.ok) return [];
    const data = await resp.json();
    const peers = Array.isArray(data?.peers) ? data.peers : [];
    return peers.map(p => ({ ...p, relay_url: relayUrl }));
  } catch {
    return [];
  }
}

// Forward a PSP message through a remote relay's HTTP endpoint.
async function forwardToRelay(relayUrl, message, selfRelayId) {
  try {
    const base = relayHttpBase(relayUrl);
    await fetch(`${base}/api/v1/relay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, via: selfRelayId || "relay-bridge" })
    });
  } catch {}
}

// ===================== D1 Relay Registry =====================

async function upsertRelay(db, url, name) {
  const now = Date.now();
  await db.prepare(`
    INSERT INTO psp_relays (url, name, registered_at_ms, last_seen_ms)
    VALUES (?1, ?2, ?3, ?3)
    ON CONFLICT(url) DO UPDATE SET name = excluded.name, last_seen_ms = excluded.last_seen_ms
  `).bind(url, name, now).run();
}

async function listRelays(db) {
  const cutoff = Date.now() - RELAY_EXPIRY_MS;
  const result = await db.prepare(`
    SELECT url, name, last_seen_ms FROM psp_relays
    WHERE last_seen_ms > ?1
    ORDER BY last_seen_ms DESC
  `).bind(cutoff).all();
  return (result.results || []).map(r => ({ url: r.url, name: r.name }));
}

function mergeDiscoveredPeers(...peerGroups) {
  const merged = new Map();

  for (const peers of peerGroups) {
    if (!Array.isArray(peers)) continue;
    for (const peer of peers) {
      const peerId = peer?.peer_id;
      if (typeof peerId !== "string" || !peerId) continue;

      const existing = merged.get(peerId);
      const nextTimestamp = Number(peer?.timestamp || 0);
      const existingTimestamp = Number(existing?.timestamp || 0);
      if (!existing || nextTimestamp >= existingTimestamp) {
        merged.set(peerId, peer);
      }
    }
  }

  return Array.from(merged.values()).sort((left, right) => left.peer_id.localeCompare(right.peer_id));
}

function sendPeerList(socket, network, room, peers, to = null, from = "bootstrap-relay") {
  socket.send(JSON.stringify({
    psp_version: PSP_VERSION,
    type: "peer_list",
    network,
    session_id: room,
    from,
    to,
    message_id: crypto.randomUUID(),
    timestamp: Date.now(),
    ttl_ms: DEFAULT_TTL_MS,
    body: { peers }
  }));
}

function createRegistrationAck(message, relayPeerId = "bootstrap-relay") {
  return {
    psp_version: PSP_VERSION,
    type: "ack",
    network: message.network,
    session_id: normalizeRoom(message.session_id),
    from: relayPeerId,
    to: message.from,
    message_id: crypto.randomUUID(),
    reply_to: message.message_id,
    timestamp: Date.now(),
    ttl_ms: DEFAULT_TTL_MS,
    body: { status: "ok", action: "announce" }
  };
}

// Broadcast only to peers in the same Network + Room scope.
async function broadcastPeerList(db, network, room) {
  const storageScope = scopeKey(network, room);
  const sockets = networkSubscribers.get(storageScope);
  if (!sockets || sockets.size === 0) return;

  const now = Date.now();
  const result = await db.prepare(`
    SELECT peer_id, session_id, updated_at_ms
    FROM psp_announcements
    WHERE network = ?1 AND expires_at_ms > ?2
    ORDER BY peer_id ASC
    LIMIT ?3
  `).bind(storageScope, now, MAX_BATCH).all();

  const peers = (result.results || []).map(row => ({
    peer_id: row.peer_id,
    session_id: row.session_id,
    timestamp: row.updated_at_ms
  }));
  for (const socket of sockets) {
    try {
      sendPeerList(socket, network, room, peers);
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
  `).bind(scopeKey(message.network, normalizeRoom(message.session_id)), message.from, message.session_id, expiresAt, now).run();
}

async function deleteAnnouncement(db, network, room, peerId) {
  await db.prepare(`DELETE FROM psp_announcements WHERE network = ?1 AND peer_id = ?2`)
    .bind(scopeKey(network, room), peerId).run();
}

async function findPeers(db, network, room, requesterPeerId) {
  const now = Date.now();
  const storageScope = scopeKey(network, room);
  const result = await db.prepare(`
    SELECT peer_id, session_id, updated_at_ms
    FROM psp_announcements
    WHERE network = ?1 AND peer_id != ?2 AND expires_at_ms > ?3
    ORDER BY peer_id ASC
    LIMIT ?4
  `).bind(storageScope, requesterPeerId, now, MAX_BATCH).all();

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
    scopeKey(message.network, normalizeRoom(message.session_id)),
    message.to,
    message.type,
    message.session_id || null,
    JSON.stringify(message),
    expiresAt,
    now
  ).run();
}

async function fetchRelayMessages(db, network, room, toPeerId) {
  const now = Date.now();
  const result = await db.prepare(`
    SELECT id, message_json
    FROM psp_relay
    WHERE network = ?1 AND to_peer_id = ?2 AND expires_at_ms > ?3
    ORDER BY created_at_ms ASC
    LIMIT ?4
  `).bind(scopeKey(network, room), toPeerId, now, MAX_BATCH).all();

  return (result.results || []).map(row => ({
    id: row.id,
    message: JSON.parse(row.message_json)
  }));
}

async function deliverQueuedRelayMessages(db, socket, network, room, peerId) {
  if (!db) return 0;

  const queued = await fetchRelayMessages(db, network, room, peerId);
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
  let room = null;
  let peerId = null;

  function cleanupPeerState() {
    const currentNetwork = network;
    const currentRoom = room;

    if (!network || !room || !peerId) {
      return currentNetwork && currentRoom ? scopeKey(currentNetwork, currentRoom) : null;
    }

    const currentPeerId = peerId;
    const key = peerScopeKey(currentNetwork, currentRoom, currentPeerId);
    const subscriberScope = scopeKey(currentNetwork, currentRoom);

    livePeers.delete(key);
    peerKey = null;
    peerId = null;
    network = null;
    room = null;

    if (env.DB) {
      ctx.waitUntil(
        deleteAnnouncement(env.DB, currentNetwork, currentRoom, currentPeerId)
          .then(() => broadcastPeerList(env.DB, currentNetwork, currentRoom))
          .catch(() => {})
      );
    }

    return subscriberScope;
  }

  server.addEventListener("message", async (event) => {
    try {
      const result = await handleClientMessage(server, event.data, env, ctx, peerKey, network, room);
      if (result) {
        peerKey = result.peerKey;
        network = result.network;
        room = result.room;
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
    const subscriberScope = cleanupPeerState();
    if (subscriberScope) {
      const sockets = networkSubscribers.get(subscriberScope);
      if (sockets) {
        sockets.delete(server);
      }
    }
  });

  server.addEventListener("error", () => {
    const subscriberScope = cleanupPeerState();
    if (subscriberScope) {
      const sockets = networkSubscribers.get(subscriberScope);
      if (sockets) {
        sockets.delete(server);
      }
    }
  });

  server.accept();

  return new Response(null, { status: 101, webSocket: client });
}

async function handleClientMessage(socket, rawData, env, ctx, prevPeerKey = null, prevNetwork = null, prevRoom = null) {
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
    const room = normalizeRoom(message.session_id);
    const db = env.DB;
    const peerKey = peerScopeKey(network, room, peerId);
    const subscriberScope = scopeKey(network, room);

    if (type === "announce" && message.body?.instance_id !== network) {
      socket.send(JSON.stringify({
        psp_version: PSP_VERSION,
        type: "error",
        network,
        session_id: room,
        from: env.RELAY_PEER_ID || "relay",
        to: peerId,
        message_id: crypto.randomUUID(),
        timestamp: Date.now(),
        ttl_ms: DEFAULT_TTL_MS,
        body: { error: "instance_id must match network" }
      }));
      return null;
    }

    if (message.to && message.to === peerId && RELAY_TYPES.has(type)) {
      return { peerKey, network, room, peerId };
    }

    // Subscribe to the exact Network + Room scope. A domain is only a relay;
    // domain boundaries do not replace application scope boundaries.
    if (!prevPeerKey || prevNetwork !== network || prevRoom !== room) {
      if (prevNetwork && prevRoom && (prevNetwork !== network || prevRoom !== room)) {
        const oldSockets = networkSubscribers.get(scopeKey(prevNetwork, prevRoom));
        if (oldSockets) {
          oldSockets.delete(socket);
        }
      }
      if (!networkSubscribers.has(subscriberScope)) {
        networkSubscribers.set(subscriberScope, new Set());
      }
      networkSubscribers.get(subscriberScope).add(socket);
      console.log(`[NET] Peer ${peerId} subscribed to network=${network} room=${room}`);
    }

    // Track live peer
    livePeers.set(peerKey, { peerId, network, room, socket, lastSeen: Date.now() });

    if (type === "announce") {
      if (db) {
        await upsertAnnouncement(db, message);
        await deliverQueuedRelayMessages(db, socket, network, room, peerId);
      }

      // Registration is complete only after the relay has accepted the
      // announcement. Clients use this ACK to begin discovery and signaling.
      socket.send(JSON.stringify(createRegistrationAck(
        message,
        env.RELAY_PEER_ID || "bootstrap-relay"
      )));
      
      // Only broadcast peer_list when the peer is newly joining, not on heartbeat re-announces.
      // prevPeerKey === peerKey means same peer on the same socket sending a periodic keep-alive;
      // no topology change occurred, so no need to push a new list to everyone.
      const isHeartbeat = prevPeerKey === peerKey;
      if (!isHeartbeat && db) {
        console.log(`[NET] Broadcasting peer_list for network=${network} room=${room} after new announce from ${peerId}`);
        broadcastPeerList(db, network, room).catch((err) => console.error(`[Broadcast error]`, err?.message));
      }

    } else if (type === "withdraw") {
      if (db) {
        await deleteAnnouncement(db, network, room, peerId);
      }
      livePeers.delete(peerKey);
      if (db) {
        broadcastPeerList(db, network, room).catch(() => {});
      }

    } else if (type === "discover") {
      let localPeers = [];
      if (db) {
        localPeers = await findPeers(db, network, room, peerId);
      }

      let remotePeers = [];
      if (env.RELAY_URL && env.DB) {
        const selfUrl = normalizeRelayUrl(env.RELAY_URL);
        const allRelays = await listRelays(env.DB);
        const remoteUrls = allRelays.map(r => r.url).filter(u => u !== selfUrl);

        if (remoteUrls.length) {
          const results = await Promise.all(
            remoteUrls.map(u => queryRelayForPeers(u, network, room, peerId))
          );
          remotePeers = results.flat();
        }
      }

      try {
        sendPeerList(
          socket,
          network,
          room,
          mergeDiscoveredPeers(localPeers, remotePeers).filter(peer => peer.peer_id !== peerId),
          peerId,
          env.RELAY_PEER_ID || "bootstrap-relay"
        );
      } catch {}

    } else if (type === "ext" && message.body?.action === "relay_list") {
      // Remote relay is sharing its known relay list — cache any new entries
      if (db) {
        const remoteRelays = message.body.relays || [];
        await Promise.all(
          remoteRelays
            .filter(r => r.url)
            .map(r => upsertRelay(db, r.url, r.name || null).catch(() => {}))
        );
      }

    } else if (type === "ping") {
      socket.send(JSON.stringify({
        psp_version: PSP_VERSION, type: "pong", network,
        session_id: room,
        from: env.RELAY_PEER_ID || "relay", to: peerId,
        message_id: crypto.randomUUID(), timestamp: Date.now(),
        ttl_ms: DEFAULT_TTL_MS, body: {}
      }));
      if (db) {
        await deliverQueuedRelayMessages(db, socket, network, room, peerId);
      }

    } else if (type === "bye") {
      if (db) {
        await deleteAnnouncement(db, network, room, peerId);
      }
      livePeers.delete(peerKey);
      if (db) {
        broadcastPeerList(db, network, room).catch(() => {});
      }

    } else if (RELAY_TYPES.has(type)) {
      // RTC negotiation messages - relay immediately if online, queue if offline
      if (!message.to) return { peerKey, network, room, peerId };
      if (message.to === peerId) return { peerKey, network, room, peerId };

      // Try immediate delivery to live peer
      const liveKey = peerScopeKey(network, room, message.to);
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

      // If still not delivered locally and federation is enabled, fan out to peer relays via WebSocket
      if (!deliveredLive && env.RELAY_URL && env.DB) {
        ctx.waitUntil((async () => {
          const selfRelayId = env.RELAY_PEER_ID || "relay-bridge";
          const selfUrl = normalizeRelayUrl(env.RELAY_URL);
          const remoteUrls = await getPeerRelayUrls(env.DB, selfUrl);
          if (!remoteUrls.length) return;
          console.log(`[FED] Forwarding ${type} to ${remoteUrls.length} peer relay(s) for ${message.to}`);
          await Promise.all(remoteUrls.map(u => forwardToRelay(u, message, selfRelayId)));
        })());
      }
    }

    ctx.waitUntil(cleanupExpired(db).catch(() => {}));
    return { peerKey, network, room, peerId };
  } catch (err) {
    console.error("[Handler] Error:", err?.message || String(err));
    return null;
  }
}

function validEnvelope(msg) {
  return Boolean(
    typeof msg === "object" && msg !== null &&
    msg.psp_version === PSP_VERSION &&
    typeof msg.type === "string" && MESSAGE_TYPES.has(msg.type) &&
    typeof msg.from === "string" && msg.from.trim() &&
    typeof msg.network === "string" && msg.network.trim() &&
    typeof msg.session_id === "string" && msg.session_id.trim() &&
    typeof msg.message_id === "string" &&
    typeof msg.timestamp === "number"
  );
}

export { createRegistrationAck, normalizeRoom, scopeKey, peerScopeKey, validEnvelope };
