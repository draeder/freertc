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
//   FREERTC_IDP                on (default) | off — keep PigeonIdP accounts for the browsers on this
//                              relay, in <data dir>/identities.json (needs the pigeonidp package),
//                              shared with the other local relays it federates with
//   FREERTC_LINKS              on (default) | off — link to other local relays (punched data
//                              channels, or the LAN) and send federation calls to them over the
//                              link instead of out through a cloud tunnel home
//   FREERTC_STATS              local (default) | public | off — the relay's dashboard at
//                              /stats (and /api/v1/stats): local answers only this machine and
//                              its network (loopback and private addresses)
//   FREERTC_PQ                 on (default) | off — give this relay a post-quantum (ML-DSA-65) key
//                              next to its P-256 one (<data dir>/relay-pq.json): links to other
//                              local relays need a hybrid proof, pinned per relay on first sight
//                              (<data dir>/relay-pins.json), and the directory pins it too
//   FREERTC_LAN                on (default) | off — find relays on this network by UDP broadcast
//                              (only when HOST is a LAN address, e.g. 0.0.0.0; never loopback)
//   FREERTC_LAN_PORT           UDP port for LAN beacons (default 41235)
//   PUNCH_RENDEZVOUS_URL       also accept hole-punched connections through this rendezvous
//   PUNCH_LISTENER_ID          the id to register there
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, createReadStream, appendFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WsClient, { WebSocketServer } from 'ws';
import { installWebSocketPair, serverSocketOf } from '../src/node/websocket-pair.js';
import { openSqliteD1 } from '../src/node/d1-sqlite.js';
import { createCostMeter } from '../src/node/cost-meter.js';
import { createRelayStats, isLocalAddress } from '../src/node/relay-stats.js';
import { STATS_PAGE } from '../src/node/stats-page.js';
import { ACCOUNT_SYNC_ACTION, ACCOUNT_SYNC_EVERY_MS, createAccountSync, createSyncRequest, verifySyncRequest } from '../src/node/account-sync.js';
import { PUNCH_OFFER_PATH, createPunchOfferHandler, punchOfferAvailable } from '../src/punch/offer.js';
import { DataChannelSocket } from '../src/punch/transport.js';
import { LINK_CHANNEL_LABEL, LINK_PATH, createRelayLinks } from '../src/node/relay-links.js';
import { hasLanAddress, startLanBeacon, DEFAULT_LAN_PORT } from '../src/node/lan-beacon.js';
import { nodeDurableNamespace } from '../src/node/durable-object.js';
import { createRelayIdentity, createSignedNodeRecord, decodeRelayIdentitySecret, isPrivateRelayUrl, tunnelNodeIdOf } from '../src/relay-identity.js';
import { heartbeatKademlia, isPublicRelay, listKnownRelays, relayReachOf } from '../src/relay-overlay.js';
import { RelayTunnel } from '../src/tunnel/home.js';
import { loadNameSettings } from '../src/node/relay-name.js';

