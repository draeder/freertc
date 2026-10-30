#!/usr/bin/env node
// A freertc relay under Node that runs the SAME relay code as the Cloudflare
// worker (src/index.js): announcements, discovery, forwarding and Kademlia
// federation, with D1 on a local SQLite file and WebSockets through `ws`.
// One process is one relay, so the worker's single-isolate mode applies and
// no Durable Object is needed.
//
// Environment:
//   FREERTC_FEDERATION         on (default) | off — off runs a standalone relay
//   FREERTC_PUBLIC             true (default) | false — a public relay joins the
//                              public relays and never federates a loopback or
//                              private address, its own or another's; false is a
//                              private/LAN mesh where local addresses are allowed
//   PORT, HOST                 where to listen (default 0.0.0.0:8788: this machine and its LAN;
//                              HOST=127.0.0.1 keeps it to this machine)
//   RELAY_URL                  this relay's ws(s):// URL as others reach it
//                              (default wss://PROD_DOMAIN/ws, else ws://HOST:PORT/ws, with 127.0.0.1 for 0.0.0.0)
//   RELAY_NAME                 display name
//   KADEMLIA_BOOTSTRAP_URLS    comma-separated relays to join through (public
//                              default: the public relays; private default: none)
//   RELAY_IDENTITY_SECRET      signing identity; generated and kept in the data dir if unset
//   FREERTC_DATA_DIR           where the database and identity live (default ./.freertc-relay)
//   DB_PATH                    database file (default <data dir>/relay.sqlite)
//   TLS_CERT_PATH, TLS_KEY_PATH  serve HTTPS/WSS with this certificate
//   PROD_DOMAIN                host[:port] this relay is served as
//   FREERTC_TUNNEL             on (default) | off — a public relay whose own address is
//                              loopback/private (behind NAT) gets a public one through a
//                              tunnel to a public relay: wss://<home>/t/<node id>/ws
//   FREERTC_TUNNEL_HOMES       comma-separated relays to tunnel through, tried in order
//                              (default: the bootstrap relays)
//   FREERTC_PUNCH              on (default) | off — accept punched connections: a client posts
//                              its offer to POST /api/v1/punch/offer (through the tunnel when
//                              behind NAT) and talks to this relay over a direct data channel;
//                              needs WebRTC (the optional werift dependency)
//   RELAY_KIND                 local (default) | cloud — what this relay tells clients it is
//   FREERTC_LINKS              on (default) | off — link to other local relays (punched data
//                              channels, or the LAN) and send federation calls to them over the
//                              link instead of out through a cloud tunnel home
//   FREERTC_LAN                on (default) | off — find relays on this network by UDP broadcast
//                              (only when HOST is a LAN address, e.g. 0.0.0.0; never loopback)
//   FREERTC_LAN_PORT           UDP port for LAN beacons (default 41235)
//   PUNCH_RENDEZVOUS_URL       also accept hole-punched connections through this rendezvous
//   PUNCH_LISTENER_ID          the id to register there
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WsClient, { WebSocketServer } from 'ws';
import { installWebSocketPair, serverSocketOf } from '../src/node/websocket-pair.js';
import { openSqliteD1 } from '../src/node/d1-sqlite.js';
import { createCostMeter } from '../src/node/cost-meter.js';
import { PUNCH_OFFER_PATH, createPunchOfferHandler, punchOfferAvailable } from '../src/punch/offer.js';
import { DataChannelSocket } from '../src/punch/transport.js';
import { LINK_CHANNEL_LABEL, LINK_PATH, createRelayLinks } from '../src/node/relay-links.js';
import { hasLanAddress, startLanBeacon, DEFAULT_LAN_PORT } from '../src/node/lan-beacon.js';
import { nodeDurableNamespace } from '../src/node/durable-object.js';
import { createRelayIdentity, createSignedNodeRecord, decodeRelayIdentitySecret, isPrivateRelayUrl } from '../src/relay-identity.js';
import { heartbeatKademlia, isPublicRelay, listKnownRelays, relayReachOf } from '../src/relay-overlay.js';
import { RelayTunnel } from '../src/tunnel/home.js';

