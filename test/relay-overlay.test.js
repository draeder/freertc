import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryD1 } from './harness/memory-d1.js';

import { generateRandomPair } from 'unsea';
import { peerRoutingKey } from '../src/kademlia.js';
import {
  PEER_PROVIDER_RECORD_KIND,
  createRelayIdentity,
  createSignedNodeRecord,
  createSignedProviderRecord,
  encodeRelayIdentitySecret,
  verifySignedRelayRecord,
} from '../src/relay-identity.js';
import {
  handleKademliaRequest,
  heartbeatKademlia,
  isKademliaEnabled,
  lookupRoomProviders,
  lookupScopeProviders,
  publishPeerProviderRecords,
} from '../src/relay-overlay.js';

function rpcRequest(path, body) {
  return new Request(`https://relay-a.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('signed Kademlia RPC accepts nodes, stores providers, and returns closest records', async () => {
  const [pairA, pairB] = await Promise.all([generateRandomPair(), generateRandomPair()]);
  const [identityA, identityB] = await Promise.all([
    createRelayIdentity(pairA.pub, pairA.priv),
    createRelayIdentity(pairB.pub, pairB.priv),
  ]);
  const requester = await createSignedNodeRecord(identityB, { url: 'wss://relay-b.example/ws' });
  const env = {
    DB: new MemoryD1(),
    RELAY_SIGNING_PUBLIC_KEY: pairA.pub,
    RELAY_SIGNING_PRIVATE_KEY: pairA.priv,
  };
  const options = { selfUrl: 'wss://relay-a.example/ws', connections: 17 };

  assert.equal(isKademliaEnabled(env), true);

  const ping = await handleKademliaRequest(
    rpcRequest('/api/v1/kad/ping', { requester }),
    env,
    options,
  );
  const pingBody = await ping.json();
  assert.equal(ping.status, 200);
  assert.equal(pingBody.node.node_id, identityA.nodeId);
  assert.equal(pingBody.node.connections, 17);
  assert.equal(await verifySignedRelayRecord(pingBody.node), true);

  const key = await peerRoutingKey('network-a', 'room-a', 'peer-42');
  const record = await createSignedProviderRecord(identityB, {
    kind: PEER_PROVIDER_RECORD_KIND,
    key,
    url: 'wss://relay-b.example/ws',
  });
  const store = await handleKademliaRequest(
    rpcRequest('/api/v1/kad/store', { requester, record }),
    env,
    options,
  );
  assert.equal(store.status, 200);
  assert.equal((await store.json()).stored, true);

  const find = await handleKademliaRequest(
    rpcRequest('/api/v1/kad/find', { requester, target: key, want_records: true }),
    env,
    options,
  );
  const findBody = await find.json();
  assert.equal(find.status, 200);
  assert.ok(findBody.nodes.some((node) => node.node_id === identityA.nodeId));
  assert.ok(findBody.nodes.some((node) => node.node_id === identityB.nodeId));
  assert.deepEqual(findBody.records, [record]);
});

test('Kademlia RPC rejects a tampered requester record', async () => {
  const [pairA, pairB] = await Promise.all([generateRandomPair(), generateRandomPair()]);
  const identityB = await createRelayIdentity(pairB.pub, pairB.priv);
  const requester = await createSignedNodeRecord(identityB, { url: 'wss://relay-b.example/ws' });
  const env = {
    DB: new MemoryD1(),
    RELAY_SIGNING_PUBLIC_KEY: pairA.pub,
    RELAY_SIGNING_PRIVATE_KEY: pairA.priv,
  };

  const response = await handleKademliaRequest(
    rpcRequest('/api/v1/kad/ping', {
      requester: { ...requester, connections: requester.connections + 1 },
    }),
    env,
    { selfUrl: 'wss://relay-a.example/ws' },
  );

  assert.equal(response.status, 401);
});

test('a single opaque relay identity secret enables Kademlia without a public-key variable', async () => {
  const pair = await generateRandomPair();
  const env = {
    DB: new MemoryD1(),
    RELAY_IDENTITY_SECRET: encodeRelayIdentitySecret(pair.pub, pair.priv),
  };

  assert.equal(isKademliaEnabled(env), true);
  const heartbeat = await heartbeatKademlia(env, 'wss://relay-secret.example/ws');
  assert.equal(heartbeat.enabled, true);
});

test('two relays join, replicate, and resolve signed scope and peer providers', async () => {
  const [pairA, pairB] = await Promise.all([generateRandomPair(), generateRandomPair()]);
  const urlA = 'wss://relay-a.example/ws';
  const urlB = 'wss://relay-b.example/ws';
  const envA = {
    DB: new MemoryD1(),
    RELAY_SIGNING_PUBLIC_KEY: pairA.pub,
    RELAY_SIGNING_PRIVATE_KEY: pairA.priv,
    KADEMLIA_BOOTSTRAP_URLS: urlB,
  };
  const envB = {
    DB: new MemoryD1(),
    RELAY_SIGNING_PUBLIC_KEY: pairB.pub,
    RELAY_SIGNING_PRIVATE_KEY: pairB.priv,
  };
  const relays = new Map([
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
    const heartbeat = await heartbeatKademlia(envA, urlA);
    assert.equal(heartbeat.enabled, true);

    const publishedScopeProviders = await publishPeerProviderRecords(envA, urlA, 'network-z', 'room-z', 'peer-z', {
      connections: 125,
      returnScopeProviders: true,
    });
    assert.deepEqual(publishedScopeProviders.map((record) => record.url), [urlA]);

    const [scopeProviders, peerProviders] = await Promise.all([
      lookupScopeProviders(envB, urlB, 'network-z', 'room-z'),
      lookupRoomProviders(envB, urlB, 'network-z', 'room-z'),
    ]);
    assert.deepEqual(scopeProviders.map((record) => record.url), [urlA]);
    assert.deepEqual(peerProviders.map((record) => record.url), [urlA]);
    assert.equal(peerProviders[0].connections, 125);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('concurrent signal bursts share one peer-provider lookup', async () => {
  const [pairA, pairB] = await Promise.all([generateRandomPair(), generateRandomPair()]);
  const urlA = 'wss://relay-burst-a.example/ws';
  const urlB = 'wss://relay-burst-b.example/ws';
  const envA = {
    DB: new MemoryD1(),
    RELAY_SIGNING_PUBLIC_KEY: pairA.pub,
    RELAY_SIGNING_PRIVATE_KEY: pairA.priv,
    KADEMLIA_BOOTSTRAP_URLS: urlB,
  };
  const envB = {
    DB: new MemoryD1(),
    RELAY_SIGNING_PUBLIC_KEY: pairB.pub,
    RELAY_SIGNING_PRIVATE_KEY: pairB.priv,
  };
  const relays = new Map([
    ['relay-burst-a.example', { env: envA, selfUrl: urlA }],
    ['relay-burst-b.example', { env: envB, selfUrl: urlB }],
  ]);
  const originalFetch = globalThis.fetch;
  let findCalls = 0;

  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname === '/api/v1/kad/find') findCalls += 1;
    const target = relays.get(new URL(request.url).hostname);
    if (!target) return new Response('not found', { status: 404 });
    return handleKademliaRequest(request, target.env, { selfUrl: target.selfUrl });
  };

  try {
    await heartbeatKademlia(envA, urlA);
    await publishPeerProviderRecords(envA, urlA, 'network-burst', 'room-burst', 'peer-burst');
    findCalls = 0;

    const results = await Promise.all(Array.from({ length: 12 }, () => (
      lookupRoomProviders(envB, urlB, 'network-burst', 'room-burst')
    )));
    const afterBurst = findCalls;

    assert.ok(results.every((records) => records.some((record) => record.url === urlA)));
    assert.ok(afterBurst > 0);
    assert.ok(afterBurst <= 2, `expected one coalesced lookup, received ${afterBurst} overlay requests`);

    await lookupRoomProviders(envB, urlB, 'network-burst', 'room-burst');
    assert.equal(findCalls, afterBurst);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('lookup refreshes configured bootstraps even when a stale routing contact exists', async () => {
  const [pairA, pairB, pairC] = await Promise.all([
    generateRandomPair(),
    generateRandomPair(),
    generateRandomPair(),
  ]);
  const urlA = 'wss://relay-a.example/ws';
  const urlB = 'wss://relay-b.example/ws';
  const urlC = 'wss://relay-c.example/ws';
  const envA = {
    DB: new MemoryD1(),
    RELAY_SIGNING_PUBLIC_KEY: pairA.pub,
    RELAY_SIGNING_PRIVATE_KEY: pairA.priv,
    KADEMLIA_BOOTSTRAP_URLS: urlC,
  };
  const envB = {
    DB: new MemoryD1(),
    RELAY_SIGNING_PUBLIC_KEY: pairB.pub,
    RELAY_SIGNING_PRIVATE_KEY: pairB.priv,
  };
  const envC = {
    DB: new MemoryD1(),
    RELAY_SIGNING_PUBLIC_KEY: pairC.pub,
    RELAY_SIGNING_PRIVATE_KEY: pairC.priv,
  };
  const relays = new Map([
    ['relay-a.example', { env: envA, selfUrl: urlA }],
    ['relay-b.example', { env: envB, selfUrl: urlB }],
    ['relay-c.example', { env: envC, selfUrl: urlC }],
  ]);
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const target = relays.get(new URL(request.url).hostname);
    if (!target) return new Response('not found', { status: 404 });
    return handleKademliaRequest(request, target.env, { selfUrl: target.selfUrl });
  };

  try {
    // Seed A with a valid but unhelpful contact. A must not treat this as proof
    // that its configured bootstrap is already represented in its routing table.
    await heartbeatKademlia(envA, urlA);
    assert.equal(envA.DB.nodes.size, 1);

    await publishPeerProviderRecords(envB, urlB, 'network-z', 'room-z', 'peer-z');
    envA.KADEMLIA_BOOTSTRAP_URLS = urlB;

    const providers = await lookupScopeProviders(envA, urlA, 'network-z', 'room-z');
    assert.deepEqual(providers.map((record) => record.url), [urlB]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Runs `body` with Date.now() under the test's control, so contact records can
// be issued and heard at chosen moments without waiting in real time.
async function withClock(startMs, body) {
  const realNow = Date.now;
  let current = startMs;
  Date.now = () => current;
  try {
    await body({ now: () => current, advance: (ms) => { current += ms; } });
  } finally {
    Date.now = realNow;
  }
}

async function overlayWithContact() {
  const [pairA, pairB] = await Promise.all([generateRandomPair(), generateRandomPair()]);
  const identityB = await createRelayIdentity(pairB.pub, pairB.priv);
  const env = {
    DB: new MemoryD1(),
    RELAY_SIGNING_PUBLIC_KEY: pairA.pub,
    RELAY_SIGNING_PRIVATE_KEY: pairA.priv,
  };
  const options = { selfUrl: 'wss://relay-a.example/ws' };
  const hear = (record) => handleKademliaRequest(
    rpcRequest('/api/v1/kad/ping', { requester: record }),
    env,
    options,
  );
  return { env, identityB, hear };
}

test('a contact heard on every message is written once, not once per message', async () => {
  const { env, identityB, hear } = await overlayWithContact();
  await withClock(1_800_000_000_000, async (clock) => {
    for (let i = 0; i < 25; i += 1) {
      // Each RPC carries a freshly signed record, as real relays send.
      const record = await createSignedNodeRecord(identityB, { url: 'wss://relay-b.example/ws', now: clock.now() });
      assert.equal((await hear(record)).status, 200);
      clock.advance(1_000);
    }
  });
  assert.equal(env.DB.nodes.size, 1);
  assert.equal(env.DB.nodeWrites, 1);
});

test('a contact is renewed once its stored record is past half its lifetime', async () => {
  const { env, identityB, hear } = await overlayWithContact();
  await withClock(1_800_000_000_000, async (clock) => {
    const issue = () => createSignedNodeRecord(identityB, { url: 'wss://relay-b.example/ws', now: clock.now() });

    await hear(await issue());
    const first = [...env.DB.nodes.values()][0].expires_at_ms;
    assert.equal(env.DB.nodeWrites, 1);

    clock.advance(60_000); // 1 min into a 5 min record: still plenty of life left
    await hear(await issue());
    assert.equal(env.DB.nodeWrites, 1);
    assert.equal([...env.DB.nodes.values()][0].expires_at_ms, first);

    clock.advance(100_000); // 2m40s in: under half the lifetime remains, so it is renewed
    await hear(await issue());
    assert.equal(env.DB.nodeWrites, 2);
    assert.ok([...env.DB.nodes.values()][0].expires_at_ms > first);

    // A contact that is heard again must never be left to lapse while it is still talking.
    for (let i = 0; i < 10; i += 1) {
      clock.advance(30_000);
      await hear(await issue());
      const row = [...env.DB.nodes.values()][0];
      assert.ok(row.expires_at_ms > clock.now(), 'stored record must still be live');
    }
  });
});

test('a contact that moves to a new url is rewritten immediately', async () => {
  const { env, identityB, hear } = await overlayWithContact();
  await withClock(1_800_000_000_000, async (clock) => {
    await hear(await createSignedNodeRecord(identityB, { url: 'wss://relay-b.example/ws', now: clock.now() }));
    clock.advance(1_000);
    await hear(await createSignedNodeRecord(identityB, { url: 'wss://relay-b2.example/ws', now: clock.now() }));
  });
  assert.equal(env.DB.nodeWrites, 2);
  assert.equal([...env.DB.nodes.values()][0].url, 'wss://relay-b2.example/ws');
});

/** Two relays whose fetch goes straight to each other, counting every RPC made. */
async function twoRelays() {
  const [pairA, pairB] = await Promise.all([generateRandomPair(), generateRandomPair()]);
  const urlA = 'wss://relay-a.example/ws';
  const urlB = 'wss://relay-b.example/ws';
  const envA = { DB: new MemoryD1(), RELAY_SIGNING_PUBLIC_KEY: pairA.pub, RELAY_SIGNING_PRIVATE_KEY: pairA.priv, KADEMLIA_BOOTSTRAP_URLS: urlB };
  const envB = { DB: new MemoryD1(), RELAY_SIGNING_PUBLIC_KEY: pairB.pub, RELAY_SIGNING_PRIVATE_KEY: pairB.priv };
  const relays = new Map([
    ['relay-a.example', { env: envA, selfUrl: urlA }],
    ['relay-b.example', { env: envB, selfUrl: urlB }],
  ]);
  const calls = { count: 0 };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const target = relays.get(new URL(request.url).hostname);
    if (!target) return new Response('not found', { status: 404 });
    calls.count += 1;
    return handleKademliaRequest(request, target.env, { selfUrl: target.selfUrl });
  };
  return { envA, envB, urlA, urlB, calls, restore: () => { globalThis.fetch = realFetch; } };
}

test('a heartbeat on an empty table joins; once a contact is live it makes no RPCs and writes nothing', async () => {
  const { envA, urlA, calls, restore } = await twoRelays();
  try {
    const first = await heartbeatKademlia(envA, urlA);
    assert.equal(first.joined, true);
    assert.ok(calls.count > 0, 'an empty relay must reach out to its bootstrap');
    assert.equal(envA.DB.nodes.size, 1);

    const rpcsAfterJoin = calls.count;
    const writesAfterJoin = envA.DB.nodeWrites;
    for (let i = 0; i < 5; i += 1) {
      const again = await heartbeatKademlia(envA, urlA);
      assert.equal(again.joined, false);
    }
    assert.equal(calls.count, rpcsAfterJoin, 'a relay with a live contact must not poll on a heartbeat');
    assert.equal(envA.DB.nodeWrites, writesAfterJoin);
  } finally {
    restore();
  }
});

/**
 * A relay configured with `seedUrls`, each a relay of its own, with fetch routed between them
 * and a count of the find requests every host received. Hosts in `dead` refuse every request.
 */
async function relayWithSeeds(seedUrls, { dead = [], extraRelays = [] } = {}) {
  const hostOf = (url) => new URL(url.replace('wss://', 'https://')).hostname;
  const members = [...seedUrls, ...extraRelays];
  const pairs = await Promise.all([generateRandomPair(), ...members.map(() => generateRandomPair())]);
  const urlA = 'wss://joiner.example/ws';
  const envA = {
    DB: new MemoryD1(),
    RELAY_SIGNING_PUBLIC_KEY: pairs[0].pub,
    RELAY_SIGNING_PRIVATE_KEY: pairs[0].priv,
    KADEMLIA_BOOTSTRAP_URLS: seedUrls.join(','),
  };
  const relays = new Map(members.map((url, i) => [hostOf(url), {
    selfUrl: url,
    env: { DB: new MemoryD1(), RELAY_SIGNING_PUBLIC_KEY: pairs[i + 1].pub, RELAY_SIGNING_PRIVATE_KEY: pairs[i + 1].priv },
  }]));
  const finds = new Map();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const { hostname, pathname } = new URL(request.url);
    if (pathname === '/api/v1/kad/find') finds.set(hostname, (finds.get(hostname) || 0) + 1);
    if (dead.includes(hostname)) return new Response('down', { status: 503 });
    const target = relays.get(hostname);
    if (!target) return new Response('not found', { status: 404 });
    return handleKademliaRequest(request, target.env, { selfUrl: target.selfUrl });
  };
  return { envA, urlA, finds, relays, restore: () => { globalThis.fetch = realFetch; } };
}

test('a joining relay asks one seed, not every seed', async () => {
  const seeds = ['wss://seed-1.example/ws', 'wss://seed-2.example/ws', 'wss://seed-3.example/ws'];
  const { envA, urlA, finds, restore } = await relayWithSeeds(seeds);
  try {
    assert.equal((await heartbeatKademlia(envA, urlA)).joined, true);
    const asked = seeds.filter((url) => finds.get(new URL(url.replace('wss://', 'https://')).hostname) > 0);
    assert.equal(asked.length, 1, `expected one seed to be asked, asked ${asked.join(', ')}`);
    assert.equal(envA.DB.nodes.size, 1);
  } finally {
    restore();
  }
});

test('a seed that is down is skipped, and the next one is enough', async () => {
  const seeds = ['wss://seed-1.example/ws', 'wss://seed-2.example/ws', 'wss://seed-3.example/ws'];
  const { envA, urlA, finds, restore } = await relayWithSeeds(seeds, { dead: ['seed-1.example'] });
  try {
    assert.equal((await heartbeatKademlia(envA, urlA)).joined, true);
    const liveAsked = ['seed-2.example', 'seed-3.example'].filter((host) => finds.get(host) > 0);
    assert.equal(liveAsked.length, 1, 'once a seed has answered, the others are not asked');
    assert.equal(envA.DB.nodes.size, 1);
  } finally {
    restore();
  }
});

test('with every seed down, a relay it learned of earlier is the way back in', async () => {
  const seeds = ['wss://seed-1.example/ws'];
  const learnedUrl = 'wss://learned.example/ws';
  const { envA, urlA, finds, relays, restore } = await relayWithSeeds(seeds, { dead: ['seed-1.example'], extraRelays: [learnedUrl] });
  try {
    // The joiner has already heard from the learned relay, as a relay it was once told about.
    const learned = relays.get('learned.example');
    const identity = await createRelayIdentity(learned.env.RELAY_SIGNING_PUBLIC_KEY, learned.env.RELAY_SIGNING_PRIVATE_KEY);
    const record = await createSignedNodeRecord(identity, { url: learnedUrl });
    const heard = await handleKademliaRequest(rpcRequest('/api/v1/kad/ping', { requester: record }), envA, { selfUrl: urlA });
    assert.equal(heard.status, 200);
    assert.equal(envA.DB.nodes.size, 1);

    await lookupScopeProviders(envA, urlA, 'network-fallback', 'room-fallback');
    assert.ok(finds.get('seed-1.example') > 0, 'the configured seed is tried first');
    assert.ok(finds.get('learned.example') > 0, 'then the relay it learned of');
  } finally {
    restore();
  }
});

test('many peers in one room are one publication of the room, and none of any single peer', async () => {
  const { envA, envB, urlA, restore } = await twoRelays();
  const stores = [];
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname === '/api/v1/kad/store') stores.push((await request.clone().json()).record.kind);
    return inner(input, init);
  };
  try {
    await withClock(1_800_000_000_000, async (clock) => {
      await heartbeatKademlia(envA, urlA);
      stores.length = 0;
      // Thirty peers announcing and heartbeating inside one minute.
      for (let i = 0; i < 30; i += 1) {
        await publishPeerProviderRecords(envA, urlA, 'network-room', 'room-one', `peer-${i}`, { connections: i });
        clock.advance(1_900);
      }
      assert.equal(stores.length, 1, 'one relay holds the closest copy, written once');
      assert.ok(!stores.includes(PEER_PROVIDER_RECORD_KIND), 'no record is published for a single peer');
      assert.ok([...envB.DB.records.values()].every((row) => row.kind !== PEER_PROVIDER_RECORD_KIND));

      clock.advance(61_000); // past the publish interval, still inside the record's life
      await publishPeerProviderRecords(envA, urlA, 'network-room', 'room-one', 'peer-3', { connections: 3 });
      assert.equal(stores.length, 2, 'the room is announced again after a minute');

      // A different room is its own announcement.
      await publishPeerProviderRecords(envA, urlA, 'network-room', 'room-two', 'peer-3', { connections: 3 });
      assert.equal(stores.length, 3);
    });
  } finally {
    globalThis.fetch = inner;
    restore();
  }
});

test('the room record outlives the gap between publications, so a room never lapses while it is in use', async () => {
  const { envA, envB, urlA, urlB, restore } = await twoRelays();
  try {
    await withClock(1_800_000_000_000, async (clock) => {
      await heartbeatKademlia(envA, urlA);
      await publishPeerProviderRecords(envA, urlA, 'network-live', 'room-live', 'peer-a', { connections: 1 });
      // Just under two minutes later, a peer elsewhere still finds the room.
      clock.advance(110_000);
      assert.deepEqual((await lookupRoomProviders(envB, urlB, 'network-live', 'room-live')).map((r) => r.url), [urlA]);
      // Past it, a room nobody re-announced is gone.
      clock.advance(20_000);
      assert.deepEqual(await lookupRoomProviders(envB, urlB, 'network-live', 'room-live'), []);
    });
  } finally {
    restore();
  }
});

test('a heartbeat joins again once every contact it knew has expired', async () => {
  const { envA, urlA, calls, restore } = await twoRelays();
  try {
    await withClock(1_800_000_000_000, async (clock) => {
      assert.equal((await heartbeatKademlia(envA, urlA)).joined, true);
      const rpcsAfterJoin = calls.count;

      clock.advance(60_000);
      assert.equal((await heartbeatKademlia(envA, urlA)).joined, false);
      assert.equal(calls.count, rpcsAfterJoin);

      clock.advance(11 * 60_000); // past the longest a node record can live
      assert.equal((await heartbeatKademlia(envA, urlA)).joined, true);
      assert.ok(calls.count > rpcsAfterJoin);
    });
  } finally {
    restore();
  }
});
