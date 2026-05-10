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
const RELAY_EXPIRY_MS = 5 * 60_000;       // relay entry expires after 5 min without heartbeat
const FEDERATION_INTERVAL_MS = 2 * 60_000; // re-heartbeat every 2 min per isolate
const DEFAULT_HUB_URL = "wss://peer.ooo/ws"; // default bootstrap hub

const livePeers = new Map(); // key: "network:peerId" -> { peerId, network, socket, lastSeen }
const networkSubscribers = new Map(); // key: network -> Set of sockets

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
      return jsonResponse({ ok: true, version: PSP_VERSION, peers: livePeers.size }, 200);
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

// Open a short-lived WebSocket to a remote relay: get its peer list and exchange relay lists
async function queryRelayForPeers(relayUrl, network, selfRelayId, db, selfKnownRelays) {
  try {
    const resp = await fetch(relayUrl, { headers: { Upgrade: "websocket" } });
    if (resp.status !== 101) return [];
    const ws = resp.webSocket;
    ws.accept();

    return await new Promise((resolve) => {
      const timer = setTimeout(() => { try { ws.close(); } catch {} resolve([]); }, 4000);
      let gotPeerList = false;

      ws.addEventListener("message", async (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "peer_list" && msg.network === network && !gotPeerList) {
            gotPeerList = true;
            clearTimeout(timer);
            ws.close();
            resolve((msg.body?.peers || []).map(p => ({ ...p, relay_url: relayUrl })));
          }
          // Cache any relay list the remote sends us via ext
          if (msg.type === "ext" && msg.body?.action === "relay_list" && db) {
            const remoteRelays = msg.body.relays || [];
            await Promise.all(
              remoteRelays.map(r => r.url ? upsertRelay(db, r.url, r.name || null).catch(() => {}) : null)
            );
          }
        } catch {}
      });

      ws.addEventListener("error", () => { clearTimeout(timer); resolve([]); });
      ws.addEventListener("close", () => { if (!gotPeerList) { clearTimeout(timer); resolve([]); } });

      const relayPeerId = selfRelayId || "relay-bridge";
      // Announce as relay bridge
      ws.send(JSON.stringify({
        psp_version: PSP_VERSION, type: "announce", network,
        from: relayPeerId, message_id: crypto.randomUUID(),
        timestamp: Date.now(), ttl_ms: 10_000, body: { capabilities: { relay: true } }
      }));
      // Share our known relay list so the remote can cache us
      if (selfKnownRelays?.length) {
        ws.send(JSON.stringify({
          psp_version: PSP_VERSION, type: "ext", network,
          from: relayPeerId, message_id: crypto.randomUUID(),
          timestamp: Date.now(), ttl_ms: 10_000,
          body: { action: "relay_list", relays: selfKnownRelays }
        }));
      }
      // Request their peers
      ws.send(JSON.stringify({
        psp_version: PSP_VERSION, type: "discover", network,
        from: relayPeerId, message_id: crypto.randomUUID(),
        timestamp: Date.now(), ttl_ms: 10_000, body: {}
      }));
    });
  } catch {
    return [];
  }
}

// Open a short-lived WebSocket to a remote relay and forward a PSP message through it
async function forwardToRelay(relayUrl, message, selfRelayId) {
  try {
    const wsUrl = relayUrl;
    const resp = await fetch(wsUrl, { headers: { Upgrade: "websocket" } });
    if (resp.status !== 101) return;
    const ws = resp.webSocket;
    ws.accept();

    // Outbound Worker WebSocket: send immediately after accept(), no open event needed
    const relayPeerId = selfRelayId || "relay-bridge";
    ws.send(JSON.stringify({
      psp_version: PSP_VERSION, type: "announce", network: message.network,
      from: relayPeerId, message_id: crypto.randomUUID(),
      timestamp: Date.now(), ttl_ms: 10_000, body: { capabilities: { relay: true } }
    }));
    ws.send(JSON.stringify(message));
    ws.close();
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
      // Local peers first
      if (db) {
        broadcastPeerList(db, network).catch(() => {});
      }
      // Fan out to all known peer relays, exchanging relay lists bidirectionally
      if (env.RELAY_URL && env.DB) {
        ctx.waitUntil((async () => {
          const selfRelayId = env.RELAY_PEER_ID || "relay-bridge";
          const selfUrl = normalizeRelayUrl(env.RELAY_URL);
          const allRelays = await listRelays(env.DB);
          const remoteUrls = allRelays.map(r => r.url).filter(u => u !== selfUrl);
          if (!remoteUrls.length) return;

          const results = await Promise.all(
            remoteUrls.map(u => queryRelayForPeers(u, network, selfRelayId, env.DB, allRelays))
          );
          const remotePeers = results.flat();
          if (!remotePeers.length) return;

          const message = {
            psp_version: PSP_VERSION, type: "peer_list", network,
            from: selfRelayId, to: peerId,
            message_id: crypto.randomUUID(), timestamp: Date.now(),
            ttl_ms: DEFAULT_TTL_MS,
            body: { peers: remotePeers }
          };
          try { socket.send(JSON.stringify(message)); } catch {}
        })());
      }

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
