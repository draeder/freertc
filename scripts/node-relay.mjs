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
//   FREERTC_DIRECT             on (default) | off — accept direct WebRTC connections from browsers
//                              on a UDP port the router forwards (UPnP / NAT-PMP), listed in the
//                              DNS relay directory (needs node-datachannel 0.33+)
//   FREERTC_DIRECT_PORT        UDP port for direct connections (default 9443)
//   FREERTC_DIRECT_PUBLIC_IP   this machine's public address, when no router needs asking
//   FREERTC_DIRECTORY_URL      the cloud relay that keeps the directory (default: the tunnel home)
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
import { createRelayIdentity, createSignedNodeRecord, decodeRelayIdentitySecret, isPrivateRelayUrl, tunnelNodeIdOf } from '../src/relay-identity.js';
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
const { default: worker, relayLogCounts } = await import('../src/index.js');

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
// Federate on this machine's public address, through a port the router
// forwards, instead of a tunnel (FREERTC_OPEN_PORT=off for the tunnel only).
const OPEN_PORT = !isOff(process.env.FREERTC_OPEN_PORT) && !process.env.RELAY_URL && !process.env.PROD_DOMAIN;
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
  // Behind NAT: public relays can't reach ws://127.0.0.1 or a LAN address.
  // First ask the router to forward this port (OPEN_PORT below); if it won't,
  // or relays still can't reach it, take a public address through a tunnel.
  // Federation starts once there is a public address.
  tunneling = true;
  federationNote = OPEN_PORT
    ? `public: asking the router to forward tcp ${PORT} so relays reach this one with no tunnel (a tunnel through ${tunnelHomes.join(', ')} if not), joining through ${bootstrap.join(', ')}`
    : `public, through a tunnel (${RELAY_URL} is loopback/private; homes: ${tunnelHomes.join(', ')}), joining through ${bootstrap.join(', ')}`;
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
  ...(process.env.FREERTC_VERBOSE ? { FREERTC_VERBOSE: process.env.FREERTC_VERBOSE } : {}),
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

// A peer that vanishes without closing (a killed process, a sleeping laptop,
// a router that drops the connection) leaves a socket the system may not
// report closed for minutes, and the relay kept counting and routing to it.
// Ping every socket; one that has not answered within LIVENESS_TIMEOUT_MS is
// closed, which removes the peer from its room at once.
const LIVENESS_PING_MS = 15_000;
const LIVENESS_TIMEOUT_MS = 30_000;
const watchedSockets = new Set();
function watchLiveness(ws) {
  ws.lastHeardAt = Date.now();
  const heard = () => { ws.lastHeardAt = Date.now(); };
  ws.on('pong', heard);
  ws.on('message', heard);
  ws.on('close', () => watchedSockets.delete(ws));
  watchedSockets.add(ws);
}
setInterval(() => {
  const now = Date.now();
  for (const ws of watchedSockets) {
    if (now - ws.lastHeardAt > LIVENESS_TIMEOUT_MS) {
      watchedSockets.delete(ws);
      try { ws.terminate(); } catch {}
      continue;
    }
    try { ws.ping(); } catch {}
  }
}, LIVENESS_PING_MS).unref();
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
      watchLiveness(ws);
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
  // Not federated yet: still getting a public address (open port or tunnel).
  if (PUBLIC && isPrivateRelayUrl(env.RELAY_URL)) return;
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

let tunnelStarted = false;
async function openTunnel() {
  if (tunnelStarted) return;
  tunnelStarted = true;
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
      if (url) setTimeout(() => directRelay?.republish().catch(() => {}), 2_000).unref();
      console.log(url ? `[node-relay] joining federation as ${url}` : `[node-relay] tunnel lost; out of federation until it is back`);
      heartbeat();
      if (url) setTimeout(() => relayLinks?.maintain().catch(() => {}), 5_000).unref();
    },
    log: (line) => console.log(`${new Date().toLocaleTimeString([], { hour12: false })} [node-relay:tunnel] ${line}`),
  });
}

