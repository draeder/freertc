// One relay ID everywhere: a relay with a federation identity is its Kademlia
// node ID in /health, in its own PSP frames and in the relay list clients
// rank; a relay behind NAT is its own ID, not its tunnel home's domain.
import assert from 'node:assert/strict';
import test from 'node:test';

import { generateRandomPair } from 'unsea';
import worker, { listFederatedRelays } from '../src/index.js';
import { relayPeerIdFor } from '../src/relay-id.js';
import { handleKademliaRequest, heartbeatKademlia, relayNodeIdOf } from '../src/relay-overlay.js';
import { MemoryD1 } from './harness/memory-d1.js';

async function relayEnv(extra = {}) {
  const pair = await generateRandomPair();
  return { DB: new MemoryD1(), RELAY_SIGNING_PUBLIC_KEY: pair.pub, RELAY_SIGNING_PRIVATE_KEY: pair.priv, ...extra };
}

async function health(env, url) {
  const background = [];
  const response = await worker.fetch(new Request(url), env, { waitUntil: (promise) => background.push(promise) });
  const body = await response.json();
  await Promise.allSettled(background);
  return body;
}

test('a relay with a federation identity is its node ID in /health and as its PSP peer ID', async () => {
  const env = await relayEnv({ RELAY_URL: 'wss://relay-id-a.example/ws' });
  const body = await health(env, 'https://relay-id-a.example/health');
  const nodeId = await relayNodeIdOf(env);
  assert.match(nodeId, /^[0-9a-f]{64}$/);
  assert.equal(body.node_id, nodeId);
  assert.equal(body.relay_peer_id, nodeId);
  assert.notEqual(body.relay_peer_id, relayPeerIdFor('wss://relay-id-a.example/ws'), 'not the domain hash');
});

test('a relay without a federation identity keeps the SHA-256 of its domain', async () => {
  const env = { DB: new MemoryD1(), RELAY_URL: 'wss://relay-id-b.example/ws' };
  const body = await health(env, 'https://relay-id-b.example/health');
  assert.equal(body.node_id, null);
  assert.equal(body.relay_peer_id, relayPeerIdFor('wss://relay-id-b.example/ws'));
});

test('the relay list carries each relay\'s node ID, and a tunneled relay has its own, not its home\'s', async () => {
  const urlHub = 'wss://relay-id-hub.example/ws';
  const envHub = await relayEnv();
  const envTunneled = await relayEnv({ KADEMLIA_BOOTSTRAP_URLS: urlHub });
  const tunneledId = await relayNodeIdOf(envTunneled);
  const urlTunneled = `wss://relay-id-hub.example/t/${tunneledId}/ws`;
  const hubId = await relayNodeIdOf(envHub);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    // The home hands /t/<id>/... to the tunneled relay, as a tunnel would.
    if (path.startsWith(`/t/${tunneledId}/`)) {
      const inner = new Request(new URL(path.slice(`/t/${tunneledId}`.length), request.url), request);
      return handleKademliaRequest(inner, envTunneled, { selfUrl: urlTunneled });
    }
    return handleKademliaRequest(request, envHub, { selfUrl: urlHub });
  };
  try {
    await heartbeatKademlia(envTunneled, urlTunneled);
    const listed = await listFederatedRelays(envHub, urlHub);
    const byUrl = new Map(listed.map((relay) => [relay.url, relay]));
    assert.equal(byUrl.get(urlHub)?.node_id, hubId);
    assert.equal(byUrl.get(urlTunneled)?.node_id, tunneledId);
    assert.notEqual(tunneledId, hubId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
