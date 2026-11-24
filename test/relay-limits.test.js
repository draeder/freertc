// What one address may ask of a relay, and the owner's load-test pass that lifts it (src/relay-limits.js).
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { generateRandomPair, signMessage } from 'unsea';
import worker, { RelayCoordinator, relayLimitCounts, upsertAnnouncement } from '../src/index.js';
import { installWebSocketPair, serverSocketOf } from '../src/node/websocket-pair.js';
import { encodeRelayIdentitySecret } from '../src/relay-identity.js';
import { ownNodeId } from '../src/relay-owner.js';
import { createRelayLimits, formatLoadTestPass, loadTestHolds, loadTestText, parseLoadTestPass } from '../src/relay-limits.js';
import { MemoryD1 } from './harness/memory-d1.js';

installWebSocketPair();

class FakeSocket extends EventEmitter {
  constructor() { super(); this.sent = []; this.closedWith = null; }
  send(data) { this.sent.push(JSON.parse(data)); }
  close(code, reason) { if (this.closedWith) return; this.closedWith = { code, reason }; this.emit('close', code, Buffer.from(reason || '')); }
}

async function relay(extra = {}) {
  const pair = await generateRandomPair();
  const owner = await generateRandomPair();
  const env = { DB: new MemoryD1(), RELAY_URL: 'wss://limits.example/ws', RELAY_IDENTITY_SECRET: encodeRelayIdentitySecret(pair.pub, pair.priv), RELAY_OWNER: owner.pub, ...extra };
  return { env, owner, nodeId: await ownNodeId(env) };
}

async function pass(nodeId, owner, ms = 600_000) {
  const until = Date.now() + ms;
  return `?load_test=${encodeURIComponent(formatLoadTestPass(until, await signMessage(loadTestText(nodeId, until), owner.priv)))}`;
}

async function open(fetcher, address, query = '') {
  const headers = { Upgrade: 'websocket' };
  if (address) headers['cf-connecting-ip'] = address;
  const response = await fetcher(new Request(`https://limits.example/ws${query}`, { headers }));
  const server = serverSocketOf(response);
  if (!server) return { status: response.status, body: await response.json() };
  const socket = new FakeSocket();
  server.attach(socket);
  return { status: 101, socket };
}

let seq = 0;
const say = (socket, from, type = 'ping', extra = {}) => socket.emit('message', JSON.stringify({
  psp_version: '1.0', type, network: 'net', session_id: 'room', from,
  message_id: `m${++seq}`, timestamp: Date.now(), ttl_ms: 60_000, body: type === 'announce' ? { instance_id: 'net', capabilities: {} } : {}, ...extra,
}));
const tick = () => new Promise((r) => setTimeout(r, 20));

test('no cap on connections while the relay has room; new ones a minute, per address', () => {
  const limits = createRelayLimits();
  const env = { RELAY_NEW_CONNECTIONS_PER_MINUTE: '3', RELAY_BUSY_CONNECTIONS: '0' };
  for (let i = 0; i < 3; i++) assert.equal(limits.admit(env, '1.1.1.1', i).ok, true);
  assert.equal(limits.admit(env, '1.1.1.1', 3).ok, false, 'a fourth new one in the minute');
  assert.equal(limits.admit(env, '2.2.2.2', 3).ok, true, 'another address is its own');
  assert.equal(limits.admit(env, '1.1.1.1', 60_005).ok, true, 'a minute later');
  const many = createRelayLimits();
  for (let i = 0; i < 5000; i++) assert.equal(many.admit({ RELAY_NEW_CONNECTIONS_PER_MINUTE: '0', RELAY_BUSY_CONNECTIONS: '0' }, '3.3.3.3', i).ok, true);
  assert.equal(many.counts().sockets['3.3.3.3'], 5000, 'thousands behind one address, while the relay is not busy');
});

test('a busy relay takes no more from an address that already holds many; a full one none at all', () => {
  const limits = createRelayLimits();
  const env = { RELAY_BUSY_CONNECTIONS: '4', RELAY_BUSY_PER_ADDRESS: '2', RELAY_MAX_CONNECTIONS: '5' };
  assert.equal(limits.admit(env, 'heavy').ok, true);
  assert.equal(limits.admit(env, 'heavy').ok, true);
  assert.equal(limits.admit(env, 'heavy').ok, true, 'not busy yet: no limit per address');
  assert.equal(limits.admit(env, 'a').ok, true);
  assert.match(limits.admit(env, 'heavy').error, /busy/, 'busy: the heavy address waits');
  assert.equal(limits.admit(env, 'b').ok, true, 'someone with none still gets in');
  assert.match(limits.admit(env, 'c').error ?? '', /full/, 'full: nobody');
  limits.release('heavy');
  limits.release('heavy');
  limits.release('a');
  assert.equal(limits.admit(env, 'heavy').ok, true, 'less busy again');
});

test('messages: a rate per address, bursting to twice it', () => {
  const limits = createRelayLimits();
  const env = { RELAY_MESSAGES_PER_SECOND: '10' };
  let passed = 0;
  for (let i = 0; i < 50; i++) if (limits.message(env, 'x', 1000)) passed += 1;
  assert.equal(passed, 20, 'a burst of twice the rate');
  assert.equal(limits.message(env, 'x', 1000), false);
  assert.equal(limits.message(env, 'x', 1100), true, 'a tenth of a second later, one more');
  assert.equal(limits.message(env, 'y', 1000), true, 'another address');
  assert.equal(limits.message(env, null, 1000), true, 'an unknown address is not limited');
});

