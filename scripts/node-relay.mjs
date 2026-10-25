#!/usr/bin/env node
// A freertc relay under Node that runs the SAME relay code as the Cloudflare
// worker (src/index.js): announcements, discovery, forwarding and Kademlia
// federation, with D1 on a local SQLite file and WebSockets through `ws`.
// One process is one relay, so the worker's single-isolate mode applies and
// no Durable Object is needed.
//
// Environment:
//   PORT, HOST                 where to listen (default 127.0.0.1:8788)
//   RELAY_URL                  this relay's public ws(s):// URL (required for federation)
//   RELAY_NAME                 display name
//   KADEMLIA_BOOTSTRAP_URLS    comma-separated relays to join through
//   RELAY_IDENTITY_SECRET      signing identity; generated and kept in the data dir if unset
//   FREERTC_DATA_DIR           where the database and identity live (default ./.freertc-relay)
//   PUNCH_RENDEZVOUS_URL       also accept hole-punched connections through this rendezvous
//   PUNCH_LISTENER_ID          the id to register there
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { installWebSocketPair, serverSocketOf } from '../src/node/websocket-pair.js';
import { openSqliteD1 } from '../src/node/d1-sqlite.js';

installWebSocketPair();
const { default: worker } = await import('../src/index.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8788);
const DATA_DIR = path.resolve(process.env.FREERTC_DATA_DIR || path.join(process.cwd(), '.freertc-relay'));
const PUBLIC_DIR = path.join(ROOT, 'public');
mkdirSync(DATA_DIR, { recursive: true });

async function relayIdentitySecret() {
  if (process.env.RELAY_IDENTITY_SECRET) return process.env.RELAY_IDENTITY_SECRET;
  const file = path.join(DATA_DIR, 'relay-identity.json');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const { generateRandomPair } = await import('unsea');
  const { encodeRelayIdentitySecret } = await import('../src/relay-identity.js');
  const pair = await generateRandomPair();
  const secret = encodeRelayIdentitySecret(pair.pub, pair.priv);
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const ASSETS = {
  async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    const file = path.join(PUBLIC_DIR, pathname.endsWith('/') ? `${pathname}index.html` : pathname);
    if (!file.startsWith(PUBLIC_DIR) || !existsSync(file) || !statSync(file).isFile()) return new Response('Not Found', { status: 404 });
    return new Response(readFileSync(file), { headers: { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' } });
  },
};

const env = {
  DB: await openSqliteD1({ filename: path.join(DATA_DIR, 'relay.sqlite'), migrationsDir: path.join(ROOT, 'migrations') }),
  RELAY_URL: process.env.RELAY_URL || `ws://${HOST}:${PORT}/ws`,
  RELAY_NAME: process.env.RELAY_NAME || `freertc-node-${HOST}-${PORT}`,
  KADEMLIA_BOOTSTRAP_URLS: process.env.KADEMLIA_BOOTSTRAP_URLS || '',
  RELAY_IDENTITY_SECRET: await relayIdentitySecret(),
  ASSETS,
};
const ctx = { waitUntil: (work) => { Promise.resolve(work).catch((error) => console.error('[node-relay] background task failed:', error?.message || error)); } };

function toRequest(req, body) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  return new Request(`http://${req.headers.host || `${HOST}:${PORT}`}${req.url}`, {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
  });
}

async function writeResponse(res, response) {
  const headers = {};
  response.headers.forEach((value, name) => { headers[name] = value; });
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const response = await worker.fetch(toRequest(req, chunks.length ? Buffer.concat(chunks) : undefined), env, ctx);
    await writeResponse(res, response);
  } catch (error) {
    console.error('[node-relay] request failed:', error?.stack || error);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Relay error' }));
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', async (req, socket, head) => {
  try {
    const response = await worker.fetch(toRequest(req), env, ctx);
    const serverSocket = serverSocketOf(response);
    if (!serverSocket) {
      socket.end(`HTTP/1.1 ${response.status} ${response.statusText || 'Error'}\r\nConnection: close\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => serverSocket.attach(ws));
  } catch (error) {
    console.error('[node-relay] upgrade failed:', error?.stack || error);
    socket.destroy();
  }
});

// A hole-punched channel is handed to the worker exactly as a WebSocket
// upgrade would be, so it gets the same relay, discovery and federation.
if (process.env.PUNCH_RENDEZVOUS_URL) {
  const { listenForPunches } = await import('../src/punch/transport.js');
  const listenerId = process.env.PUNCH_LISTENER_ID || `freertc-${crypto.randomUUID()}`;
  listenForPunches({
    rendezvousUrl: process.env.PUNCH_RENDEZVOUS_URL,
    listenerId,
    name: env.RELAY_NAME,
    log: (line) => console.log(`[node-relay:punch] ${line}`),
    onSocket: async (socket) => {
      const upgrade = new Request(`${env.RELAY_URL.replace(/^ws/, 'http')}`, { headers: { Upgrade: 'websocket' } });
      const response = await worker.fetch(upgrade, env, ctx);
      const serverSocket = serverSocketOf(response);
      if (serverSocket) serverSocket.attach(socket);
      else socket.close();
    },
  });
  console.log(`[node-relay] accepting punched connections as ${listenerId}`);
}

server.listen(PORT, HOST, () => {
  console.log(`[node-relay] ${env.RELAY_NAME} on http://${HOST}:${PORT} (relay ${env.RELAY_URL})`);
  console.log(`[node-relay] federation: ${env.KADEMLIA_BOOTSTRAP_URLS ? `bootstrap ${env.KADEMLIA_BOOTSTRAP_URLS}` : 'no bootstrap configured'}; data in ${DATA_DIR}`);
});
