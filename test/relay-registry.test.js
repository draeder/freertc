import assert from 'node:assert/strict';
import test from 'node:test';

import { generateRandomPair } from 'unsea';
import worker, { broadcastPeerList, listFederatedRelays } from '../src/index.js';
import { handleKademliaRequest, heartbeatKademlia } from '../src/relay-overlay.js';
import { MemoryD1 } from './harness/memory-d1.js';

async function relayEnv(bootstrapUrl = null) {
  const pair = await generateRandomPair();
  return {
    DB: new MemoryD1(),
    RELAY_SIGNING_PUBLIC_KEY: pair.pub,
    RELAY_SIGNING_PRIVATE_KEY: pair.priv,
    ...(bootstrapUrl ? { KADEMLIA_BOOTSTRAP_URLS: bootstrapUrl } : {}),
  };
}

test('a relay lists every relay it has verified, so any relay is a bootstrap', async () => {
  const urlHub = 'wss://relay-hub.example/ws';
  const urlA = 'wss://relay-a.example/ws';
  const urlB = 'wss://relay-b.example/ws';
  const [envHub, envA, envB] = await Promise.all([relayEnv(), relayEnv(urlHub), relayEnv(urlHub)]);
  envA.RELAY_URL = urlA;
  envA.RELAY_NAME = 'Relay A';
  const relays = new Map([
    ['relay-hub.example', { env: envHub, selfUrl: urlHub }],
    ['relay-a.example', { env: envA, selfUrl: urlA }],
    ['relay-b.example', { env: envB, selfUrl: urlB }],
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const target = relays.get(new URL(request.url).hostname);
    if (!target) return new Response('not found', { status: 404 });
    return handleKademliaRequest(request, target.env, { selfUrl: target.selfUrl });
  };

  try {
    // A and B each only know the hub. A's second heartbeat hears about B
    // from the hub's routing table.
    await heartbeatKademlia(envA, urlA);
    await heartbeatKademlia(envB, urlB);
    await heartbeatKademlia(envA, urlA);

    const listed = await listFederatedRelays(envA, urlA);
    assert.deepEqual(listed.map((relay) => relay.url).sort(), [urlA, urlB, urlHub].sort());
    assert.equal(listed[0].url, urlA, 'the answering relay lists itself first');
    assert.equal(listed[0].name, 'Relay A');

    // The same list is what the public registry endpoint serves, so a client
    // bootstrapping from A ranks B and the hub too, not the static defaults.
    const background = [];
    const response = await worker.fetch(
      new Request('https://relay-a.example/api/v1/relays'),
      envA,
      { waitUntil: (promise) => background.push(promise) },
    );
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.relays.map((relay) => relay.url).sort(), [urlA, urlB, urlHub].sort());
    await Promise.allSettled(background);

    // The hub going away does not take the others' knowledge of each other
    // with it: B is still a bootstrap for A because A verified it.
    relays.delete('relay-hub.example');
    const urlC = 'wss://relay-c.example/ws';
    const envC = await relayEnv(urlB);
    relays.set('relay-c.example', { env: envC, selfUrl: urlC });
    await heartbeatKademlia(envC, urlC);
    await heartbeatKademlia(envA, urlA);
    const afterHub = await listFederatedRelays(envA, urlA);
    assert.ok(afterHub.some((relay) => relay.url === urlC), 'A learned C through B, without the hub');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the list pushed after a join carries the federated room, not this relay alone', async () => {
  const network = 'network-bcast';
  const room = 'room-bcast';
  const localRows = [
    { peer_id: 'peer-local-1', session_id: room, updated_at_ms: 1_000 },
    { peer_id: 'peer-joining', session_id: room, updated_at_ms: 2_000 },
  ];
  const db = {
    prepare(sql) {
      return {
        bind() {
          return {
            async all() {
              return { results: sql.includes('FROM psp_announcements') ? localRows : [] };
            },
            async run() { return { success: true }; },
          };
        },
      };
    },
  };
  const sent = [];
  const socket = { send: (raw) => sent.push(JSON.parse(raw)) };
  const subscribers = new Map([[JSON.stringify([network, room]), new Set([socket])]]);
  const federatedPeers = [
    { peer_id: 'peer-remote-1', session_id: room, timestamp: 3_000, relay_url: 'wss://relay-b.example/ws' },
    { peer_id: 'peer-local-1', session_id: room, timestamp: 500 },
  ];

  await broadcastPeerList({ DB: db }, 'wss://relay-a.example/ws', network, room, 'bootstrap:relay-a', {
    federatedPeers,
    subscribers,
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'peer_list');
  assert.deepEqual(
    sent[0].body.peers.map((peer) => peer.peer_id),
    ['peer-joining', 'peer-local-1', 'peer-remote-1'],
  );
  const local1 = sent[0].body.peers.find((peer) => peer.peer_id === 'peer-local-1');
  assert.equal(local1.timestamp, 1_000, 'the newer local row wins over the older federated copy');

  // Without an overlay there is nothing federated to add; the local rows go
  // out alone, as before.
  sent.length = 0;
  await broadcastPeerList({ DB: db }, null, network, room, 'bootstrap:relay-a', { subscribers });
  assert.deepEqual(sent[0].body.peers.map((peer) => peer.peer_id), ['peer-joining', 'peer-local-1']);
});

test('a ping only drains the relay queue where sockets can live outside the coordinator', async () => {
  const { pingDrainsQueuedMessages } = await import('../src/index.js');
  const coordinator = {
    storage: { put: async () => {}, setAlarm: async () => {}, getAlarm: async () => null },
  };
  assert.equal(pingDrainsQueuedMessages(coordinator), false, 'the coordinator delivers live frames on arrival');
  assert.equal(pingDrainsQueuedMessages({ waitUntil() {} }), true, 'a plain worker isolate still drains on ping');
  assert.equal(pingDrainsQueuedMessages(undefined), true);
});

test('a stale queue drain or heartbeat is dropped by the alarm; work someone waits on is never stale', async () => {
  const { deferredTaskIsStale } = await import('../src/index.js');
  const now = 1_700_000_000_000;
  const key = (age) => `task:${String(now - age).padStart(15, '0')}:000001`;
  assert.equal(deferredTaskIsStale(key(120_000), { kind: 'deliver-queued' }, now), true);
  assert.equal(deferredTaskIsStale(key(120_000), { kind: 'announce', isHeartbeat: true }, now), true);
  assert.equal(deferredTaskIsStale(key(5_000), { kind: 'deliver-queued' }, now), false, 'fresh drains still run');
  assert.equal(deferredTaskIsStale(key(120_000), { kind: 'discover' }, now), false, 'a discover has a peer waiting on it');
  assert.equal(deferredTaskIsStale(key(120_000), { kind: 'announce', isHeartbeat: false }, now), false, 'a join broadcasts the room');
  assert.equal(deferredTaskIsStale(key(120_000), { kind: 'forward' }, now), false);
  assert.equal(deferredTaskIsStale('task:garbage', { kind: 'deliver-queued' }, now), false, 'an unreadable key is left to run');
});

test('a negotiation forward goes stale after its retry budget, and cheap waiting work runs before forwards', async () => {
  const { deferredTaskIsStale, orderDeferredTasks } = await import('../src/index.js');
  const now = 1_700_000_000_000;
  const key = (age) => `task:${String(now - age).padStart(15, '0')}:000001`;
  assert.equal(deferredTaskIsStale(key(30_000), { kind: 'forward', message: { type: 'offer' } }, now), true);
  assert.equal(deferredTaskIsStale(key(30_000), { kind: 'forward', message: { type: 'ice_candidate' } }, now), true);
  assert.equal(deferredTaskIsStale(key(5_000), { kind: 'forward', message: { type: 'offer' } }, now), false);
  assert.equal(deferredTaskIsStale(key(120_000), { kind: 'forward', message: { type: 'bye' } }, now), false, 'a goodbye is never too late');
  const ordered = orderDeferredTasks([
    [key(1), { kind: 'forward', message: { type: 'offer' } }],
    [key(2), { kind: 'deliver-queued' }],
    [key(3), { kind: 'discover' }],
    [key(4), { kind: 'announce', isHeartbeat: false }],
    [key(5), { kind: 'forward', message: { type: 'answer' } }],
  ]).map(([, task]) => task.kind);
  assert.deepEqual(ordered, ['discover', 'announce', 'forward', 'forward', 'deliver-queued']);
});