// node:sqlite needs --experimental-sqlite before Node 22.13. Turn it on rather than fail.
try {
  await import('node:sqlite');
} catch {
  if (!process.execArgv.includes('--experimental-sqlite')) {
    // Run this relay again with the flag, as a child that lives and dies with
    // this process: a signal sent here (Ctrl-C, a test stopping the relay) is
    // passed on, so the child never outlives it holding the port and the
    // parent's output.
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['--experimental-sqlite', '--no-warnings', ...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
    child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
    await new Promise(() => {});
  }
  console.error('[node-relay] this Node has no node:sqlite; use Node 22.5 or later');
  process.exit(1);
}

installWebSocketPair();
const { default: worker } = await import('../src/index.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = process.env.HOST || '0.0.0.0';
// Listening on every interface lets other machines on the LAN use this relay.
// It still names itself by loopback, so its relay URL and name stay what they
// were, and a private address is never announced to public relays.
const SELF_HOST = ['0.0.0.0', '::'].includes(HOST) ? '127.0.0.1' : HOST;
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

// The public relays a public relay joins through when none are configured.
const PUBLIC_BOOTSTRAP_URLS = ['wss://peer.ooo/ws', 'wss://decentralize.ooo/ws', 'wss://oooooooooooooooooooooooooooo.ooo/ws'];
const TLS_CERT_PATH = process.env.TLS_CERT_PATH;
const TLS_KEY_PATH = process.env.TLS_KEY_PATH;
const TLS = Boolean(TLS_CERT_PATH && TLS_KEY_PATH && existsSync(TLS_CERT_PATH) && existsSync(TLS_KEY_PATH));
const isOff = (value, fallback = 'on') => ['off', 'false', '0', 'no'].includes(String(value ?? fallback).trim().toLowerCase());
const FEDERATION = !isOff(process.env.FREERTC_FEDERATION);
const TUNNEL = !isOff(process.env.FREERTC_TUNNEL);
const PUBLIC = isPublicRelay(process.env);
const RELAY_URL = process.env.RELAY_URL
  || (process.env.PROD_DOMAIN ? `${TLS ? 'wss' : 'ws'}://${process.env.PROD_DOMAIN}/ws` : `${TLS ? 'wss' : 'ws'}://${SELF_HOST}:${PORT}/ws`);
const configuredBootstrap = String(process.env.KADEMLIA_BOOTSTRAP_URLS ?? '').split(',').map((url) => url.trim()).filter(Boolean);
// A public relay never federates a loopback or private address, so it never
// joins through one either.
const bootstrap = (configuredBootstrap.length ? configuredBootstrap : (PUBLIC ? PUBLIC_BOOTSTRAP_URLS : []))
  .filter((url) => !(PUBLIC && isPrivateRelayUrl(url)));

const tunnelHomes = (String(process.env.FREERTC_TUNNEL_HOMES ?? '').split(',').map((url) => url.trim()).filter(Boolean).length
  ? String(process.env.FREERTC_TUNNEL_HOMES).split(',').map((url) => url.trim()).filter(Boolean)
  : bootstrap).filter((url) => !isPrivateRelayUrl(url));

let federationNote;
let federating = FEDERATION;
let tunneling = false;
if (!FEDERATION) {
  federationNote = 'off (FREERTC_FEDERATION=off)';
} else if (PUBLIC && isPrivateRelayUrl(RELAY_URL) && TUNNEL && tunnelHomes.length) {
  // Behind NAT: public relays can't reach ws://127.0.0.1 or a LAN address, so
  // take a public address through a tunnel. Federation starts once it is open.
  tunneling = true;
  federationNote = `public, through a tunnel (${RELAY_URL} is loopback/private; homes: ${tunnelHomes.join(', ')}), joining through ${bootstrap.join(', ')}`;
} else if (PUBLIC && isPrivateRelayUrl(RELAY_URL)) {
  // Announcing ws://127.0.0.1 or a LAN address to public relays would send them
  // to an address that reaches nobody. Stay out until there is a public one.
  federating = false;
  federationNote = `off: ${RELAY_URL} is a loopback/private address and this is a public relay${TUNNEL ? ' with no public relay to tunnel through' : ' and FREERTC_TUNNEL=off'}; set RELAY_URL to a public address, or FREERTC_PUBLIC=false for a private mesh`;
} else {
  federationNote = `${PUBLIC ? 'public' : 'private mesh'}, joining through ${bootstrap.length ? bootstrap.join(', ') : '(no bootstrap: others join through this relay)'}`;
}

// What this relay would cost as a Cloudflare worker (src/node/cost-meter.js); GET /debug/cost.
const meter = createCostMeter();
// Punched connections need WebRTC in this process (werift, an optional dependency).
const PUNCH = !isOff(process.env.FREERTC_PUNCH) && await punchOfferAvailable();
const env = {
  RELAY_KIND: process.env.RELAY_KIND === 'cloud' ? 'cloud' : 'local',
  ...(PUNCH ? { PUNCH_OFFER: 'on' } : {}),
  DB: meter.wrapD1(await openSqliteD1({ filename: path.resolve(process.env.DB_PATH || path.join(DATA_DIR, 'relay.sqlite')), migrationsDir: path.join(ROOT, 'migrations') })),
  RELAY_URL,
  RELAY_NAME: process.env.RELAY_NAME || `freertc-node-${SELF_HOST}-${PORT}`,
  FREERTC_PUBLIC: PUBLIC ? 'true' : 'false',
  KADEMLIA_BOOTSTRAP_URLS: federating ? bootstrap.join(',') : '',
  // Without an identity the worker code runs no overlay at all: that is what off means.
  ...(federating ? { RELAY_IDENTITY_SECRET: await relayIdentitySecret() } : {}),
  ASSETS,
};
// Any Node relay can be a tunnel home for relays behind NAT, as a worker can.
env.RELAY_TUNNEL = nodeDurableNamespace(RelayTunnel, env);
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

// Set once acceptSocket exists (below); requests can't arrive before the server listens.
let handlePunchOffer = null;

const handler = async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://x').pathname;
    if (pathname === PUNCH_OFFER_PATH && handlePunchOffer) {
      meter.request(req.method, pathname, false);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      await writeResponse(res, await handlePunchOffer(toRequest(req, chunks.length ? Buffer.concat(chunks) : undefined)));
      return;
    }
    if (pathname === '/debug/cost' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, relay: env.RELAY_URL, name: env.RELAY_NAME, cost: meter.snapshot() }));
      return;
    }
    meter.request(req.method, pathname, false);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const response = await worker.fetch(toRequest(req, chunks.length ? Buffer.concat(chunks) : undefined), env, ctx);
    await writeResponse(res, response);
  } catch (error) {
    console.error('[node-relay] request failed:', error?.stack || error);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Relay error' }));
  }
};
const server = TLS
  ? createTlsServer({ cert: readFileSync(TLS_CERT_PATH), key: readFileSync(TLS_KEY_PATH) }, handler)
  : createServer(handler);

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', async (req, socket, head) => {
  try {
    if (new URL(req.url, 'http://x').pathname === LINK_PATH) {
      if (!relayLinks) { socket.end('HTTP/1.1 404 No links here\r\n\r\n'); return; }
      wss.handleUpgrade(req, socket, head, (ws) => relayLinks.accept(ws, { via: 'lan' }));
      return;
    }
    meter.request(req.method, new URL(req.url, 'http://x').pathname, true);
    const response = await worker.fetch(toRequest(req), env, ctx);
    const serverSocket = serverSocketOf(response);
    if (!serverSocket) {
      socket.end(`HTTP/1.1 ${response.status} ${response.statusText || 'Error'}\r\nConnection: close\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data) => meter.wsMessage(data));
      serverSocket.attach(ws);
    });
  } catch (error) {
    console.error('[node-relay] upgrade failed:', error?.stack || error);
    socket.destroy();
  }
});

/**
 * Hand a socket that did not arrive as an HTTP upgrade (a hole-punched channel,
 * a WebSocket carried through the tunnel) to the worker exactly as an upgrade
 * would be, so it gets the same relay, discovery and federation.
 */
async function acceptSocket(socket, pathname = '/ws', headers = []) {
  const upgrade = new Request(new URL(pathname, env.RELAY_URL.replace(/^ws/, 'http')), { headers });
  upgrade.headers.set('Upgrade', 'websocket');
  const response = await worker.fetch(upgrade, env, ctx);
  const serverSocket = serverSocketOf(response);
  if (serverSocket) serverSocket.attach(socket);
  else socket.close(1011, `Relay answered ${response.status}`);
}

// Links to other local relays (src/node/relay-links.js): federation calls to
// a linked relay go over the link, not out through a cloud tunnel home.
let relayLinks = null;
const LINKS = federating && !isOff(process.env.FREERTC_LINKS);
if (LINKS) {
  const { publicKey, privateKey } = decodeRelayIdentitySecret(env.RELAY_IDENTITY_SECRET);
  const linkIdentity = await createRelayIdentity(publicKey, privateKey);
  const directFetch = globalThis.fetch;
  const PeerConnection = PUNCH ? (await import('werift')).RTCPeerConnection : null;
  const { punchRelayChannel } = await import('../src/client.js');
  relayLinks = createRelayLinks({
    identity: linkIdentity,
    nodeRecord: () => createSignedNodeRecord(linkIdentity, {
      url: env.RELAY_URL,
      name: env.RELAY_NAME,
      relayKind: env.RELAY_KIND,
      reach: relayReachOf(env, env.RELAY_URL),
    }),
    handleRequest: (request) => worker.fetch(request, env, ctx),
    dialPunch: PeerConnection
      ? async (offerUrl) => {
        const { pc, channel } = await punchRelayChannel(offerUrl, {
          PeerConnection,
          iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }],
          fetchImpl: directFetch,
          label: LINK_CHANNEL_LABEL,
        });
        return new DataChannelSocket(channel, pc, { link: true });
      }
      : null,
    dialLan: (url) => new Promise((resolve, reject) => {
      const ws = new WsClient(url);
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    }),
    listRelays: () => listKnownRelays(env, env.RELAY_URL),
    log: (line) => console.log(`[node-relay:links] ${line}`),
  });
  globalThis.fetch = relayLinks.wrapFetch(directFetch);
  setTimeout(() => relayLinks.maintain().catch(() => {}), 5_000).unref();
  const lanHost = !['127.0.0.1', 'localhost', '::1'].includes(HOST);
  if (!isOff(process.env.FREERTC_LAN) && lanHost && hasLanAddress()) {
    startLanBeacon({
      nodeId: linkIdentity.nodeId,
      port: PORT,
      lanPort: Number(process.env.FREERTC_LAN_PORT || DEFAULT_LAN_PORT),
      onRelay: (nodeId, url) => relayLinks.lanSeen(nodeId, url),
      log: (line) => console.log(`[node-relay:links] ${line}`),
    });
  }
}

if (PUNCH) {
  handlePunchOffer = createPunchOfferHandler({
    onSocket: (socket) => (socket.channel?.label === LINK_CHANNEL_LABEL && relayLinks
      ? relayLinks.accept(socket, { via: 'punch' })
      : acceptSocket(socket)),
    log: (line) => console.log(`[node-relay:punch] ${line}`),
  });
}

// The worker only heartbeats when a request comes in; a relay behind NAT may
// see none for a while, so keep its federation alive from here too.
// Say whether federation actually holds: which relays answered this relay's
// announcement, logged whenever that changes.
let federationState = null;
async function heartbeat() {
  if (!federating) return;
  const result = await heartbeatKademlia(env, env.RELAY_URL)
    .catch((error) => ({ error: error?.message || String(error) }));
  const hosts = (urls) => urls.map((url) => { try { return new URL(url).host; } catch { return url; } }).sort();
  const state = result?.error
    ? `not federated: heartbeat failed (${result.error})`
    : !result?.enabled
      ? 'not federated: federation is off for this address'
      : result.confirmed_by.length
        ? `federated as ${env.RELAY_URL}: known to ${hosts(result.confirmed_by).join(', ')}`
        : `not federated: no relay answered (asked ${hosts(result.asked).join(', ') || 'none'})`;
  if (state !== federationState) {
    federationState = state;
    console.log(`[node-relay] ${state}`);
  }
}

if (tunneling) {
  const { startTunnel } = await import('../src/tunnel/client.js');
  const { publicKey, privateKey } = decodeRelayIdentitySecret(env.RELAY_IDENTITY_SECRET);
  startTunnel({
    homes: tunnelHomes,
    identity: await createRelayIdentity(publicKey, privateKey),
    name: env.RELAY_NAME,
    handleRequest: (request) => (handlePunchOffer && new URL(request.url).pathname === PUNCH_OFFER_PATH
      ? handlePunchOffer(request)
      : worker.fetch(request, env, ctx)),
    handleStream: (socket, { path: streamPath, headers }) => acceptSocket(socket, new URL(streamPath, 'http://x').pathname, headers),
    onUrl: (url) => {
      env.RELAY_URL = url ?? RELAY_URL;
      console.log(url ? `[node-relay] joining federation as ${url}` : `[node-relay] tunnel lost; out of federation until it is back`);
      heartbeat();
      if (url) setTimeout(() => relayLinks?.maintain().catch(() => {}), 5_000).unref();
    },
    log: (line) => console.log(`${new Date().toLocaleTimeString([], { hour12: false })} [node-relay:tunnel] ${line}`),
  });
}
if (federating) setInterval(heartbeat, 2 * 60_000).unref();

if (process.env.PUNCH_RENDEZVOUS_URL) {
  const { listenForPunches } = await import('../src/punch/transport.js');
  const listenerId = process.env.PUNCH_LISTENER_ID || `freertc-${crypto.randomUUID()}`;
  listenForPunches({
    rendezvousUrl: process.env.PUNCH_RENDEZVOUS_URL,
    listenerId,
    name: env.RELAY_NAME,
    log: (line) => console.log(`[node-relay:punch] ${line}`),
    onSocket: (socket) => acceptSocket(socket),
  });
  console.log(`[node-relay] accepting punched connections as ${listenerId}`);
}

server.listen(PORT, HOST, () => {
  console.log(`[node-relay] ${env.RELAY_NAME} on ${TLS ? 'https' : 'http'}://${HOST}:${PORT} (relay ${env.RELAY_URL})`);
  console.log(`[node-relay] federation: ${federationNote}; data in ${DATA_DIR}`);
  console.log(`[node-relay] punched connections: ${PUNCH ? `on (POST ${PUNCH_OFFER_PATH})` : (isOff(process.env.FREERTC_PUNCH) ? 'off (FREERTC_PUNCH=off)' : 'off: no WebRTC here (npm install werift)')}`);
  heartbeat();
});
