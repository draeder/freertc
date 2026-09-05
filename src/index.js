import {
  handleKademliaRequest,
  heartbeatKademlia,
  isKademliaEnabled,
  lookupPeerProviders,
  lookupScopeProviders,
  publishPeerProviderRecords,
} from "./relay-overlay.js";

const PSP_VERSION = "1.0";
const WORKER_VERSION = "0.2.0";

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
const FEDERATED_PEER_QUERY_TIMEOUT_MS = 2_500;
// A discover is answered within this bound no matter what federation does;
// the local peers are sent alone if the federated lookup is still running.
const DISCOVER_REPLY_DEADLINE_MS = 4_000;
const MAX_TTL_MS = 120_000;
const MAX_MESSAGE_SIZE = 64 * 1024;
const MAX_BATCH = 50;
const RELAY_EXPIRY_MS = 5 * 60_000;       // relay entry expires after 5 min without heartbeat
const FEDERATION_INTERVAL_MS = 2 * 60_000; // re-heartbeat every 2 min per isolate
const DEFAULT_HUB_URL = "wss://peer.ooo/ws"; // default bootstrap hub
const KADEMLIA_FORWARD_LIMIT = 2;
const FEDERATED_FORWARD_DEADLINE_MS = 15_000;
const PEER_RELAY_HINT_TTL_MS = 60_000;

const livePeers = new Map(); // key: JSON [network, room, peerId]
const networkSubscribers = new Map(); // key: JSON [network, room] -> Set of sockets
const peerRelayHints = new Map(); // key: JSON [network, room, peerId] -> { url, expiresAt }
// Diagnostic trail of federation work done on behalf of live sockets. Read
// through GET /debug/state on the coordinator. Bounded; newest last.
const debugTrail = [];
const DEBUG_TRAIL_LIMIT = 300;
function debugNote(entry) {
  debugTrail.push({ t: Date.now(), ...entry });
  while (debugTrail.length > DEBUG_TRAIL_LIMIT) debugTrail.shift();
}

// ===================== Deferred work =====================
//
// Nothing that leaves the runtime — a D1 query, a fetch to another relay, a
// Kademlia walk — may run on a WebSocket's own request context. The platform
// charges every such subrequest to the request that opened the socket, and a
// socket that lives for hours pays for all of them at once: after a handful of
// federated forwards each further call fails with "Subrequest depth limit
// exceeded", silently, and the peer looks reachable while nothing it sends
// gets out. So the socket handler only touches memory, and hands the rest to
// the coordinator's alarm, which runs each batch on a fresh context.
const DEFERRED_TASK_PREFIX = "task:";
const MAX_DEFERRED_TASKS_PER_ALARM = 6;
const CLEANUP_INTERVAL_MS = 60_000;
let deferredTaskSequence = 0;
let lastCleanupAt = 0;

function canDefer(ctx) {
  return Boolean(ctx?.storage?.put && ctx?.storage?.setAlarm && ctx?.storage?.getAlarm);
}

async function deferWork(ctx, env, task) {
  if (!canDefer(ctx)) {
    // No coordinator (legacy single-isolate mode): run it here as before.
    const work = runDeferredTask(env, task).catch((error) => {
      console.error(`[TASK] ${task.kind} failed: ${error?.message}`);
    });
    if (ctx?.waitUntil) ctx.waitUntil(work);
    return;
  }
  deferredTaskSequence = (deferredTaskSequence + 1) % 1_000_000;
  const key = `${DEFERRED_TASK_PREFIX}${String(Date.now()).padStart(15, "0")}:${String(deferredTaskSequence).padStart(6, "0")}`;
  await ctx.storage.put(key, task);
  if ((await ctx.storage.getAlarm()) === null) {
    await ctx.storage.setAlarm(Date.now());
  }
}

