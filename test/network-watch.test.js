// A watch (/watch?network=…) hears who is in a network's rooms on the relay, then each change as it happens:
// on a Worker's hibernating coordinator and on a Node relay. Nothing is asked again on a timer.
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { RelayCoordinator } from '../src/index.js';
import { networkSnapshot, watchedNetworks } from '../src/network-watch.js';
import { installWebSocketPair, serverSocketOf } from '../src/node/websocket-pair.js';
import { MemoryD1 } from './harness/memory-d1.js';

installWebSocketPair();

class Socket extends EventEmitter {
  constructor() { super(); this.got = []; }
  send(data) { this.got.push(typeof data === 'string' && data.startsWith('{') ? JSON.parse(data) : data); }
  close(code, reason) { this.emit('close', code, Buffer.from(reason || '')); }
}

function objectState(current) {
  const data = new Map();
  let alarm = null;
  let auto = null;
  const sockets = new Set();
  const state = {
    accepted: 0,
    storage: {
      async put(key, value) { data.set(key, structuredClone(value)); },
      async get(key) { return data.get(key); },
      async delete(keys) { for (const k of [].concat(keys)) data.delete(k); },
      async list({ prefix = '', limit = Infinity } = {}) {
        return new Map([...data].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).slice(0, limit));
      },
      async getAlarm() { return alarm; },
      async setAlarm(at) { alarm = at; },
      async deleteAlarm() { alarm = null; },
    },
    blockConcurrencyWhile: (fn) => fn(),
    acceptWebSocket(socket) {
      state.accepted += 1;
      sockets.add(socket);
      socket.addEventListener('message', (event) => current().webSocketMessage(socket, event.data));
      socket.addEventListener('close', (event) => { sockets.delete(socket); return current().webSocketClose(socket, event.code, event.reason); });
    },
    getWebSockets: () => [...sockets],
    setWebSocketAutoResponse(pair) { auto = pair; },
    getWebSocketAutoResponse() { return auto; },
    get auto() { return auto; },
  };
  return state;
}

let seq = 0;
const envelope = (from, type, room, extra = {}) => JSON.stringify({
  psp_version: '1.0', type, network: 'app', session_id: room, from,
  message_id: `m${++seq}`, timestamp: Date.now(), ttl_ms: 60_000, ...extra,
});
const announce = (from, room, role) => envelope(from, 'announce', room, { body: { instance_id: 'app', capabilities: role ? { role } : {} } });
const tick = () => new Promise((r) => setTimeout(r, 30));
const events = (socket) => socket.got.filter((m) => m && typeof m === 'object' && m.t);