test('a pass holds only signed by the owner, for this relay, and running', async () => {
  const { env, owner, nodeId } = await relay();
  const until = Date.now() + 3_600_000;
  const sig = await signMessage(loadTestText(nodeId, until), owner.priv);
  const p = parseLoadTestPass(formatLoadTestPass(until, sig));
  assert.equal(await loadTestHolds(env, nodeId, p), true);
  assert.equal(await loadTestHolds(env, 'f'.repeat(64), p), false, 'another relay');
  assert.equal(await loadTestHolds(env, nodeId, p, until + 1), false, 'run out');
  assert.equal(await loadTestHolds(env, nodeId, p, until - 25 * 3_600_000), false, 'more than a day ahead');
  const stranger = await generateRandomPair();
  assert.equal(await loadTestHolds(env, nodeId, { until, sig: await signMessage(loadTestText(nodeId, until), stranger.priv) }), false, 'not the owner');
  assert.equal(await loadTestHolds({ ...env, RELAY_OWNER: undefined }, nodeId, p), false, 'an unclaimed relay has no load tests');
  assert.equal(parseLoadTestPass('nope'), null);
});

test('a relay refuses an address over its rate, drops messages over it, and the owner\'s pass lifts both', async () => {
  const { env, owner, nodeId } = await relay({ RELAY_NEW_CONNECTIONS_PER_MINUTE: '2', RELAY_MESSAGES_PER_SECOND: '5' });
  const fetcher = (request) => worker.fetch(request, env, { waitUntil() {} });
  const a = await open(fetcher, '203.0.113.7');
  assert.equal(a.status, 101);
  assert.equal((await open(fetcher, '203.0.113.7')).status, 101);
  const c = await open(fetcher, '203.0.113.7');
  assert.equal(c.status, 429);
  assert.match(c.body.error, /a minute from one address/);
  assert.equal((await open(fetcher, '198.51.100.9')).status, 101, 'someone else is not held back');

  for (let i = 0; i < 30; i++) say(a.socket, 'peer-a');
  await tick();
  const pongs = a.socket.sent.filter((m) => m.type === 'pong').length;
  assert.ok(pongs >= 9 && pongs <= 11, `about a burst of twice the rate answered (${pongs})`);
  assert.equal(a.socket.sent.filter((m) => m.body?.code === 'too_fast').length, 1, 'told once');

  const query = await pass(nodeId, owner);
  const many = [];
  for (let i = 0; i < 5; i++) many.push(await open(fetcher, '203.0.113.7', query));
  assert.deepEqual(many.map((s) => s.status), [101, 101, 101, 101, 101], 'with the pass, not counted');
  for (let i = 0; i < 30; i++) say(many[0].socket, 'load-0');
  await tick();
  assert.equal(many[0].socket.sent.filter((m) => m.type === 'pong').length, 30, 'nor its messages limited');

  const stranger = await generateRandomPair();
  assert.equal((await open(fetcher, '192.0.2.1', await pass(nodeId, stranger))).status, 403, 'a pass that is not the owner\'s');
});

test('a Worker relay counts through hibernation, and lets go of a closed socket', async () => {
  const { env } = await relay({ RELAY_BUSY_CONNECTIONS: '2', RELAY_BUSY_PER_ADDRESS: '1' });
  const sockets = new Set();
  let object;
  const state = {
    storage: { put: async () => {}, list: async () => new Map(), getAlarm: async () => null, setAlarm: async () => {}, delete: async () => {} },
    blockConcurrencyWhile: (fn) => fn(),
    acceptWebSocket(socket) {
      sockets.add(socket);
      socket.addEventListener('message', (e) => object.webSocketMessage(socket, e.data));
      socket.addEventListener('close', (e) => { sockets.delete(socket); return object.webSocketClose(socket, e.code, e.reason); });
    },
    getWebSockets: () => [...sockets],
  };
  object = new RelayCoordinator(state, env);
  const fetcher = (request) => object.fetch(request);
  const one = await open(fetcher, '10.9.9.9');
  await open(fetcher, '10.8.8.8');
  assert.equal(relayLimitCounts().total, 2);
  object = new RelayCoordinator(state, env); // hibernated and woken
  await object.fetch(new Request('https://limits.example/health'));
  assert.deepEqual(relayLimitCounts(), { total: 2, sockets: { '10.9.9.9': 1, '10.8.8.8': 1 } }, 'rebuilt from the sockets');
  assert.equal((await open(fetcher, '10.9.9.9')).status, 429, 'busy, and that address holds its share');
  one.socket.close(1000, 'bye');
  await tick();
  assert.equal(relayLimitCounts().total, 1, 'the closed one let go');
  assert.equal((await open(fetcher, '10.9.9.9')).status, 101);
});

test('a load test\'s peers are not listed to other relays', async (t) => {
  const { openSqliteD1 } = await import('./harness/sqlite-d1.js');
  const db = await openSqliteD1();
  if (!db) return t.skip('node:sqlite is not available on this Node');
  const { env } = await relay({ DB: db });
  await upsertAnnouncement(env.DB, { network: 'net', from: 'real', session_id: 'room', ttl_ms: 60_000, body: {} });
  await upsertAnnouncement(env.DB, { network: 'net', from: 'tester', session_id: 'room', ttl_ms: 60_000, body: {} }, { local: true });
  const response = await worker.fetch(new Request('https://limits.example/api/v1/peers?network=net&room=room'), env, { waitUntil() {} });
  const { peers } = await response.json();
  assert.deepEqual(peers.map((p) => p.peer_id), ['real']);
});
