import assert from 'node:assert/strict';
import test from 'node:test';

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
  lookupPeerProviders,
  lookupScopeProviders,
  publishPeerProviderRecords,
} from '../src/relay-overlay.js';

class MemoryD1 {
  constructor() {
    this.nodes = new Map();
    this.records = new Map();
  }

  prepare(sql) {
    const db = this;
    return {
      bind(...values) {
        return {
          async run() {
            if (sql.includes('INSERT INTO psp_kad_nodes')) {
              const [nodeId, bucketIndex, url, recordJson, expiresAt, lastSeen] = values;
              db.nodes.set(nodeId, {
                node_id: nodeId,
                bucket_index: bucketIndex,
                url,
                record_json: recordJson,
                expires_at_ms: expiresAt,
                last_seen_ms: lastSeen,
              });
            } else if (sql.includes('INSERT INTO psp_kad_records')) {
              const [routingKey, ownerNodeId, kind, sequence, recordJson, expiresAt] = values;
              const key = `${routingKey}:${ownerNodeId}:${kind}`;
              const previous = db.records.get(key);
              if (!previous || sequence > previous.sequence) {
                db.records.set(key, {
                  routing_key: routingKey,
                  owner_node_id: ownerNodeId,
                  kind,
                  sequence,
                  record_json: recordJson,
                  expires_at_ms: expiresAt,
                });
              }
            }
            return { success: true };
          },
          async all() {
            if (sql.includes('FROM psp_kad_nodes')) {
              const [now, limit] = values;
              return {
                results: [...db.nodes.values()]
                  .filter((row) => row.expires_at_ms > now)
                  .sort((left, right) => right.last_seen_ms - left.last_seen_ms)
                  .slice(0, limit),
              };
            }
            if (sql.includes('FROM psp_kad_records')) {
              const [routingKey, now, limit] = values;
              return {
                results: [...db.records.values()]
                  .filter((row) => row.routing_key === routingKey && row.expires_at_ms > now)
                  .sort((left, right) => right.sequence - left.sequence)
                  .slice(0, limit),
              };
            }
            return { results: [] };
          },
        };
      },
    };
  }
}

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
      lookupPeerProviders(envB, urlB, 'network-z', 'room-z', 'peer-z'),
    ]);
    assert.deepEqual(scopeProviders.map((record) => record.url), [urlA]);
    assert.deepEqual(peerProviders.map((record) => record.url), [urlA]);
    assert.equal(peerProviders[0].connections, 125);
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
