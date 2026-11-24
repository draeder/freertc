// A Worker relay's coordinator takes peer sockets through the hibernation API, so a socket left open is not
// billed as Durable Object duration (accept() kept the object in memory for as long as any peer stayed). After
// hibernation the object rebuilds its live peers from its sockets, and peers go on reaching each other.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { RelayCoordinator } from '../src/index.js';
import { installWebSocketPair, serverSocketOf } from '../src/node/websocket-pair.js';
import { MemoryD1 } from './harness/memory-d1.js';

installWebSocketPair();

class Peer extends EventEmitter {
  constructor() { super(); this.got = []; }
  send(data) { this.got.push(JSON.parse(data)); }
  close(code, reason) { this.emit('close', code, Buffer.from(reason || '')); }
}

// A Durable Object's state as the coordinator uses it: storage with alarms, and the hibernation API.
function objectState(current) {
  const data = new Map();
  let alarm = null;
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
    get alarmAt() { return alarm; },
  };
  return state;
}

let seq = 0;
const envelope = (from, type, extra = {}) => ({
  psp_version: '1.0', type, network: 'net', session_id: 'room', from,
  message_id: `m${++seq}`, timestamp: Date.now(), ttl_ms: 60_000, ...extra,
});
const tick = () => new Promise((r) => setTimeout(r, 30));

test('peer sockets hibernate, and a woken coordinator still delivers between them', async () => {
  const env = { DB: new MemoryD1(), RELAY_URL: 'wss://hib.example/ws' };
  let object;
  const state = objectState(() => object);
  object = new RelayCoordinator(state, env);

  const connect = async () => {
    const response = await object.fetch(new Request('https://hib.example/ws', { headers: { Upgrade: 'websocket' } }));
    assert.equal(response.status, 101);
    const peer = new Peer();
    serverSocketOf(response).attach(peer);
    return peer;
  };
  const a = await connect();
  const b = await connect();
  assert.equal(state.accepted, 2, 'both through acceptWebSocket (hibernatable), not accept()');

  a.emit('message', JSON.stringify(envelope('peer-a', 'announce', { body: { instance_id: 'net', capabilities: {} } })));
  b.emit('message', JSON.stringify(envelope('peer-b', 'announce', { body: { instance_id: 'net', capabilities: {} } })));
  await tick();
  assert.ok(a.got.some((m) => m.type === 'ack' || m.body?.registered || m.type === 'announce'), 'a registered');
  await object.alarm();

  b.emit('message', JSON.stringify(envelope('peer-b', 'offer', { to: 'peer-a', body: { sdp: 'x' } })));
  await tick();
  assert.ok(a.got.some((m) => m.type === 'offer' && m.from === 'peer-b'), 'delivered at once');

  // Hibernation: the object is gone, its sockets are not. A new one starts on the next message.
  object = new RelayCoordinator(state, env);
  a.got.length = 0;
  b.emit('message', JSON.stringify(envelope('peer-b', 'offer', { to: 'peer-a', body: { sdp: 'y' } })));
  await tick();
  assert.ok(a.got.some((m) => m.type === 'offer' && m.body?.sdp === 'y'), 'still delivered after waking');

  const health = await (await object.fetch(new Request('https://hib.example/health'))).json();
  assert.equal(health.peers, 2, 'the woken object counts both peers');

  // A peer leaving after a wake is let go: no longer counted, and its leaving is queued for the room.
  b.close(1000, 'bye');
  await tick();
  const after = await (await object.fetch(new Request('https://hib.example/health'))).json();
  assert.equal(after.peers, 1);
  const queued = await state.storage.list({ prefix: 'task:' });
  assert.ok([...queued.values()].some((t) => t.kind === 'peer-left' && t.peerId === 'peer-b'), 'peer-left queued');
});