// The relay runs as a child of this process, which restarts it when the
// machine moves to another network (exit code NETWORK_CHANGED_EXIT): a new
// LAN address, router and public address mean new port forwards, a new
// directory entry and new federation, which a running relay cannot redo in
// place. Signals are passed on, so Ctrl-C still stops it; node:sqlite gets
// --experimental-sqlite where this Node needs it (before 22.13).
const NETWORK_CHANGED_EXIT = 75;
if (!process.env.FREERTC_RELAY_CHILD) {
  const { spawn } = await import('node:child_process');
  let needsFlag = false;
  try { await import('node:sqlite'); } catch { needsFlag = !process.execArgv.includes('--experimental-sqlite'); }
  const args = [...(needsFlag ? ['--experimental-sqlite', '--no-warnings'] : []), ...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)];
  let child = null;
  let stopping = false;
  let signalled = 0;
  const start = () => {
    child = spawn(process.execPath, args, { stdio: 'inherit', env: { ...process.env, FREERTC_RELAY_CHILD: '1' } });
    child.on('exit', (code, signal) => {
      if (!stopping && code === NETWORK_CHANGED_EXIT) {
        console.log('[node-relay] restarting on the new network');
        start();
        return;
      }
      process.exit(code ?? (signal ? 1 : 0));
    });
  };
  // A second Ctrl-C ends the child at once, whatever it is doing.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => { stopping = true; signalled += 1; child?.kill(signalled > 1 ? 'SIGKILL' : signal); });
  }
  start();
  await new Promise(() => {});
}
try {
  await import('node:sqlite');
} catch {
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
// The relay's own numbers for its dashboard (src/node/relay-stats.js); GET /stats.
const STATS_MODE = ['public', 'off'].includes(String(process.env.FREERTC_STATS || '').trim().toLowerCase())
  ? String(process.env.FREERTC_STATS).trim().toLowerCase()
  : 'local';
const stats = createRelayStats();
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
// Relays behind NAT reached through this one, as their federation URLs:
// always asked for a room's peers, like linked relays (src/index.js).
env.HOSTED_RELAY_URLS = () => {
  const urls = [];
  let base = null;
  try { base = new URL(String(env.RELAY_URL)); } catch { return urls; }
  for (const [nodeId, object] of env.RELAY_TUNNEL.instances) {
    if (!/^[0-9a-f]{64}$/.test(nodeId) || !object?.tunnelSocket?.()) continue;
    urls.push(`${base.protocol}//${base.host}/t/${nodeId}/ws`);
  }
  return urls;
};
// No peer is connected to a relay that has just started: forget the room
// announcements the last run left in its database. Kept, they were listed
// to other relays (and so to browsers) as present until they expired, and
// browsers dialled dozens of peers that were gone before the live ones.
try {
  const cleared = await env.DB.prepare('DELETE FROM psp_announcements').run();
  const n = Number(cleared?.meta?.changes ?? cleared?.changes ?? 0);
  if (n) console.log(`[node-relay] forgot ${n} peer announcement${n === 1 ? '' : 's'} left from the last run`);
} catch {
  // a new database has no table yet
}
let accountsShared = false;
let accountStore = null;
// What happened with accounts between relays, for the dashboard and for
// whoever has to find out why an account did not arrive: kept in memory and
// appended to <data dir>/relay-events.log (rolled over at 1 MB).
const EVENTS_FILE = path.join(DATA_DIR, 'relay-events.log');
const relayEvents = [];
function relayEvent(text) {
  const line = `${new Date().toISOString()} ${text}`;
  relayEvents.push(line);
  if (relayEvents.length > 200) relayEvents.shift();
  try {
    if (existsSync(EVENTS_FILE) && statSync(EVENTS_FILE).size > 1_048_576) renameSync(EVENTS_FILE, `${EVENTS_FILE}.1`);
    appendFileSync(EVENTS_FILE, `${line}\n`);
  } catch { /* the log is a convenience */ }
}
stats.setEvents(() => relayEvents.slice(-60));
// Accounts: a local relay is a PigeonIdP server for the browsers connected to
// it, keeping signed account records in DATA_DIR/identities.json so they
// survive restarts (pigeonidp/relay). On unless FREERTC_IDP=off.
if (!isOff(process.env.FREERTC_IDP)) {
  try {
    const { createRelayIdentityStore } = await import('pigeonidp/relay');
    const store = await createRelayIdentityStore({
      dataDir: DATA_DIR,
      log: (line) => console.log(`[node-relay:accounts] ${line}`),
      onEvent: (text) => relayEvent(`accounts: ${text}`),
      // Shared with the other local relays this one federates with (never
      // the cloud relays): their POST /api/v1/idp. Looked up on each use, as
      // federation comes up after this; fetch is the relay's own, so linked
      // relays are reached over their link.
      fetch: (url, init) => {
        try { stats.accountOutbound(JSON.parse(String(init?.body ?? '{}'))); } catch { /* not ours to count */ }
        return globalThis.fetch(url, init);
      },
      otherRelays: federating
        ? async () => (await listKnownRelays(env, env.RELAY_URL).catch(() => []))
          .filter((relay) => relay.relay_kind === 'local' && relay.url && relay.url !== env.RELAY_URL)
          .map((relay) => relay.url.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/ws$/, ''))
        : null,
    });
    // Counted for the dashboard: requests from browsers and other relays, and
    // what this store asks of other relays.
    env.RELAY_REQUEST_HANDLER = async (body) => {
      if (body?.action === ACCOUNT_SYNC_ACTION) return answerSyncRequest(body);
      const result = await store.handle(body);
      stats.account(body, result);
      return result;
    };
    stats.setAccountCount(() => store.size());
    accountStore = store;
    relayEvent(`accounts: started with ${store.size()} kept`);
    accountsShared = federating;
    console.log(`[node-relay] accounts: kept for browsers on this relay in ${path.relative(process.cwd(), store.file) || store.file} (${store.size()} so far)`);
  } catch (error) {
    console.log(`[node-relay] accounts: off (${error?.code === 'ERR_MODULE_NOT_FOUND' ? 'pigeonidp is not installed: npm install' : error?.message || error})`);
  }
} else {
  console.log('[node-relay] accounts: off (FREERTC_IDP=off)');
}
const ctx = { waitUntil: (work) => { Promise.resolve(work).catch((error) => console.error('[node-relay] background task failed:', error?.message || error)); } };

