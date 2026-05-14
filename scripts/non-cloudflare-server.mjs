#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PSP_VERSION = '1.0';
const DEFAULT_TTL_MS = 30_000;
const MAX_TTL_MS = 120_000;
const MAX_MESSAGE_SIZE = 64 * 1024;
const MAX_BATCH = 50;

const DISCOVERY_TYPES = new Set(['announce', 'withdraw', 'discover', 'peer_list', 'redirect']);
const NEGOTIATION_TYPES = new Set(['connect_request', 'connect_accept', 'connect_reject', 'offer', 'answer', 'ice_candidate', 'ice_end', 'renegotiate']);
const CONTROL_TYPES = new Set(['ping', 'pong', 'bye', 'error', 'ack']);
const EXTENSION_TYPES = new Set(['ext']);
const MESSAGE_TYPES = new Set([...DISCOVERY_TYPES, ...NEGOTIATION_TYPES, ...CONTROL_TYPES, ...EXTENSION_TYPES]);

const RELAY_TYPES = new Set([
  'connect_request', 'connect_accept', 'connect_reject',
  'offer', 'answer', 'ice_candidate', 'ice_end', 'renegotiate',
  'bye', 'error', 'ack', 'ext', 'peer_list', 'redirect'
]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8788);

const livePeers = new Map(); // network:peerId -> { socket, peerId, network, lastSeen }
const networkSubscribers = new Map(); // network -> Set<WebSocket>
const announcements = new Map(); // network:peerId -> { sessionId, expiresAtMs, updatedAtMs }
const relayQueue = new Map(); // network:toPeerId -> [{ id, message, expiresAtMs, createdAtMs }]

let relayMessageId = 1;

function makePeerKey(network, peerId) {
  return `${network}:${peerId}`;
}

function normalizeTtl(ttlMs) {
  const value = Number(ttlMs);
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_TTL_MS;
  }
  return Math.min(value, MAX_TTL_MS);
}

function json(res, body, status = 200) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function validEnvelope(msg) {
  return (
    typeof msg === 'object' && msg !== null &&
    msg.psp_version === PSP_VERSION &&
    typeof msg.type === 'string' && MESSAGE_TYPES.has(msg.type) &&
    typeof msg.from === 'string' && msg.from.trim() &&
    typeof msg.network === 'string' && msg.network.trim() &&
    typeof msg.message_id === 'string' &&
    typeof msg.timestamp === 'number'
  );
}

function cleanExpired() {
  const now = Date.now();

  for (const [key, row] of announcements.entries()) {
    if (row.expiresAtMs <= now) {
      announcements.delete(key);
      livePeers.delete(key);
    }
  }

  for (const [queueKey, entries] of relayQueue.entries()) {
    const remaining = entries.filter((item) => item.expiresAtMs > now);
    if (remaining.length === 0) {
      relayQueue.delete(queueKey);
    } else {
      relayQueue.set(queueKey, remaining);
    }
  }
}

function listPeers(network, requesterPeerId = null) {
  const now = Date.now();
  const out = [];
  for (const [key, row] of announcements.entries()) {
    const [rowNetwork, rowPeerId] = key.split(':');
    if (rowNetwork !== network || row.expiresAtMs <= now) {
      continue;
    }
    if (requesterPeerId && rowPeerId === requesterPeerId) {
      continue;
    }
    out.push({
      peer_id: rowPeerId,
      session_id: row.sessionId,
      timestamp: row.updatedAtMs
    });
    if (out.length >= MAX_BATCH) {
      break;
    }
  }
  out.sort((a, b) => a.peer_id.localeCompare(b.peer_id));
  return out;
}

function sendSafe(socket, payloadObj) {
  try {
    socket.send(JSON.stringify(payloadObj));
    return true;
  } catch {
    return false;
  }
}

function sendPeerList(network) {
  const sockets = networkSubscribers.get(network);
  if (!sockets || sockets.size === 0) {
    return;
  }
  const peers = listPeers(network);
  const message = {
    psp_version: PSP_VERSION,
    type: 'peer_list',
    network,
    from: 'bootstrap-relay',
    to: null,
    message_id: crypto.randomUUID(),
    timestamp: Date.now(),
    ttl_ms: DEFAULT_TTL_MS,
    body: { peers }
  };

  for (const socket of sockets) {
    if (socket.readyState !== socket.OPEN) {
      sockets.delete(socket);
      continue;
    }
    sendSafe(socket, message);
  }
}

function queueRelayMessage(message) {
  const key = makePeerKey(message.network, message.to);
  const now = Date.now();
  const ttl = normalizeTtl(message.ttl_ms);
  const list = relayQueue.get(key) || [];
  list.push({
    id: relayMessageId++,
    message,
    createdAtMs: now,
    expiresAtMs: now + ttl
  });
  relayQueue.set(key, list);
}

function deliverQueued(network, peerId, socket) {
  const key = makePeerKey(network, peerId);
  const queue = relayQueue.get(key) || [];
  if (queue.length === 0) {
    return 0;
  }

  const now = Date.now();
  const fresh = [];
  let delivered = 0;
  for (const item of queue) {
    if (item.expiresAtMs <= now) {
      continue;
    }
    if (delivered < MAX_BATCH && sendSafe(socket, item.message)) {
      delivered += 1;
    } else {
      fresh.push(item);
    }
  }

  if (fresh.length === 0) {
    relayQueue.delete(key);
  } else {
    relayQueue.set(key, fresh);
  }

  return delivered;
}

