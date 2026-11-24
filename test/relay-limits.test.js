// A relay's limits per address, and the owner's load-test pass that lifts them (src/relay-limits.js).
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { generateRandomPair, signMessage } from 'unsea';
import worker, { upsertAnnouncement } from '../src/index.js';
import { installWebSocketPair, serverSocketOf } from '../src/node/websocket-pair.js';
import { encodeRelayIdentitySecret } from '../src/relay-identity.js';
import { createRelayLimits, formatLoadTestPass, loadTestHolds, loadTestText, parseLoadTestPass } from '../src/relay-limits.js';
import { relayNodeIdOf } from '../src/relay-overlay.js';
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
  return { env, owner, nodeId: await relayNodeIdOf(env) };
}

async function open(env, address, query = '') {
  const headers = { Upgrade: 'websocket' };
  if (address) headers['cf-connecting-ip'] = address;
  const response = await worker.fetch(new Request(`https://limits.example/ws${query}`, { headers }), env, { waitUntil() {} });
  const server = serverSocketOf(response);
  if (!server) return { status: response.status, body: await response.json() };
  const socket = new FakeSocket();
  server.attach(socket);
  return { status: 101, socket };
}

let seq = 0;
function announce(socket, peerId, room = 'room-1') {
  socket.emit('message', JSON.stringify({
    psp_version: '1.0', type: 'announce', network: 'net', session_id: room, from: peerId,
    message_id: `m${++seq}`, timestamp: Date.now(), ttl_ms: 60_000, body: { instance_id: 'net', capabilities: {} },
  }));
}
const tick = () => new Promise((r) => setTimeout(r, 20));

test('counts: sockets at once, peers per room, new sockets a minute, each per address', () => {
  const limits = createRelayLimits();
  const env = { RELAY_MAX_SOCKETS_PER_ADDRESS: '2', RELAY_MAX_PEERS_PER_ADDRESS_ROOM: '1', RELAY_MAX_NEW_SOCKETS_PER_MINUTE: '3' };
  assert.equal(limits.admit(env, '1.1.1.1', 0).ok, true);
  assert.equal(limits.admit(env, '1.1.1.1', 1).ok, true);
  assert.equal(limits.admit(env, '1.1.1.1', 2).ok, false, 'a third at once');
  assert.equal(limits.admit(env, '2.2.2.2', 2).ok, true, 'another address is its own');
  limits.release('1.1.1.1');
  assert.equal(limits.admit(env, '1.1.1.1', 3).ok, true, 'one closed, one more');
  limits.release('1.1.1.1');
  assert.equal(limits.admit(env, '1.1.1.1', 4).ok, false, 'but a fourth new one in the minute is refused');
  assert.equal(limits.admit(env, '1.1.1.1', 60_005).ok, true, 'a minute later it may');
  assert.equal(limits.join(env, '1.1.1.1', 'a').ok, true);
  assert.equal(limits.join(env, '1.1.1.1', 'a').ok, false);
  assert.equal(limits.join(env, '1.1.1.1', 'b').ok, true, 'per room');
  limits.leave('1.1.1.1', 'a');
  assert.equal(limits.join(env, '1.1.1.1', 'a').ok, true);
  assert.equal(limits.admit({ RELAY_MAX_SOCKETS_PER_ADDRESS: '0', RELAY_MAX_NEW_SOCKETS_PER_MINUTE: '0' }, '3.3.3.3').ok, true, '0 turns a limit off');
  assert.equal(limits.admit(env, null).ok, true, 'an unknown address is not counted');
});

test('a pass holds only signed by the owner, for this relay, and running', async () => {
  const { env, owner, nodeId } = await relay();
  const until = Date.now() + 3_600_000;
  const sig = await signMessage(loadTestText(nodeId, until), owner.priv);
  const pass = parseLoadTestPass(formatLoadTestPass(until, sig));
  assert.equal(await loadTestHolds(env, nodeId, pass), true);
  assert.equal(await loadTestHolds(env, 'f'.repeat(64), pass), false, 'another relay');
  assert.equal(await loadTestHolds(env, nodeId, pass, until + 1), false, 'run out');
  assert.equal(await loadTestHolds(env, nodeId, pass, until - 25 * 3_600_000), false, 'more than a day ahead');
  const stranger = await generateRandomPair();
  const theirs = { until, sig: await signMessage(loadTestText(nodeId, until), stranger.priv) };
  assert.equal(await loadTestHolds(env, nodeId, theirs), false, 'not the owner');
  assert.equal(await loadTestHolds({ ...env, RELAY_OWNER: undefined }, nodeId, pass), false, 'an unclaimed relay has no load tests');
  assert.equal(parseLoadTestPass('nope'), null);
});

test('a relay refuses an address over its limits, and a pass from the owner lifts them', async () => {
  const { env, owner, nodeId } = await relay({ RELAY_MAX_SOCKETS_PER_ADDRESS: '2', RELAY_MAX_PEERS_PER_ADDRESS_ROOM: '1', RELAY_MAX_NEW_SOCKETS_PER_MINUTE: '50' });
  const a = await open(env, '203.0.113.7');
  const b = await open(env, '203.0.113.7');
  assert.equal(a.status, 101);
  assert.equal(b.status, 101);
  const c = await open(env, '203.0.113.7');
  assert.equal(c.status, 429, 'a third socket at once');
  assert.match(c.body.error, /at once from one address/);
  assert.equal((await open(env, '198.51.100.9')).status, 101, 'someone else is not held back');

  announce(a.socket, 'peer-a');
  await tick();
  assert.equal(a.socket.closedWith, null);
  announce(b.socket, 'peer-b');
  await tick();
  assert.deepEqual(b.socket.closedWith, { code: 4008, reason: 'over_limit' }, 'a second peer in the room from one address');
  assert.equal(b.socket.sent.at(-1).body.code, 'over_limit');

  // Closed sockets give their places back.
  a.socket.close(1000, 'done');
  assert.equal((await open(env, '203.0.113.7')).status, 101);

  const until = Date.now() + 600_000;
  const sig = await signMessage(loadTestText(nodeId, until), owner.priv);
  const query = `?load_test=${encodeURIComponent(formatLoadTestPass(until, sig))}`;
  const many = [];
  for (let i = 0; i < 5; i++) many.push(await open(env, '203.0.113.7', query));
  assert.deepEqual(many.map((s) => s.status), [101, 101, 101, 101, 101], 'with the pass, not counted');
  for (const [i, s] of many.entries()) announce(s.socket, `load-${i}`);
  await tick();
  assert.ok(many.every((s) => s.socket.closedWith === null), 'all in one room');

  const stranger = await generateRandomPair();
  const forged = `?load_test=${formatLoadTestPass(until, await signMessage(loadTestText(nodeId, until), stranger.priv))}`;
  assert.equal((await open(env, '192.0.2.1', forged)).status, 403, 'a pass that is not the owner\'s');
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