// This relay calling itself at its own public address (a relay reached
// through it, ws://<public ip>:<port>/t/<id>/..., or its own federation
// URL) goes to localhost instead. Few routers loop a public address back
// inside, so those calls failed, and the failed forwards went round through
// the cloud relays instead: thousands of Worker and Durable Object requests.
{
  const outsideFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    try {
      const own = String(env.RELAY_URL || '');
      if (!TLS && own.startsWith('ws://') && !tunnelNodeIdOf(own)) {
        const self = new URL(own.replace(/^ws/, 'http'));
        const target = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
        if (target.host === self.host && (target.protocol === 'http:' || target.protocol === 'ws:')) {
          target.protocol = 'http:';
          target.host = `127.0.0.1:${PORT}`;
          return outsideFetch(typeof input === 'string' || input instanceof URL ? target.toString() : new Request(target.toString(), input), init);
        }
      }
    } catch {}
    return outsideFetch(input, init);
  };
}

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
  const body = Buffer.from(await response.arrayBuffer());
  res.end(body);
  return body.length;
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
    if ((pathname === '/stats' || pathname === '/api/v1/stats') && req.method === 'GET' && STATS_MODE !== 'off') {
      if (STATS_MODE === 'local' && !isLocalAddress(req.socket?.remoteAddress)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      if (pathname === '/stats') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(STATS_PAGE);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(stats.snapshot()));
      }
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
    const bodyIn = chunks.length ? Buffer.concat(chunks) : undefined;
    const response = await worker.fetch(toRequest(req, bodyIn), env, ctx);
    stats.http(bodyIn?.length ?? 0, await writeResponse(res, response));
  } catch (error) {
    // A client that hung up mid-request is not a relay error: count it.
    if (error?.message === 'aborted' || error?.code === 'ECONNRESET') {
      noteTrouble('requests the client abandoned');
      return;
    }
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
const onUpgrade = async (req, socket, head) => {
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
      noteTrouble(`upgrades refused (${response.status})`);
      socket.end(`HTTP/1.1 ${response.status} ${response.statusText || 'Error'}\r\nConnection: close\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data) => meter.wsMessage(data));
      watchLiveness(ws);
      stats.watchSocket(ws);
      serverSocket.attach(ws);
    });
  } catch (error) {
    noteTrouble('upgrades failed');
    console.error('[node-relay] upgrade failed:', error?.stack || error);
    socket.destroy();
  }
};
server.on('upgrade', onUpgrade);

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
  if (serverSocket) serverSocket.attach(stats.watchSocket(socket));
  else socket.close(1011, `Relay answered ${response.status}`);
}

// This relay's post-quantum key (src/node/relay-pq.js), when it federates.
const PQ = federating && !isOff(process.env.FREERTC_PQ);
let relayPq = null;
if (PQ) {
  const { loadRelayPqIdentity, loadRelayPins } = await import('../src/node/relay-pq.js');
  const { publicKey, privateKey } = decodeRelayIdentitySecret(env.RELAY_IDENTITY_SECRET);
  const { nodeId } = await createRelayIdentity(publicKey, privateKey);
  relayPq = { identity: loadRelayPqIdentity(DATA_DIR, { publicKey, privateKey, nodeId }), pins: loadRelayPins(DATA_DIR), required: true };
  console.log(`[node-relay] post-quantum key: ML-DSA-65 with P-256 (hybrid) for links to other local relays and the directory${relayPq.pins.size() ? ` (${relayPq.pins.size()} relay${relayPq.pins.size() === 1 ? '' : 's'} pinned)` : ''}`);
}

// The same without a link, over the ordinary federation path: this relay asks
// every local relay it knows for its whole store (signed with its own keys),
// 15 s after it starts, whenever it meets a local relay it has not synced with
// in the last 5 minutes, and every 5 minutes; and answers such requests from
// local relays it knows. So an account reaches every local relay without
// anyone having to log in.
const PULL_EVERY_MS = 5 * 60_000;
const lastPulled = new Map(); // node id -> when
async function localRelayRecords() {
  return (await listKnownRelays(env, env.RELAY_URL).catch(() => []))
    .filter((relay) => relay.relay_kind === 'local' && relay.url && relay.url !== env.RELAY_URL && relay.node_id);
}
async function answerSyncRequest(body) {
  if (!accountStore) return { ok: false, error: 'no accounts here' };
  if (body?.from_relay !== true) return { ok: false, error: 'only between relays' };
  const verdict = await verifySyncRequest(body, {
    selfUrl: env.RELAY_URL,
    knownLocalNodeIds: async () => new Set((await localRelayRecords()).map((relay) => relay.node_id)),
    pinnedPqKey: (nodeId) => relayPq?.pins?.get(nodeId) ?? null,
  });
  const who = `relay ${String(body?.node_id || '?').slice(0, 8)}`;
  if (!verdict.ok) {
    relayEvent(`accounts: refused ${who} its sync (${verdict.error})`);
    return { ok: false, error: verdict.error };
  }
  // Its post-quantum key is remembered on first sight, as a link would.
  if (typeof body.pq_public_key === 'string' && relayPq?.pins && !relayPq.pins.get(body.node_id)) relayPq.pins.set(body.node_id, body.pq_public_key);
  relayEvent(`accounts: gave ${who} all ${accountStore.size()}`);
  return { ok: true, records: accountStore.exportRecords() };
}
let syncIdentity = null;
async function pullAccountsFrom(relay) {
  syncIdentity ??= await (async () => {
    const { publicKey, privateKey } = decodeRelayIdentitySecret(env.RELAY_IDENTITY_SECRET);
    return createRelayIdentity(publicKey, privateKey);
  })();
  const who = (() => { try { return new URL(relay.url).host; } catch { return relay.url; } })();
  lastPulled.set(relay.node_id, Date.now());
  try {
    const base = relay.url.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/ws$/, '');
    const body = await createSyncRequest({ identity: syncIdentity, pqIdentity: relayPq?.identity ?? null, target: relay.url });
    const response = await globalThis.fetch(`${base}/api/v1/idp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const answer = await response.json().catch(() => null);
    if (!response.ok || !answer?.ok) {
      relayEvent(`accounts: ${who}: no sync (${answer?.error || `answered ${response.status}`})`);
      return;
    }
    const { stored } = await accountStore.importRecords(answer.records, { from: who });
    if (stored) console.log(`[node-relay] accounts: ${stored} from ${who}`);
  } catch (error) {
    relayEvent(`accounts: ${who}: no sync (${error?.name === 'TimeoutError' ? 'no answer' : error?.message || error})`);
  }
}
async function pullAccounts({ onlyNew = false } = {}) {
  if (!accountStore || !federating || !env.RELAY_IDENTITY_SECRET) return;
  for (const relay of await localRelayRecords()) {
    if (onlyNew && Date.now() - (lastPulled.get(relay.node_id) ?? 0) < PULL_EVERY_MS) continue;
    await pullAccountsFrom(relay);
  }
}
if (federating) {
  setTimeout(() => { pullAccounts().catch(() => {}); }, 15_000).unref();
  // A relay met for the first time (or again after a while) is synced within 30 s.
  setInterval(() => { pullAccounts({ onlyNew: true }).catch(() => {}); }, 30_000).unref();
}

// Accounts between linked relays (src/node/account-sync.js): each side takes
// the other's whole store when a link opens and every 10 minutes.
const accountSync = createAccountSync({
  store: () => accountStore,
  event: relayEvent,
  log: (line) => console.log(`[node-relay] ${line}`),
});

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
    // Only a linked relay (proved, and encrypted with post-quantum keys) can
    // ask for the whole account store.
    handleRequest: (request) => accountSync.handleLinkRequest(request) ?? worker.fetch(request, env, ctx),
    onLinked: (nodeId, link) => accountSync.syncOver(nodeId, link),
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
    pq: relayPq,
  });
  globalThis.fetch = relayLinks.wrapFetch(directFetch);
  setInterval(() => {
    for (const [nodeId, link] of relayLinks.links) if (link.open) accountSync.syncOver(nodeId, link);
  }, ACCOUNT_SYNC_EVERY_MS).unref();
  env.LINKED_RELAY_URLS = () => relayLinks.linkedRelayUrls();
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
stats.setLinks(() => {
  const relays = relayLinks?.linkedRelayUrls?.() ?? [];
  return { linked: relays.length, relays };
});
stats.setReach(() => ({
  name: env.RELAY_NAME,
  kind: env.RELAY_KIND,
  url: env.RELAY_URL,
  federation: federating ? (federationState || federationNote) : federationNote,
  postQuantum: Boolean(relayPq),
  accountsShared,
}));
// Say plainly what this relay's public address costs.
function howReached(url) {
  if (!tunnelNodeIdOf(url)) return ' (open port, no tunnel)';
  let host = url;
  try { host = new URL(url).host; } catch {}
  return String(url).startsWith('wss:')
    ? ` (through a cloud tunnel on ${host}: works, but every message through it counts against Cloudflare's requests)`
    : ` (reached through the relay at ${host}, no cloud)`;
}
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
        ? `federated as ${env.RELAY_URL}${howReached(env.RELAY_URL)}: known to ${hosts(result.confirmed_by).join(', ')}`
        : `not federated: no relay answered (asked ${hosts(result.asked).join(', ') || 'none'})`;
  if (state !== federationState) {
    federationState = state;
    console.log(`[node-relay] ${state}`);
  }
}