async function drainDeferredTasks(state, env) {
  const entries = await state.storage.list({ prefix: DEFERRED_TASK_PREFIX, limit: MAX_DEFERRED_TASKS_PER_ALARM });
  if (entries.size === 0) return;
  await Promise.all([...entries].map(async ([key, task]) => {
    const startedAt = Date.now();
    try {
      await runDeferredTask(env, task);
    } catch (error) {
      debugNote({ op: "task-error", kind: task?.kind, error: String(error?.message || error).slice(0, 300), ms: Date.now() - startedAt });
      console.error(`[TASK] ${task?.kind} failed: ${error?.message}`);
    }
    await state.storage.delete(key);
  }));
  const remaining = await state.storage.list({ prefix: DEFERRED_TASK_PREFIX, limit: 1 });
  if (remaining.size > 0) await state.storage.setAlarm(Date.now());
}

async function runDeferredTask(env, task) {
  const db = env.DB;
  const { kind, network, room, peerId, selfRelayUrl } = task;
  const relayPeerId = resolveRelayPeerId(env.RELAY_PEER_ID, selfRelayUrl);
  const liveSocket = () => livePeers.get(peerScopeKey(network, room, peerId))?.socket ?? null;

  if (kind === "announce") {
    if (db) {
      await upsertAnnouncement(db, task.message);
      const socket = liveSocket();
      if (socket) await deliverQueuedRelayMessages(db, socket, network, room, peerId);
    }
    if (selfRelayUrl && isKademliaEnabled(env)) {
      if (task.isHeartbeat) {
        await publishPeerProviderRecords(env, selfRelayUrl, network, room, peerId, { connections: livePeers.size });
      } else {
        // Query the established overlay immediately while publishing this
        // peer's provider records in parallel. Discovery must not sit behind
        // the publication round trip for a peer that is already isolated.
        await discoverJoiningPeer({
          discover: (scopeProviders) => findFederatedPeers(env, selfRelayUrl, network, room, peerId, livePeers.size, scopeProviders),
          publish: () => publishPeerProviderRecords(env, selfRelayUrl, network, room, peerId, { connections: livePeers.size, returnScopeProviders: true }),
          send: (peers) => {
            const socket = liveSocket();
            if (!socket) return;
            try { sendPeerList(socket, network, room, peers, peerId, relayPeerId); } catch {}
          },
        });
      }
    }
    // Only broadcast peer_list when the peer is newly joining, not on a
    // heartbeat re-announce: no topology change occurred.
    if (!task.isHeartbeat && db) {
      console.log(`[NET] Broadcasting peer_list for network=${network} room=${room} after new announce from ${peerId}`);
      await broadcastPeerList(db, network, room, relayPeerId).catch((err) => console.error(`[Broadcast error]`, err?.message));
    }
    return;
  }

  if (kind === "discover") {
    // Never leave a discover unanswered. The reply is bounded: federated
    // peers when they arrive in time, the local ones alone otherwise.
    let answered = false;
    const reply = (peers) => {
      if (answered) return;
      answered = true;
      const socket = liveSocket();
      if (!socket) return;
      try { sendPeerList(socket, network, room, peers, peerId, relayPeerId); } catch {}
    };
    const localOnly = async () => {
      try { return db ? await findPeers(db, network, room, peerId) : []; } catch { return []; }
    };
    const deadline = setTimeout(() => { localOnly().then(reply); }, DISCOVER_REPLY_DEADLINE_MS);
    try {
      const peers = await findFederatedPeers(env, selfRelayUrl, network, room, peerId, livePeers.size);
      clearTimeout(deadline);
      reply(peers);
    } catch {
      clearTimeout(deadline);
      reply(await localOnly());
    }
    return;
  }

  if (kind === "peer-left") {
    if (!db) return;
    await deleteAnnouncement(db, network, room, peerId);
    await broadcastPeerList(db, network, room, relayPeerId).catch(() => {});
    return;
  }

  if (kind === "deliver-queued") {
    const socket = liveSocket();
    if (db && socket) await deliverQueuedRelayMessages(db, socket, network, room, peerId);
    return;
  }

  if (kind === "relay-list") {
    if (!db) return;
    await Promise.all((task.relays || [])
      .filter((r) => r?.url)
      .map((r) => upsertRelay(db, r.url, r.name || null).catch(() => {})));
    return;
  }

  if (kind === "forward") {
    const message = task.message;
    const type = message.type;
    // The peer may have arrived here since the socket handler looked.
    const live = livePeers.get(peerScopeKey(network, room, message.to));
    if (live) {
      try {
        live.socket.send(JSON.stringify(message));
        debugNote({ op: "forward", type, from: peerId.slice(0, 8), to: message.to.slice(0, 8), hint: "local", delivered: true, ms: 0 });
        return;
      } catch {}
    }
    if (!db) {
      console.warn(`[RELAY] Could not deliver ${type} to ${message.to}; persistence unavailable`);
      return;
    }
    if (!selfRelayUrl) {
      await insertRelayMessage(db, message);
      return;
    }
    const startedAt = Date.now();
    const hint = getPeerRelayHint(network, room, message.to);
    try {
      // Bounded: a forward that cannot finish inside the deadline is queued
      // like an unreachable peer instead of silently vanishing.
      const deliveredRemote = await Promise.race([
        forwardFederatedMessage(env, selfRelayUrl, network, room, message, livePeers.size),
        new Promise((resolve) => setTimeout(() => resolve(false), FEDERATED_FORWARD_DEADLINE_MS)),
      ]);
      debugNote({ op: "forward", type, from: peerId.slice(0, 8), to: message.to.slice(0, 8), hint, delivered: deliveredRemote, ms: Date.now() - startedAt });
      if (deliveredRemote) {
        console.log(`[FED] Routed ${type} to peer relay for ${message.to}`);
        return;
      }
    } catch (error) {
      debugNote({ op: "forward", type, from: peerId.slice(0, 8), to: message.to.slice(0, 8), hint, error: String(error?.stack || error?.message || error).slice(0, 400), ms: Date.now() - startedAt });
      console.error(`[FED] forwarding ${type} to ${message.to} failed: ${error?.message}`);
    }
    await insertRelayMessage(db, message);
    console.log(`[RELAY] Peer ${message.to} unavailable across federation, queued ${type} in DB`);
    return;
  }

  if (kind === "cleanup") {
    if (db) await cleanupExpired(db);
    return;
  }
}
let nextSocketGeneration = 0;