test('a watch hears who is in every room of its network, then each change, through hibernation', async () => {
  const env = { DB: new MemoryD1(), RELAY_URL: 'wss://watch.example/ws' };
  let object;
  const state = objectState(() => object);
  object = new RelayCoordinator(state, env);
  const open = async (url) => {
    const response = await object.fetch(new Request(url, { headers: { Upgrade: 'websocket' } }));
    if (response.status !== 101) return { status: response.status };
    const socket = new Socket();
    serverSocketOf(response).attach(socket);
    return socket;
  };

  const a = await open('https://watch.example/ws');
  a.emit('message', announce('peer-a', 'main'));
  await tick();

  const watch = await open('https://watch.example/watch?network=app&network=other');
  assert.equal(state.accepted, 2, 'the watch is hibernatable too (acceptWebSocket)');
  assert.ok(state.auto, 'its "ping" is answered without waking the coordinator');
  const first = events(watch);
  assert.deepEqual(first.find((m) => m.network === 'app'), { t: 'peers', network: 'app', peers: [{ id: 'peer-a', room: 'main' }] });
  assert.deepEqual(first.find((m) => m.network === 'other'), { t: 'peers', network: 'other', peers: [] });

  // Another room of the same network, with a role: told at once.
  const b = await open('https://watch.example/ws');
  b.emit('message', announce('peer-b', 'side-room', 'storage'));
  await tick();
  assert.deepEqual(events(watch).at(-1), { t: 'join', network: 'app', id: 'peer-b', room: 'side-room', role: 'storage' });

  // Its other messages (heartbeats, pings) tell nothing more.
  const before = events(watch).length;
  b.emit('message', envelope('peer-b', 'ping', 'side-room'));
  b.emit('message', announce('peer-b', 'side-room', 'storage'));
  await tick();
  assert.equal(events(watch).length, before, 'no change, nothing told');

  // Hibernation: a new object, the same sockets. Rebuilding tells nobody anything; changes are still told.
  object = new RelayCoordinator(state, env);
  const c = await open('https://watch.example/ws');
  c.emit('message', announce('peer-c', 'main'));
  await tick();
  const sinceWake = events(watch).slice(before);
  assert.deepEqual(sinceWake, [{ t: 'join', network: 'app', id: 'peer-c', room: 'main' }], 'only the new peer, after waking');

  // A peer that lets go of the relay because its mesh is healthy is resting, with when its lease ends.
  c.emit('message', envelope('peer-c', 'withdraw', 'main', { body: { reason: 'relay_idle' } }));
  await tick();
  const rest = events(watch).at(-1);
  assert.equal(rest.t, 'rest');
  assert.equal(rest.id, 'peer-c');
  assert.ok(rest.until > Date.now() + 9 * 60_000, 'a lease of about ten minutes');
  // A new watch sees it resting.
  const later = await open('https://watch.example/watch?network=app');
  const snap = events(later)[0];
  assert.ok(snap.peers.some((p) => p.id === 'peer-c' && p.rest), 'resting in the snapshot');

  // A peer that closes is gone.
  a.close(1000, 'bye');
  await tick();
  assert.deepEqual(events(watch).at(-1), { t: 'leave', network: 'app', id: 'peer-a', room: 'main' });

  // A closed watch is told nothing more and frees its place.
  watch.close(1000, 'done');
  await tick();
  const told = watch.got.length;
  b.close(1000, 'bye');
  await tick();
  assert.equal(watch.got.length, told);
  assert.equal(events(later).at(-1).id, 'peer-b', 'the other watch still hears');

  // What a watch asks for is checked.
  assert.equal((await open('https://watch.example/watch')).status, 400);
  assert.equal((await open('https://watch.example/watch?network=bad%20name')).status, 400);
});

test('peers that let go of the relay are known by name from their neighbour on it, and go when it stops naming them', async () => {
  const env = { DB: new MemoryD1(), RELAY_URL: 'wss://watch.example/ws' };
  let object;
  const state = objectState(() => object);
  object = new RelayCoordinator(state, env);
  const open = async (url) => {
    const response = await object.fetch(new Request(url, { headers: { Upgrade: 'websocket' } }));
    const socket = new Socket();
    serverSocketOf(response).attach(socket);
    return socket;
  };
  const members = (from, room, ids) => envelope(from, 'ext', room, { body: { action: 'members', ids } });
  const anchor = await open('https://watch.example/ws');
  anchor.emit('message', announce('anchor', 'temp'));
  const other = await open('https://watch.example/ws');
  other.emit('message', announce('other', 'temp'));
  await tick();
  const watch = await open('https://watch.example/watch?network=app');
  const seen = () => events(watch).slice(1).map((m) => `${m.t} ${m.id}@${m.room}`);

  // The anchor names its neighbours: the one with no socket here comes, by name.
  anchor.emit('message', members('anchor', 'temp', ['other', 'resting-1']));
  await tick();
  assert.deepEqual(seen(), ['join resting-1@temp']);
  // A neighbour that lets go of the relay while named is still in the room: nothing is told.
  other.emit('message', envelope('other', 'withdraw', 'temp', { body: { reason: 'relay_idle' } }));
  other.close(1000, 'relay_idle'); // as the client does: it withdraws, then closes its socket
  await tick();
  assert.deepEqual(seen(), ['join resting-1@temp'], 'no rest, no leave: it is named');
  // A new watch sees all three.
  const late = await open('https://watch.example/watch?network=app');
  assert.deepEqual(events(late)[0].peers.filter((p) => p.room === 'temp').map((p) => p.id).sort(), ['anchor', 'other', 'resting-1']);
  // Through hibernation the names are kept (with the anchor's socket), and nobody is told anything again.
  object = new RelayCoordinator(state, env);
  anchor.emit('message', envelope('anchor', 'ping', 'temp'));
  await tick();
  const later = await open('https://watch.example/watch?network=app');
  assert.deepEqual(events(later)[0].peers.filter((p) => p.room === 'temp').map((p) => p.id).sort(), ['anchor', 'other', 'resting-1']);
  // One leaves the mesh: the anchor stops naming it, and it is gone at once.
  anchor.emit('message', members('anchor', 'temp', ['other']));
  await tick();
  assert.equal(seen().at(-1), 'leave resting-1@temp');
  // The anchor itself goes: it and the peers only it named.
  anchor.close(1000, 'bye');
  await tick();
  assert.deepEqual(seen().slice(-2).sort(), ['leave anchor@temp', 'leave other@temp']);
});