/**
 * Relays with an open port that this relay can be reached through (not this
 * one): those in the DNS directory, and those it already knows from
 * federation at a bare public address (found sooner than DNS, which caches
 * for minutes).
 */
async function directoryHomeUrls(selfNodeId) {
  if (isOff(process.env.FREERTC_DIRECTORY_HOMES)) return [];
  // Relays this one was last reached through, remembered across restarts:
  // they do not depend on DNS or on the cloud relays being up.
  const urls = [...rememberedHomes()];
  try {
    const { lookupDirectRelays } = await import('../src/direct/lookup.js');
    const records = await lookupDirectRelays({ useCache: false });
    for (const record of records) if (record.ws && record.node_id !== selfNodeId) urls.push(record.ws);
  } catch {}
  try {
    for (const relay of await listKnownRelays(env, env.RELAY_URL)) {
      const url = String(relay.url || '');
      if (relay.node_id === selfNodeId || !/^ws:\/\/\d{1,3}(\.\d{1,3}){3}:\d{1,5}\/ws$/.test(url) || isPrivateRelayUrl(url)) continue;
      urls.push(url);
    }
  } catch {}
  return [...new Set(urls)].slice(0, 3);
}

const HOMES_FILE = path.join(DATA_DIR, 'homes.json');
function rememberedHomes() {
  try {
    const list = JSON.parse(readFileSync(HOMES_FILE, 'utf8'));
    return Array.isArray(list) ? list.filter((url) => typeof url === 'string' && url.startsWith('ws://')).slice(0, 3) : [];
  } catch {
    return [];
  }
}
function rememberHome(url) {
  try {
    const home = String(url).replace(/\/t\/[0-9a-f]{64}\/ws$/, '/ws');
    if (!home.startsWith('ws://')) return;
    writeFileSync(HOMES_FILE, JSON.stringify([home, ...rememberedHomes().filter((h) => h !== home)].slice(0, 3)));
  } catch {}
}