export function claimLivePeer(livePeerMap, key, value) {
  const current = livePeerMap.get(key);
  if (
    current?.socket !== value.socket
    && Number(current?.socketGeneration ?? 0) > Number(value.socketGeneration ?? 0)
  ) {
    return false;
  }
  livePeerMap.set(key, value);
  return true;
}

export function deleteLivePeerIfOwned(livePeerMap, key, socket) {
  const current = livePeerMap.get(key);
  if (!current || current.socket !== socket) return false;
  livePeerMap.delete(key);
  return true;
}

function relayCoordinatorStub(env) {
  const namespace = env?.RELAY_COORDINATOR;
  if (!namespace?.idFromName || !namespace?.get) return null;
  return namespace.get(namespace.idFromName("relay"));
}

function normalizeRoom(value) {
  return typeof value === "string" ? value.trim() : "";
}

function scopeKey(network, room) {
  return JSON.stringify([network, room]);
}

function peerScopeKey(network, room, peerId) {
  return JSON.stringify([network, room, peerId]);
}

export function rememberPeerRelayHint(network, room, peerId, relayUrl, now = Date.now()) {
  const normalizedUrl = normalizeRelayUrl(relayUrl);
  if (!network || !room || !peerId || !normalizedUrl || !/^wss?:\/\//.test(normalizedUrl)) return false;
  peerRelayHints.set(peerScopeKey(network, room, peerId), {
    url: normalizedUrl,
    expiresAt: now + PEER_RELAY_HINT_TTL_MS,
  });
  return true;
}

export function getPeerRelayHint(network, room, peerId, now = Date.now()) {
  const key = peerScopeKey(network, room, peerId);
  const hint = peerRelayHints.get(key);
  if (!hint) return null;
  if (hint.expiresAt <= now) {
    peerRelayHints.delete(key);
    return null;
  }
  return hint.url;
}

let lastFederationMs = 0; // tracks last heartbeat time within this isolate

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const upgrade = request.headers.get("Upgrade");
    const selfRelayUrl = resolveSelfRelayUrl(request, env.RELAY_URL);

    // Heartbeat: join the bounded Kademlia overlay when signing keys are
    // configured. Older deployments retain the legacy registry fallback.
    if (selfRelayUrl && env.DB) {
      const now = Date.now();
      if (now - lastFederationMs > FEDERATION_INTERVAL_MS) {
        lastFederationMs = now;
        ctx.waitUntil((async () => {
          const relayName = env.RELAY_NAME || relayHostname(selfRelayUrl);
          if (isKademliaEnabled(env)) {
            await heartbeatKademlia(env, selfRelayUrl, { connections: livePeers.size });
            return;
          }

          await upsertRelay(env.DB, selfRelayUrl, relayName).catch(() => {});
          const hubUrl = env.GLOBAL_RELAY_URL || DEFAULT_HUB_URL;
          // Skip registering with hub if we ARE the hub
          if (normalizeRelayUrl(hubUrl) !== selfRelayUrl) {
            await registerWithHub(
              { ...env, GLOBAL_RELAY_URL: hubUrl, RELAY_NAME: relayName },
              selfRelayUrl
            ).catch(() => {});
          }
        })());
      }
    }

    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      // Browsers preflight cross-origin API calls; a 405 here made Safari
      // report the whole request as blocked by access control.
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Accept",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    if (upgrade && upgrade.toLowerCase() === "websocket") {
      if (url.pathname !== "/ws") {
        return jsonResponse({ ok: false, error: "WebSocket endpoint is /ws" }, 404);
      }
      const coordinator = relayCoordinatorStub(env);
      if (coordinator) return coordinator.fetch(request);
      return handleWebSocket(request, env, ctx, selfRelayUrl);
    }

    if (url.pathname === "/ws") {
      return jsonResponse({ ok: false, error: "Expected WebSocket upgrade on /ws" }, 426);
    }

    if (url.pathname === "/health") {
      const coordinator = relayCoordinatorStub(env);
      if (coordinator) return coordinator.fetch(request);
      return jsonResponse({
        ok: true,
        version: WORKER_VERSION,
        protocol_version: PSP_VERSION,
        peers: livePeers.size,
        relay_url: selfRelayUrl,
        relay_peer_id: resolveRelayPeerId(env.RELAY_PEER_ID, selfRelayUrl),
        kademlia_enabled: isKademliaEnabled(env),
        federation_hub: selfRelayUrl
          ? normalizeRelayUrl(env.GLOBAL_RELAY_URL || DEFAULT_HUB_URL)
          : null
      }, 200);
    }

    if (url.pathname.startsWith("/api/v1/kad/")) {
      return handleKademliaRequest(request, env, {
        selfUrl: selfRelayUrl,
        connections: livePeers.size,
      });
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

    if (url.pathname === "/debug/state") {
      const coordinator = relayCoordinatorStub(env);
      if (coordinator) return coordinator.fetch(request);
      return jsonResponse({ ok: false, error: "No coordinator" }, 404);
    }
    if (url.pathname === "/api/v1/relay") {
      if (request.method === "POST") {
        const coordinator = relayCoordinatorStub(env);
        if (coordinator) return coordinator.fetch(request);
        return handleRelayForward(request, env);
      }
      return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
    }

    return env.ASSETS?.fetch(request) ?? new Response("Not Found", { status: 404 });
  }
};