// The open port: forward tcp PORT on the router, check that a public relay can
// call this relay there, and federate as ws://<public ip>:<port>/ws. Relays
// call it straight (from a Worker, over a TCP socket); no tunnel is opened.
let openPortMapping = null;
async function openPublicPort() {
  const log = (line) => console.log(`${new Date().toLocaleTimeString([], { hour12: false })} [node-relay:open-port] ${line}`);
  const { mapTcpPort, isNonPublicIPv4 } = await import('../src/direct/portmap.js');
  const { REACHABLE_PATH } = await import('../src/direct/reachable.js');
  const mapping = await mapTcpPort({ internalPort: PORT, externalPort: PORT, description: `freertc relay ${PORT}`, log });
  if (!mapping) { log('no router answered UPnP or NAT-PMP; using a tunnel'); return false; }
  if (isNonPublicIPv4(mapping.externalIp)) {
    log(`the router's own address ${mapping.externalIp} is not public (carrier-grade NAT or a second router); using a tunnel`);
    await mapping.close().catch(() => {});
    return false;
  }
  const url = `ws://${mapping.externalIp}:${mapping.externalPort}/ws`;
  const { publicKey, privateKey } = decodeRelayIdentitySecret(env.RELAY_IDENTITY_SECRET);
  const { nodeId } = await createRelayIdentity(publicKey, privateKey);
  for (const home of tunnelHomes) {
    try {
      const response = await fetch(new URL(REACHABLE_PATH, home.replace(/^ws/, 'http')), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: mapping.externalPort, node_id: nodeId }),
        signal: AbortSignal.timeout(10_000),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result) continue; // that relay can't check yet; ask the next
      if (result.ip && result.ip !== mapping.externalIp) {
        log(`relays see this machine at ${result.ip}, the router says ${mapping.externalIp}; using a tunnel`);
        break;
      }
      if (!result.reachable) {
        log(`router forwards tcp ${mapping.externalIp}:${mapping.externalPort}, but ${new URL(home).host} could not reach it (${result.why || 'no answer'}); a firewall on this machine may be blocking port ${PORT}. Using a tunnel`);
        break;
      }
      openPortMapping = mapping;
      env.RELAY_URL = url;
      log(`router forwards tcp ${mapping.externalIp}:${mapping.externalPort} here (${mapping.method}) and ${new URL(home).host} reached it: no tunnel`);
      console.log(`[node-relay] joining federation as ${url}`);
      heartbeat();
      setTimeout(() => relayLinks?.maintain().catch(() => {}), 5_000).unref();
      return true;
    } catch (error) {
      log(`${new URL(home).host}: ${error?.message || error}`);
    }
  }
  await mapping.close().catch(() => {});
  return false;
}

if (federating) setInterval(heartbeat, 2 * 60_000).unref();

// One line a minute instead of one per message passed on (FREERTC_VERBOSE=1
// for every message).
setInterval(async () => {
  if (!relayLogCounts?.size) return;
  const parts = [...relayLogCounts].map(([what, count]) => `${count} ${what}`);
  relayLogCounts.clear();
  const health = await worker.fetch(new Request(`http://${SELF_HOST}:${PORT}/health`), env, ctx).then((r) => r.json()).catch(() => null);
  console.log(`${new Date().toLocaleTimeString([], { hour12: false })} [node-relay] last minute: ${parts.join(', ')}${health ? `; ${health.peers} peers connected` : ''}`);
}, 60_000).unref();

// Direct connections (src/direct): browsers reach this relay with a WebRTC data
// channel on a UDP port the router forwards, found through the DNS relay
// directory, with no cloud relay in the way. Needs node-datachannel 0.33+.
let directRelay = null;
// On exit, withdraw from the directory and remove the router's port forwards.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await Promise.all([directRelay?.stop().catch(() => {}), openPortMapping?.close().catch(() => {})]);
    process.exit(0);
  });
}
if (!isOff(process.env.FREERTC_DIRECT)) {
  // Set up in the background: asking the router takes a few seconds and the
  // relay serves its own address meanwhile.
  (async () => {
  const { startDirectRelay } = await import('../src/direct/node-relay-direct.js');
  // The identity signs the directory entry. A relay that does not federate is
  // not listed, so any identity will do there.
  const { publicKey, privateKey } = env.RELAY_IDENTITY_SECRET
    ? decodeRelayIdentitySecret(env.RELAY_IDENTITY_SECRET)
    : await (async () => { const { generateRandomPair } = await import('unsea'); const pair = await generateRandomPair(); return { publicKey: pair.pub, privateKey: pair.priv }; })();
  const home = process.env.FREERTC_DIRECTORY_URL || (tunnelHomes[0] || bootstrap[0] || '').replace(/^ws/, 'http').replace(/\/ws$/, '');
  directRelay = await startDirectRelay({
    identity: await createRelayIdentity(publicKey, privateKey),
    dataDir: DATA_DIR,
    port: Number(process.env.FREERTC_DIRECT_PORT || 9443),
    // Listed in the directory only when this relay federates publicly.
    directoryUrl: federating && PUBLIC ? (home || null) : null,
    publicIp: process.env.FREERTC_DIRECT_PUBLIC_IP || null,
    tunnelUrl: () => (tunnelNodeIdOf(env.RELAY_URL) ? env.RELAY_URL : null),
    name: env.RELAY_NAME,
    acceptSocket: (socket) => acceptSocket(socket),
    log: (line) => console.log(`${new Date().toLocaleTimeString([], { hour12: false })} [node-relay:direct] ${line}`),
  });
  })().catch((error) => console.log(`[node-relay:direct] direct connections: off (${error?.message || error})`));
}

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
  if (tunneling) {
    (OPEN_PORT ? openPublicPort() : Promise.resolve(false))
      .catch((error) => { console.log(`[node-relay:open-port] ${error?.message || error}; using a tunnel`); return false; })
      .then((open) => (open ? null : openTunnel()));
  }
});