let tunnelStarted = false;
async function openTunnel() {
  if (tunnelStarted) return;
  tunnelStarted = true;
  const { startTunnel } = await import('../src/tunnel/client.js');
  const { publicKey, privateKey } = decodeRelayIdentitySecret(env.RELAY_IDENTITY_SECRET);
  const identity = await createRelayIdentity(publicKey, privateKey);
  // Relays with an open port from the DNS directory first: reached through
  // one of them, this relay's federation and peers' signaling go with no
  // cloud relay in the way. The cloud homes come after, for when none
  // answers; every frame through them counts against Cloudflare's limit.
  const directoryHomes = await directoryHomeUrls(identity.nodeId);
  if (directoryHomes.length) console.log(`[node-relay] can be reached through these relays with an open port: ${directoryHomes.join(", ")} (cloud only if none answers)`);
  startHomeTunnel(startTunnel, identity, directoryHomes);
  // Reached through the cloud (no open-port relay answered, or one came up
  // after this relay did): look again every 30 s and move as soon as one is
  // up, so it does not matter which relay starts first. The lookups cost no
  // Worker requests (DNS-over-HTTPS, and this relay's own federation table).
  let checking = false;
  setInterval(async () => {
    if (checking) return;
    checking = true;
    try { await moveOffCloud(); } finally { checking = false; }
  }, 30_000).unref();
  async function moveOffCloud() {
    const url = tunnelHandle?.url;
    // On a relay with an open port already: nothing to do. Through the cloud,
    // or not reached at all (every home refusing): look for one.
    if (url && !url.startsWith('wss:')) return;
    const homes = await directoryHomeUrls(identity.nodeId);
    for (const home of homes) {
      const up = await fetch(home.replace(/^ws/, 'http').replace(/\/ws$/, '/health'), { signal: AbortSignal.timeout(5_000) }).then((r) => r.ok).catch(() => false);
      if (!up) continue;
      console.log(`[node-relay] ${home} is up (a relay with an open port): reaching this relay through it instead of the cloud`);
      tunnelHandle.close();
      startHomeTunnel(startTunnel, identity, homes);
      return;
    }
  }
}