test('watchedNetworks and networkSnapshot', () => {
  assert.deepEqual(watchedNetworks(new URL('https://x/watch?network=a&network=a&network=b')), { networks: ['a', 'b'] });
  assert.ok(watchedNetworks(new URL(`https://x/watch?${Array.from({ length: 21 }, (_, i) => `network=n${i}`).join('&')}`)).error);
  const live = new Map([['k1', { peerId: 'p1', network: 'n', room: 'r1', role: null }], ['k2', { peerId: 'p2', network: 'n', room: 'r2', local: true }]]);
  const resting = new Map([[JSON.stringify(['n', 'r3', 'p3']), Date.now() + 1000], [JSON.stringify(['n', 'r4', 'p4']), Date.now() - 1]]);
  assert.deepEqual(networkSnapshot('n', live, resting).peers.map((p) => p.id), ['p1', 'p3'], 'load-test peers and ended leases left out');
});

test('a Node relay serves the same watch', async () => {
  const SERVER = fileURLToPath(new URL('../scripts/node-relay.mjs', import.meta.url));
  const PORT = 18_900 + Math.floor(Math.random() * 200);
  const relay = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', FREERTC_FEDERATION: 'off', FREERTC_DIRECT: 'off', FREERTC_PUNCH: 'off', FREERTC_DATA_DIR: mkdtempSync(path.join(tmpdir(), 'freertc-watch-')) }, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((resolve, reject) => {
      relay.stdout.on('data', (chunk) => { if (/\[node-relay\] .* on https?:\/\//.test(String(chunk))) resolve(); });
      relay.once('exit', (code) => reject(new Error(`relay exited early with ${code}`)));
      setTimeout(() => reject(new Error('relay did not start')), 8000);
    });
    const got = [];
    const watch = new WebSocket(`ws://127.0.0.1:${PORT}/watch?network=app`);
    watch.on('message', (raw) => { const text = String(raw); got.push(text.startsWith('{') ? JSON.parse(text) : text); });
    await once(watch, 'open');
    const peer = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    await once(peer, 'open');
    peer.send(announce('peer-n', 'elsewhere'));
    await new Promise((r) => setTimeout(r, 300));
    peer.close();
    await new Promise((r) => setTimeout(r, 300));
    watch.send('ping');
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(got.filter((m) => m.t).map((m) => [m.t, m.id ?? null, m.room ?? null]), [['peers', null, null], ['join', 'peer-n', 'elsewhere'], ['leave', 'peer-n', 'elsewhere']]);
    assert.ok(got.includes('pong'), 'a "ping" is answered');
    watch.close();
  } finally {
    relay.kill();
  }
});