function upsertAnnouncement(message) {
  const key = makePeerKey(message.network, message.from);
  const now = Date.now();
  const ttl = normalizeTtl(message.ttl_ms);
  announcements.set(key, {
    sessionId: message.session_id || null,
    expiresAtMs: now + ttl,
    updatedAtMs: now
  });
}

function cleanupSocketState(socket) {
  const state = socket.__peerState;
  if (!state?.network || !state.peerId) {
    return;
  }

  const { network, peerId } = state;
  const key = makePeerKey(network, peerId);
  announcements.delete(key);
  livePeers.delete(key);

  const sockets = networkSubscribers.get(network);
  if (sockets) {
    sockets.delete(socket);
    if (sockets.size === 0) {
      networkSubscribers.delete(network);
    }
  }

  socket.__peerState = null;
  sendPeerList(network);
}

function subscribeSocket(socket, network) {
  const previous = socket.__peerState?.network;
  if (previous && previous !== network) {
    const oldSet = networkSubscribers.get(previous);
    if (oldSet) {
      oldSet.delete(socket);
      if (oldSet.size === 0) {
        networkSubscribers.delete(previous);
      }
    }
  }

  if (!networkSubscribers.has(network)) {
    networkSubscribers.set(network, new Set());
  }
  networkSubscribers.get(network).add(socket);
}

function attachSocketHandlers(socket) {
  socket.__peerState = null;

  socket.on('message', (raw) => {
    cleanExpired();

    const rawString = raw.toString();
    if (!rawString || rawString.length > MAX_MESSAGE_SIZE) {
      return;
    }

    let message;
    try {
      message = JSON.parse(rawString);
    } catch {
      sendSafe(socket, {
        psp_version: PSP_VERSION,
        type: 'error',
        from: 'relay',
        to: 'client',
        body: { error: 'Invalid JSON' }
      });
      return;
    }

    if (!validEnvelope(message)) {
      sendSafe(socket, {
        psp_version: PSP_VERSION,
        type: 'error',
        from: 'relay',
        to: message?.from || 'unknown',
        body: { error: 'Invalid PSP envelope' }
      });
      return;
    }

    const { network, from: peerId, type } = message;
    const key = makePeerKey(network, peerId);
    const previousKey = socket.__peerState ? makePeerKey(socket.__peerState.network, socket.__peerState.peerId) : null;

    subscribeSocket(socket, network);
    socket.__peerState = { network, peerId };
    livePeers.set(key, { socket, network, peerId, lastSeen: Date.now() });

    if (type === 'announce') {
      upsertAnnouncement(message);
      deliverQueued(network, peerId, socket);

      const isHeartbeat = previousKey === key;
      if (!isHeartbeat) {
        sendPeerList(network);
      }
      return;
    }

    if (type === 'withdraw' || type === 'bye') {
      announcements.delete(key);
      livePeers.delete(key);
      sendPeerList(network);
      return;
    }

    if (type === 'discover') {
      sendPeerList(network);
      return;
    }

    if (type === 'ping') {
      sendSafe(socket, {
        psp_version: PSP_VERSION,
        type: 'pong',
        network,
        from: 'relay',
        to: peerId,
        message_id: crypto.randomUUID(),
        timestamp: Date.now(),
        ttl_ms: DEFAULT_TTL_MS,
        body: {}
      });
      deliverQueued(network, peerId, socket);
      return;
    }

    if (RELAY_TYPES.has(type) && message.to) {
      const targetKey = makePeerKey(network, message.to);
      const live = livePeers.get(targetKey);
      if (live && live.socket.readyState === live.socket.OPEN && sendSafe(live.socket, message)) {
        return;
      }
      queueRelayMessage(message);
    }
  });

  socket.on('close', () => cleanupSocketState(socket));
  socket.on('error', () => cleanupSocketState(socket));
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  return 'application/octet-stream';
}

function serveStatic(req, res) {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = decodeURIComponent(reqUrl.pathname);
  if (pathname === '/') {
    pathname = '/index.html';
  }

  const requested = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!requested.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (!fs.existsSync(requested) || fs.statSync(requested).isDirectory()) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  const body = fs.readFileSync(requested);
  res.writeHead(200, { 'Content-Type': contentType(requested), 'Content-Length': body.length });
  res.end(body);
}

const server = createServer((req, res) => {
  cleanExpired();

  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (reqUrl.pathname === '/health') {
    json(res, { ok: true, version: PSP_VERSION, peers: livePeers.size }, 200);
    return;
  }

  if (reqUrl.pathname === '/ws') {
    json(res, { ok: false, error: 'Expected WebSocket upgrade on /ws' }, 426);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    json(res, { ok: false, error: 'Method not allowed' }, 405);
    return;
  }

  serveStatic(req, res);
});

const wss = new WebSocketServer({ noServer: true });
wss.on('connection', (socket) => attachSocketHandlers(socket));

server.on('upgrade', (req, socket, head) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (reqUrl.pathname !== '/ws') {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

setInterval(cleanExpired, 5000).unref();

server.listen(PORT, HOST, () => {
  console.log(`[node-relay] listening on http://${HOST}:${PORT}`);
  console.log(`[node-relay] ws endpoint ws://${HOST}:${PORT}/ws`);
});