let tunnelHandle = null;
function startHomeTunnel(startTunnel, identity, directoryHomes) {
  tunnelHandle = startTunnel({
    homes: [...directoryHomes, ...tunnelHomes],
    identity,
    name: env.RELAY_NAME,
    handleRequest: (request) => (handlePunchOffer && new URL(request.url).pathname === PUNCH_OFFER_PATH
      ? handlePunchOffer(request)
      : worker.fetch(request, env, ctx)),
    handleStream: (socket, { path: streamPath, headers }) => acceptSocket(socket, new URL(streamPath, 'http://x').pathname, headers),
    onUrl: (url) => {
      env.RELAY_URL = url ?? RELAY_URL;
      if (url) rememberHome(url);
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
      setTimeout(() => directRelay?.republish().catch(() => {}), 2_000).unref();
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
// How busy the relay is: the longest it took to get back to its event loop
// this minute (a relay that stalls cannot accept connections), and
// connections that failed before or during the upgrade.
let maxLoopLagMs = 0;
let lastLoopTick = Date.now();
setInterval(() => {
  const now = Date.now();
  maxLoopLagMs = Math.max(maxLoopLagMs, now - lastLoopTick - 100);
  lastLoopTick = now;
}, 100).unref();
const connectionTrouble = new Map();
const noteTrouble = (what) => connectionTrouble.set(what, (connectionTrouble.get(what) ?? 0) + 1);

setInterval(async () => {
  const lag = maxLoopLagMs;
  maxLoopLagMs = 0;
  for (const [what, count] of connectionTrouble) relayLogCounts.set(what, count);
  connectionTrouble.clear();
  if (lag > 1_000) relayLogCounts.set(`ms longest stall`, lag);
  if (!relayLogCounts?.size) return;
  const parts = [...relayLogCounts].map(([what, count]) => `${count} ${what}`);
  relayLogCounts.clear();
  const health = await worker.fetch(new Request(`http://${SELF_HOST}:${PORT}/health`), env, ctx).then((r) => r.json()).catch(() => null);
  console.log(`${new Date().toLocaleTimeString([], { hour12: false })} [node-relay] last minute: ${parts.join(', ')}${health ? `; ${health.peers} peers connected` : ''}`);
}, 60_000).unref();

// On a terminal, one status line that redraws in place every few seconds
// while the relay is healthy (it never adds lines); anything else the relay
// prints goes above it. Piped or redirected output gets no status line.
if (process.stdout.isTTY) {
  let status = '';
  const clear = () => { if (status) process.stdout.write('\r\x1b[2K'); };
  const draw = () => { if (status) process.stdout.write(status.slice(0, Math.max(20, (process.stdout.columns || 120) - 1))); };
  for (const method of ['log', 'info', 'warn', 'error']) {
    const original = console[method].bind(console);
    console[method] = (...args) => { clear(); original(...args); draw(); };
  }
  let stallMs = 0;
  setInterval(() => { stallMs = Math.max(stallMs, maxLoopLagMs); }, 100).unref();
  setInterval(async () => {
    const health = await worker.fetch(new Request(`http://${SELF_HOST}:${PORT}/health`), env, ctx).then((r) => r.json()).catch(() => null);
    const time = new Date().toLocaleTimeString([], { hour12: false });
    const stall = stallMs > 1_000 ? `, stalled ${stallMs} ms` : '';
    stallMs = 0;
    clear();
    status = health
      ? `${time} [node-relay] ${health.peers ?? 0} peers connected${stall ? stall : ', healthy'}`
      : `${time} [node-relay] not answering its own health check`;
    draw();
  }, 5_000).unref();
}

// Direct connections (src/direct): browsers reach this relay with a WebRTC data
// channel on a UDP port the router forwards, found through the DNS relay
// directory, with no cloud relay in the way. Needs node-datachannel 0.33+.
let directRelay = null;
let relayName = null;   // src/node/relay-name.js: this relay's own name and certificate
let tlsServer = null;
// On exit, withdraw from the directory and remove the router's port forwards.
// Ctrl-C always ends the relay: the cleanup gets 3 s (a router or the
// directory that does not answer must not keep it running), and a second
// Ctrl-C ends it at once.
let stopping = false;
let stoppingAt = 0;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    // Ctrl-C reaches this process twice (from the terminal and passed on by
    // the parent): only a second press, not the echo, stops it at once.
    if (stopping && Date.now() - stoppingAt > 500) process.kill(process.pid, 'SIGKILL');
    if (stopping) return;
    stopping = true;
    stoppingAt = Date.now();
    console.log('[node-relay] stopping (Ctrl-C again to stop at once)');
    setTimeout(() => process.exit(0), 3_000);
    Promise.all([directRelay?.stop().catch(() => {}), openPortMapping?.close().catch(() => {})])
      .finally(() => process.exit(0));
  });
}
// Moved to another network (the machine's IPv4 addresses changed: new
// Wi-Fi, a hotspot, a VPN): clean up as on Ctrl-C and exit with
// NETWORK_CHANGED_EXIT, and the parent starts the relay again, which redoes
// the port forwards, the directory entry and federation for the new network.
if (process.env.FREERTC_RELAY_CHILD) {
  const { networkInterfaces } = await import('node:os');
  const addresses = () => Object.values(networkInterfaces()).flat()
    .filter((entry) => entry && !entry.internal && entry.family === 'IPv4' && !entry.address.startsWith('169.254.'))
    .map((entry) => entry.address).sort().join(',');
  const startedOn = addresses();
  setInterval(() => {
    const now = addresses();
    if (now === startedOn || stopping) return;
    stopping = true;
    stoppingAt = Date.now();
    console.log(`[node-relay] the network changed (${startedOn || 'none'} -> ${now || 'none'}); restarting`);
    setTimeout(() => process.exit(NETWORK_CHANGED_EXIT), 3_000);
    Promise.all([directRelay?.stop().catch(() => {}), openPortMapping?.close().catch(() => {})])
      .finally(() => process.exit(NETWORK_CHANGED_EXIT));
  }, 10_000).unref();
}
// The direct (WebRTC) listener can stop answering while the rest of the
// relay keeps working: browsers then fail on the address the directory
// lists, and nothing said so. Every minute the relay opens a direct channel
// to itself on loopback; after two failures in a row it restarts (the parent
// starts it again), which brings the listener back.
function watchDirectListener(port, fingerprint) {
  let failures = 0;
  const check = async () => {
    if (stopping) return;
    let pc = null;
    try {
      const { RTCPeerConnection } = await import('node-datachannel/polyfill');
      const { directRelayChannel } = await import('../src/direct/dial.js');
      const opened = await directRelayChannel(`webrtc-direct://127.0.0.1:${port}/sha256/${fingerprint}`, { PeerConnection: RTCPeerConnection, timeoutMs: 8_000 });
      pc = opened.pc;
      failures = 0;
      if (process.env.FREERTC_VERBOSE === '1') console.log('[node-relay:direct] self-check: direct listener answered');
    } catch (error) {
      failures += 1;
      console.log(`${new Date().toLocaleTimeString([], { hour12: false })} [node-relay:direct] self-check: direct listener did not answer (${error?.message || error})${failures >= 2 ? '; restarting' : ''}`);
      if (failures >= 2 && !stopping) {
        stopping = true;
        stoppingAt = Date.now();
        setTimeout(() => process.exit(NETWORK_CHANGED_EXIT), 3_000);
        Promise.all([directRelay?.stop().catch(() => {}), openPortMapping?.close().catch(() => {})])
          .finally(() => process.exit(NETWORK_CHANGED_EXIT));
      }
    } finally {
      try { pc?.close(); } catch {}
    }
  };
  setInterval(() => { check().catch(() => {}); }, Number(process.env.FREERTC_DIRECT_SELFCHECK_MS || 60_000)).unref();
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
    tunnelUrl: () => (tunnelNodeIdOf(env.RELAY_URL) && String(env.RELAY_URL).startsWith('wss:') ? env.RELAY_URL : null),
    // Listed with its open TCP port, so relays behind NAT can make it their home.
    wsUrl: () => (openPortMapping ? env.RELAY_URL : null),
    // Its wss:// name once it has one (src/node/relay-name.js), so browsers can use TLS.
    name: () => relayName?.wssUrl || env.RELAY_NAME,
    acceptSocket: (socket) => acceptSocket(socket),
    pqIdentity: relayPq?.identity ?? null,
    log: (line) => console.log(`${new Date().toLocaleTimeString([], { hour12: false })} [node-relay:direct] ${line}`),
  });
  if (directRelay && process.env.FREERTC_RELAY_CHILD) watchDirectListener(Number(process.env.FREERTC_DIRECT_PORT || 9443), directRelay.fingerprint);
  })().catch((error) => console.log(`[node-relay:direct] direct connections: off (${error?.message || error})`));
}

