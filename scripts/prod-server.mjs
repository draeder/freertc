#!/usr/bin/env node

import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { loadEnv, validateProdConfig } from './validate-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

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

const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_FILE = path.join(ROOT, 'config.local-prod.json');

let config = null;
const livePeers = new Map();
const networkSubscribers = new Map();
const announcements = new Map();
const relayQueue = new Map();
let relayMessageId = 1;

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error('❌ Configuration file not found. Run: npm run config:gen');
    process.exit(1);
  }

  config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  return config;
}

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
    if (rowNetwork !== network || row.expiresAtMs <= now) continue;
    if (requesterPeerId && rowPeerId === requesterPeerId) continue;

    out.push({
      peer_id: rowPeerId,
      session_id: row.sessionId
    });
  }

  return out;
}

function handleHttpRequest(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (pathname === '/' || pathname === '/index.html') {
    const indexPath = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(indexPath)) {
      return res.end(fs.readFileSync(indexPath, 'utf-8'));
    }
    return res.end('<h1>FreeRTC Local Production Relay</h1>');
  }

  if (pathname === '/health' || pathname === '/healthz') {
    return json(res, { status: 'ok', relay: config.relayName });
  }

  if (pathname === '/config') {
    return json(res, {
      relay_peer_id: config.relayPeerId,
      relay_name: config.relayName,
      relay_url: config.relayUrl,
      global_relay_url: config.globalRelayUrl,
      timestamp: Date.now()
    });
  }

  res.writeHead(404);
  res.end('Not found');
}

function handleWsMessage(socket, data) {
  try {
    const msg = JSON.parse(data);

    if (!validEnvelope(msg)) {
      socket.send(JSON.stringify({
        type: 'error',
        message: 'Invalid message envelope',
        timestamp: Date.now()
      }));
      return;
    }

    const peerKey = makePeerKey(msg.network, msg.from);

    switch (msg.type) {
      case 'announce': {
        const ttlMs = normalizeTtl(msg.ttl_ms);
        const expiresAtMs = Date.now() + ttlMs;

        announcements.set(peerKey, {
          sessionId: msg.session_id || null,
          expiresAtMs,
          updatedAtMs: Date.now()
        });

        livePeers.set(peerKey, {
          socket,
          peerId: msg.from,
          network: msg.network,
          lastSeen: Date.now()
        });

        // Notify network subscribers
        const subscribers = networkSubscribers.get(msg.network) || new Set();
        for (const sub of subscribers) {
          if (sub.readyState === 1) {
            try {
              sub.send(JSON.stringify({
                type: 'peer_announced',
                peer_id: msg.from,
                network: msg.network,
                timestamp: Date.now()
              }));
            } catch (e) {
              // Ignore send errors
            }
          }
        }

        socket.send(JSON.stringify({
          type: 'ack',
          message_id: msg.message_id,
          timestamp: Date.now()
        }));
        break;
      }

      case 'discover': {
        const peers = listPeers(msg.network, msg.from);
        socket.send(JSON.stringify({
          type: 'peer_list',
          peers,
          network: msg.network,
          message_id: msg.message_id,
          timestamp: Date.now()
        }));
        break;
      }

      default:
        // Relay message to recipient if present
        if (RELAY_TYPES.has(msg.type) && msg.to) {
          const toKey = makePeerKey(msg.network, msg.to);
          const toPeer = livePeers.get(toKey);

          if (toPeer && toPeer.socket.readyState === 1) {
            try {
              toPeer.socket.send(JSON.stringify(msg));
              socket.send(JSON.stringify({
                type: 'ack',
                message_id: msg.message_id,
                timestamp: Date.now()
              }));
            } catch (e) {
              socket.send(JSON.stringify({
                type: 'error',
                message: 'Delivery failed',
                timestamp: Date.now()
              }));
            }
          } else {
            // Queue message
            const queueKey = toKey;
            const queue = relayQueue.get(queueKey) || [];
            queue.push({
              id: relayMessageId++,
              message: msg,
              expiresAtMs: Date.now() + 30000,
              createdAtMs: Date.now()
            });
            relayQueue.set(queueKey, queue);

            socket.send(JSON.stringify({
              type: 'ack',
              message_id: msg.message_id,
              queued: true,
              timestamp: Date.now()
            }));
          }
        }
    }
  } catch (err) {
    console.error('Message handling error:', err);
  }
}

function startServer() {
  loadConfig();

  console.log('\n🚀 Starting FreeRTC Local Production Relay');
  console.log('─'.repeat(50));
  console.log(`📋 Configuration: ${CONFIG_FILE}`);
  console.log(`🌐 Domain:       ${config.domain}`);
  console.log(`🔗 Relay URL:    ${config.relayUrl}`);
  console.log(`👤 Peer ID:      ${config.relayPeerId}`);
  console.log(`📛 Relay Name:   ${config.relayName}`);
  console.log(`🖥️  Host:         ${config.host}:${config.port}`);
  console.log(`🔒 TLS:          ${fs.existsSync(path.join(ROOT, config.tlsCertPath)) ? 'enabled' : 'disabled'}`);
  console.log('─'.repeat(50) + '\n');

  let server;

  // Check if TLS certificates exist
  const certPath = path.join(ROOT, config.tlsCertPath);
  const keyPath = path.join(ROOT, config.tlsKeyPath);

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    const httpsOptions = {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath)
    };
    server = https.createServer(httpsOptions, handleHttpRequest);
    console.log('✓ HTTPS server created with TLS certificates');
  } else {
    server = createServer(handleHttpRequest);
    console.log('⚠️  HTTP server created (no TLS certificates found)');
    console.log('   For production, generate certificates or set up reverse proxy');
  }

  const wss = new WebSocketServer({ server });

  wss.on('connection', (socket, req) => {
    const clientIp = req.socket.remoteAddress;
    console.log(`✓ Client connected: ${clientIp}`);

    socket.on('message', (data) => {
      handleWsMessage(socket, data);
    });

    socket.on('close', () => {
      console.log(`✗ Client disconnected: ${clientIp}`);
      // Clean up peer records for this socket
      for (const [key, peer] of livePeers.entries()) {
        if (peer.socket === socket) {
          livePeers.delete(key);
          announcements.delete(key);
        }
      }
    });

    socket.on('error', (err) => {
      console.error(`⚠️  WebSocket error from ${clientIp}:`, err.message);
    });
  });

  // Clean expired entries periodically
  setInterval(cleanExpired, 10000);

  server.listen(config.port, config.host, () => {
    const protocol = fs.existsSync(certPath) && fs.existsSync(keyPath) ? 'wss' : 'ws';
    console.log(`\n✅ Server listening on ${protocol}://${config.host}:${config.port}`);
    console.log(`   Relay URL: ${config.relayUrl}`);
    console.log(`   Health:    https://${config.domain}/health`);
    console.log(`   Config:    https://${config.domain}/config\n`);
  });

  server.on('error', (err) => {
    console.error('Server error:', err);
    process.exit(1);
  });

  process.on('SIGINT', () => {
    console.log('\n\n👋 Shutting down gracefully...');
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => {
      process.exit(1);
    }, 5000);
  });
}

startServer();