// Cloudflare may run an HTTP federation request in a different Worker isolate
// from the destination WebSocket. A single Durable Object per relay owns both
// entry points so a live peer can receive offers, answers, and ICE immediately
// instead of waiting for its next ping to drain D1.
export class RelayCoordinator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // Work queued before a restart is still in storage; make sure an alarm
    // exists to drain it.
    state.blockConcurrencyWhile(async () => {
      const pending = await state.storage.list({ prefix: DEFERRED_TASK_PREFIX, limit: 1 });
      if (pending.size > 0 && (await state.storage.getAlarm()) === null) {
        await state.storage.setAlarm(Date.now());
      }
    }).catch(() => {});
  }

  async alarm() {
    await drainDeferredTasks(this.state, this.env);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const upgrade = request.headers.get("Upgrade");
    const selfRelayUrl = resolveSelfRelayUrl(request, this.env.RELAY_URL);

    if (upgrade && upgrade.toLowerCase() === "websocket" && url.pathname === "/ws") {
      return handleWebSocket(request, this.env, this.state, selfRelayUrl);
    }
    if (url.pathname === "/api/v1/relay" && request.method === "POST") {
      return handleRelayForward(request, this.env);
    }
    if (url.pathname === "/debug/state") {
      const now = Date.now();
      return jsonResponse({
        ok: true,
        now,
        peers: livePeers.size,
        peerKeys: [...livePeers.keys()].map((key) => key.slice(0, 80)),
        hints: [...peerRelayHints.entries()].map(([key, hint]) => ({ key: key.slice(0, 80), url: hint.url, expiresIn: hint.expiresAt - now })),
        trail: debugTrail.slice(-Number(url.searchParams.get("limit") || 60)),
      }, 200);
    }
    if (url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        version: WORKER_VERSION,
        protocol_version: PSP_VERSION,
        peers: livePeers.size,
        relay_url: selfRelayUrl,
        relay_peer_id: resolveRelayPeerId(this.env.RELAY_PEER_ID, selfRelayUrl),
        kademlia_enabled: isKademliaEnabled(this.env),
        federation_hub: selfRelayUrl
          ? normalizeRelayUrl(this.env.GLOBAL_RELAY_URL || DEFAULT_HUB_URL)
          : null,
        coordinated: true,
      }, 200);
    }
    return jsonResponse({ ok: false, error: "Not Found" }, 404);
  }
}

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
  const viaRelayUrl = typeof body?.via === "string" && /^wss?:\/\//.test(body.via)
    ? normalizeRelayUrl(body.via)
    : null;
  if (viaRelayUrl) {
    rememberPeerRelayHint(message.network, room, message.from, viaRelayUrl);
  }
  const liveKey = peerScopeKey(message.network, room, message.to);
  const live = livePeers.get(liveKey);
  if (live) {
    try {
      live.socket.send(JSON.stringify(message));
      console.log(`[FED-IN] ${message.type} ${message.from?.slice(0, 8)} → ${message.to?.slice(0, 8)} from ${viaRelayUrl}: delivered to live socket`);
      return jsonResponse({ ok: true, delivered: true }, 200);
    } catch (error) {
      console.log(`[FED-IN] ${message.type} ${message.from?.slice(0, 8)} → ${message.to?.slice(0, 8)} from ${viaRelayUrl}: live socket send failed (${error?.message})`);
    }
  } else {
    console.log(`[FED-IN] ${message.type} ${message.from?.slice(0, 8)} → ${message.to?.slice(0, 8)} from ${viaRelayUrl}: not live here (${livePeers.size} live); queued`);
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

// A Deploy to Cloudflare flow does not know the account's workers.dev
// subdomain in advance. Derive it from the first HTTPS request unless an
// explicit RELAY_URL was configured. Local HTTP development stays unfederated.
function resolveSelfRelayUrl(request, configuredUrl) {
  const configured = normalizeRelayUrl(configuredUrl);
  if (configured) return configured;

  try {
    const requestUrl = new URL(request.url);
    if (requestUrl.protocol !== "https:") return null;
    if (!requestUrl.hostname.toLowerCase().endsWith(".workers.dev")) return null;
    return `wss://${requestUrl.host}/ws`;
  } catch {
    return null;
  }
}

function relayHostname(relayUrl) {
  try {
    return new URL(relayUrl).hostname;
  } catch {
    return null;
  }
}

function resolveRelayPeerId(configuredPeerId, selfRelayUrl) {
  const configured = typeof configuredPeerId === "string" ? configuredPeerId.trim() : "";
  if (configured) return configured;

  const hostname = relayHostname(selfRelayUrl);
  return hostname ? `bootstrap:${hostname}` : "bootstrap:local";
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
    // A relay that hangs must not hang every discover that consults it: one
    // slow provider stalled the whole federated list past the clients' probe
    // window and they switched relays instead of getting an answer.
    const resp = await fetch(`${base}/api/v1/peers?${params.toString()}`, {
      signal: AbortSignal.timeout(FEDERATED_PEER_QUERY_TIMEOUT_MS),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const peers = Array.isArray(data?.peers) ? data.peers : [];
    return peers.map(p => ({ ...p, relay_url: relayUrl }));
  } catch {
    return [];
  }
}

async function findFederatedPeers(
  env,
  selfRelayUrl,
  network,
  room,
  requesterPeerId,
  connections = 0,
  publishedScopeProviders = null,
) {
  const localPeers = env.DB
    ? await findPeers(env.DB, network, room, requesterPeerId)
    : [];

  if (!selfRelayUrl || !env.DB) return localPeers;

  let remoteUrls;
  if (isKademliaEnabled(env)) {
    const providers = Array.isArray(publishedScopeProviders)
      ? publishedScopeProviders
      : await lookupScopeProviders(
        env,
        selfRelayUrl,
        network,
        room,
        { connections },
      );
    remoteUrls = [...new Set(providers.map((provider) => provider.url))]
      .filter((relayUrl) => relayUrl !== selfRelayUrl);
  } else {
    const allRelays = await listRelays(env.DB);
    remoteUrls = allRelays.map((relay) => relay.url).filter((relayUrl) => relayUrl !== selfRelayUrl);
  }

  const remotePeers = remoteUrls.length
    ? (await Promise.all(
      remoteUrls.map((relayUrl) => queryRelayForPeers(relayUrl, network, room, requesterPeerId)),
    )).flat()
    : [];

  const peers = mergeDiscoveredPeers(localPeers, remotePeers)
    .filter((peer) => peer.peer_id !== requesterPeerId);
  for (const peer of peers) {
    if (peer?.relay_url) {
      rememberPeerRelayHint(network, room, peer.peer_id, peer.relay_url);
    }
  }
  return peers;
}

async function discoverJoiningPeer({ discover, publish, send }) {
  const eagerDiscovery = discover();
  const publication = publish();
  const eagerPeers = await eagerDiscovery;

  if (eagerPeers.length > 0) {
    send(eagerPeers);
    await publication;
    return eagerPeers;
  }

  const publishedScopeProviders = await publication;
  const peers = await discover(publishedScopeProviders);
  if (peers.length > 0) send(peers);
  return peers;
}

// Forward a PSP message through a remote relay's HTTP endpoint.
async function forwardToRelayResult(relayUrl, message, selfRelayId) {
  try {
    const base = relayHttpBase(relayUrl);
    const response = await fetch(`${base}/api/v1/relay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, via: selfRelayId || "relay-bridge" })
    });
    // Cloudflare counts unread response bodies as active outbound requests.
    // Offer/answer/ICE bursts can otherwise exhaust that limit and deadlock
    // the WebSocket request that is forwarding the negotiation.
    const bytes = await response.arrayBuffer();
    let outcome = "delivered";
    if (!response.ok) {
      outcome = "failed";
    } else {
      try {
        const result = JSON.parse(new TextDecoder().decode(bytes));
        if (result?.delivered === true) outcome = "delivered";
        else if (result?.queued === true) outcome = "queued";
        else if (result?.delivered === false) outcome = "failed";
      } catch {
        // Legacy relay versions returned an empty success response.
      }
    }
    console.log(`[FED] ${message.type} ${message.from?.slice(0, 8)} → ${message.to?.slice(0, 8)} via ${relayUrl}: ${outcome} (${response.status})`);
    return outcome;
  } catch (error) {
    console.log(`[FED] ${message.type} ${message.from?.slice(0, 8)} → ${message.to?.slice(0, 8)} via ${relayUrl}: fetch failed (${error?.message})`);
    return "failed";
  }
}

export async function forwardToRelay(relayUrl, message, selfRelayId) {
  return (await forwardToRelayResult(relayUrl, message, selfRelayId)) === "delivered";
}

export async function forwardFederatedMessage(
  env,
  selfRelayUrl,
  network,
  room,
  message,
  connections = 0,
) {
  const attempted = new Set();
  const queued = new Set();
  const hintedRelay = getPeerRelayHint(network, room, message.to);
  if (hintedRelay && hintedRelay !== selfRelayUrl) {
    attempted.add(hintedRelay);
    const result = await forwardToRelayResult(hintedRelay, message, selfRelayUrl);
    if (result === "delivered") return true;
    if (result === "queued") queued.add(hintedRelay);
  }

  const kademliaEnabled = isKademliaEnabled(env);
  let remoteUrls;
  let providerUrls = new Set();
  if (kademliaEnabled) {
    const providers = await lookupPeerProviders(
      env,
      selfRelayUrl,
      network,
      room,
      message.to,
      { connections },
    );
    providerUrls = new Set(providers.map((provider) => provider.url));
    remoteUrls = [...providerUrls]
      .filter((relayUrl) => relayUrl !== selfRelayUrl && !attempted.has(relayUrl))
      .slice(0, KADEMLIA_FORWARD_LIMIT);
  } else {
    remoteUrls = (await getPeerRelayUrls(env.DB, selfRelayUrl))
      .filter((relayUrl) => !attempted.has(relayUrl));
  }
  // A queued result is authoritative only when Kademlia identifies that relay
  // as a provider for the destination peer. A stale discovery hint must not
  // prevent the provider lookup from finding a new live route.
  if (kademliaEnabled) {
    if ([...queued].some((relayUrl) => providerUrls.has(relayUrl))) return true;
  }

  if (!remoteUrls.length) return false;
  const results = await Promise.all(remoteUrls.map(async (relayUrl) => ({
    relayUrl,
    result: await forwardToRelayResult(relayUrl, message, selfRelayUrl),
  })));
  const delivered = results.find(({ result }) => result === "delivered");
  if (delivered) {
    rememberPeerRelayHint(network, room, message.to, delivered.relayUrl);
    return true;
  }
  if (kademliaEnabled && results.some(({ result }) => result === "queued")) {
    return true;
  }
  return false;
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

function sendPeerList(socket, network, room, peers, to = null, from = "bootstrap:local") {
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

function createRegistrationAck(message, relayPeerId = "bootstrap:local") {
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
async function broadcastPeerList(db, network, room, relayPeerId) {
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
      sendPeerList(socket, network, room, peers, null, relayPeerId);
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
  await db.prepare(`DELETE FROM psp_kad_nodes WHERE expires_at_ms <= ?1`).bind(now).run();
  await db.prepare(`DELETE FROM psp_kad_records WHERE expires_at_ms <= ?1`).bind(now).run();
}

// ===================== WebSocket Handler =====================

function handleWebSocket(request, env, ctx, selfRelayUrl) {
  const { 0: client, 1: server } = new WebSocketPair();
  const relayPeerId = resolveRelayPeerId(env.RELAY_PEER_ID, selfRelayUrl);
  const socketGeneration = ++nextSocketGeneration;

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

    const releasedLivePeer = deleteLivePeerIfOwned(livePeers, key, server);
    peerKey = null;
    peerId = null;
    network = null;
    room = null;

    // A replaced socket can close after its successor has already announced.
    // Only the socket that still owns this peer ID may delete the shared lease.
    if (env.DB && releasedLivePeer) {
      deferWork(ctx, env, { kind: "peer-left", network: currentNetwork, room: currentRoom, peerId: currentPeerId, selfRelayUrl })
        .catch(() => {});
    }

    return subscriberScope;
  }

  server.addEventListener("message", async (event) => {
    try {
      const result = await handleClientMessage(
        server,
        event.data,
        env,
        ctx,
        selfRelayUrl,
        socketGeneration,
        peerKey,
        network,
        room
      );
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
          from: relayPeerId, to: "client",
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

async function handleClientMessage(
  socket,
  rawData,
  env,
  ctx,
  selfRelayUrl,
  socketGeneration,
  prevPeerKey = null,
  prevNetwork = null,
  prevRoom = null
) {
  try {
    const relayPeerId = resolveRelayPeerId(env.RELAY_PEER_ID, selfRelayUrl);
    if (!rawData) return null;
    if (rawData.length > MAX_MESSAGE_SIZE) return null;

    let message;
    try { 
      message = JSON.parse(rawData); 
    } catch (e) {
      socket.send(JSON.stringify({
        psp_version: PSP_VERSION, type: "error",
        from: relayPeerId, to: "client",
        body: { error: "Invalid JSON" }
      }));
      return null;
    }

    if (!validEnvelope(message)) {
      socket.send(JSON.stringify({
        psp_version: PSP_VERSION, type: "error",
        from: relayPeerId, to: message?.from || "unknown",
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
        from: relayPeerId,
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

    // Reconnects reuse a peer ID. A late ping/close from the replaced socket
    // must never reclaim or remove the newer socket's live route.
    const ownsLivePeer = claimLivePeer(livePeers, peerKey, {
      peerId,
      network,
      room,
      socket,
      socketGeneration,
      lastSeen: Date.now(),
    });
    if (!ownsLivePeer) {
      try { socket.close(4001, "replaced_socket"); } catch {}
      return { peerKey, network, room, peerId };
    }

    if (type === "announce") {
      const isHeartbeat = prevPeerKey === peerKey;

      // Registration is complete only after the relay has accepted the
      // announcement. Clients use this ACK to begin discovery and signaling.
      socket.send(JSON.stringify(createRegistrationAck(
        message,
        relayPeerId
      )));

      // The registry write, queued deliveries, provider publication and the
      // joining peer's discovery all leave the runtime; they run on the
      // coordinator's alarm, never on this socket's request.
      await deferWork(ctx, env, { kind: "announce", network, room, peerId, selfRelayUrl, message, isHeartbeat });

    } else if (type === "withdraw") {
      const releasedLivePeer = deleteLivePeerIfOwned(livePeers, peerKey, socket);
      if (db && releasedLivePeer) {
        await deferWork(ctx, env, { kind: "peer-left", network, room, peerId, selfRelayUrl });
      }

    } else if (type === "discover") {
      await deferWork(ctx, env, { kind: "discover", network, room, peerId, selfRelayUrl });

    } else if (type === "ext" && message.body?.action === "relay_list") {
      // Remote relay is sharing its known relay list — cache any new entries
      if (db) {
        await deferWork(ctx, env, { kind: "relay-list", network, room, peerId, selfRelayUrl, relays: message.body.relays || [] });
      }

    } else if (type === "ping") {
      socket.send(JSON.stringify({
        psp_version: PSP_VERSION, type: "pong", network,
        session_id: room,
        from: relayPeerId, to: peerId,
        message_id: crypto.randomUUID(), timestamp: Date.now(),
        ttl_ms: DEFAULT_TTL_MS, body: {}
      }));
      if (db) {
        await deferWork(ctx, env, { kind: "deliver-queued", network, room, peerId, selfRelayUrl });
      }

    } else if (type === "bye") {
      const releasedLivePeer = deleteLivePeerIfOwned(livePeers, peerKey, socket);
      if (db && releasedLivePeer) {
        await deferWork(ctx, env, { kind: "peer-left", network, room, peerId, selfRelayUrl });
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

      // Not here: route it through the peer's relay. A learned route is tried
      // first, Kademlia is the fallback, and an unreachable peer's message is
      // queued — all on the coordinator's alarm, off this socket's request.
      if (!deliveredLive) {
        await deferWork(ctx, env, { kind: "forward", network, room, peerId, selfRelayUrl, message });
      }
    }

    if (db && Date.now() - lastCleanupAt > CLEANUP_INTERVAL_MS) {
      lastCleanupAt = Date.now();
      await deferWork(ctx, env, { kind: "cleanup", network, room, peerId, selfRelayUrl });
    }
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

export {
  createRegistrationAck,
  discoverJoiningPeer,
  normalizeRoom,
  peerScopeKey,
  resolveRelayPeerId,
  resolveSelfRelayUrl,
  scopeKey,
  validEnvelope
};