// A name and a Let's Encrypt certificate on the owner's own domain, kept by
// the owner's Worker (src/node/relay-name.js), once `npx freertc name` has
// registered this relay there. Then it also serves wss:// (and https) on
// FREERTC_TLS_PORT (default 8443), forwarded by the router.
const nameSettings = isOff(process.env.FREERTC_NAMES) ? null : loadNameSettings(DATA_DIR);
if (nameSettings) {
  (async () => {
    const { startRelayName } = await import('../src/node/relay-name.js');
    const { mapTcpPort } = await import('../src/direct/portmap.js');
    const log = (line) => console.log(`${new Date().toLocaleTimeString([], { hour12: false })} [node-relay:name] ${line}`);
    const TLS_PORT = Number(process.env.FREERTC_TLS_PORT || 8443);
    const { publicKey, privateKey } = decodeRelayIdentitySecret(await relayIdentitySecret());
    relayName = await startRelayName({
      identity: await createRelayIdentity(publicKey, privateKey),
      dataDir: DATA_DIR,
      worker: nameSettings.worker,
      tlsPort: TLS_PORT,
      staging: process.env.FREERTC_ACME_STAGING === '1',
      mapPort: (port) => mapTcpPort({ internalPort: port, externalPort: port, description: `freertc relay tls ${port}`, log }),
      onCertificate: ({ key, cert, name }) => {
        if (tlsServer) { tlsServer.setSecureContext({ key, cert }); log('serving the renewed certificate'); return; }
        tlsServer = createTlsServer({ key, cert }, handler);
        tlsServer.on('upgrade', onUpgrade);
        tlsServer.on('clientError', (error, socket) => { noteTrouble(`tls connection errors (${error?.code || 'client'})`); try { socket.destroy(); } catch {} });
        tlsServer.on('error', (error) => log(`tls server: ${error?.code || error?.message || error}`));
        tlsServer.listen(TLS_PORT, HOST, () => log(`serving wss://${name}:${TLS_PORT}/ws and https://${name}:${TLS_PORT}/stats`));
      },
      onAddress: (url) => {
        if (url) log(`directory: listing ${url}`);
        directRelay?.republish?.().catch?.(() => {});
      },
      log,
    });
  })().catch((error) => console.log(`[node-relay:name] names: off (${error?.message || error})`));
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

server.on('clientError', (error, socket) => {
  noteTrouble(`connection errors (${error?.code || 'client'})`);
  try { socket.destroy(); } catch {}
});
server.on('error', (error) => noteTrouble(`server errors (${error?.code || 'unknown'})`));
server.listen(PORT, HOST, () => {
  console.log(`[node-relay] ${env.RELAY_NAME} on ${TLS ? 'https' : 'http'}://${HOST}:${PORT} (relay ${env.RELAY_URL})`);
  if (STATS_MODE !== 'off') {
    console.log(`[node-relay] stats: ${TLS ? 'https' : 'http'}://${['0.0.0.0', '::'].includes(HOST) ? 'localhost' : HOST}:${PORT}/stats (${STATS_MODE === 'public' ? 'open to anyone' : 'this machine and its network only'})`);
  }
  console.log(`[node-relay] federation: ${federationNote}; data in ${DATA_DIR}`);
  console.log(`[node-relay] punched connections: ${PUNCH ? `accepted when a peer asks for one, introduced through this relay's public address (POST ${PUNCH_OFFER_PATH})` : (isOff(process.env.FREERTC_PUNCH) ? 'off (FREERTC_PUNCH=off)' : 'off: no WebRTC here (npm install werift)')}`);
  heartbeat();
  if (tunneling) {
    (OPEN_PORT ? openPublicPort() : Promise.resolve(false))
      .catch((error) => { console.log(`[node-relay:open-port] ${error?.message || error}; using a tunnel`); return false; })
      .then((open) => (open ? null : openTunnel()));
  }
});
