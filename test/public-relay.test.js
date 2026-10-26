// A public relay never federates a loopback or private address: not its own,
// and not one another relay states. Only a private mesh (FREERTC_PUBLIC=false)
// takes them.
import assert from 'node:assert/strict';
import test from 'node:test';

import { generateRandomPair } from 'unsea';
import { isPrivateRelayUrl } from '../src/relay-identity.js';
import { handleKademliaRequest, heartbeatKademlia, isPublicRelay, listKnownRelays } from '../src/relay-overlay.js';
import { MemoryD1 } from './harness/memory-d1.js';

test('loopback, private, link-local, CGNAT and .local addresses are private; public ones are not', () => {
  for (const url of [
    'ws://127.0.0.1:8787/ws', 'wss://127.5.6.7/ws', 'ws://localhost:8788/ws', 'ws://relay.localhost/ws',
    'ws://my-mac.local/ws', 'ws://10.0.0.2/ws', 'ws://172.16.0.1/ws', 'ws://172.31.255.255/ws',
    'ws://192.168.1.20:8443/ws', 'ws://169.254.1.1/ws', 'ws://100.64.0.1/ws', 'ws://0.0.0.0/ws',
    'ws://[::1]:8788/ws', 'ws://[fd12:3456::1]/ws', 'ws://[fe80::1]/ws', 'not a url',
  ]) assert.equal(isPrivateRelayUrl(url), true, url);
  for (const url of [
    'wss://peer.ooo/ws', 'wss://decentralize.ooo/ws', 'wss://freertc-worker-dev.draeder.workers.dev/ws',
    'wss://8.8.8.8/ws', 'ws://172.32.0.1/ws', 'ws://100.128.0.1/ws', 'wss://[2001:db8::1]/ws',
  ]) assert.equal(isPrivateRelayUrl(url), false, url);
});

test('a relay is public unless FREERTC_PUBLIC says otherwise', () => {
  assert.equal(isPublicRelay({}), true);
  assert.equal(isPublicRelay({ FREERTC_PUBLIC: 'true' }), true);
  for (const value of ['false', 'FALSE', '0', 'off', 'no']) assert.equal(isPublicRelay({ FREERTC_PUBLIC: value }), false, value);
});

async function relayEnv(extra = {}) {
  const pair = await generateRandomPair();
  return { DB: new MemoryD1(), RELAY_SIGNING_PUBLIC_KEY: pair.pub, RELAY_SIGNING_PRIVATE_KEY: pair.priv, ...extra };
}

/** Relays whose fetch reaches each other by hostname, through the Kademlia RPC handler. */
function wire(relays, t) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const target = relays.find((relay) => new URL(relay.url).host === new URL(request.url).host);
    if (!target) return new Response('not found', { status: 404 });
    return handleKademliaRequest(request, target.env, { selfUrl: target.url });
  };
  t.after(() => { globalThis.fetch = realFetch; });
}

test('a public relay with a loopback address stays out of federation entirely', async (t) => {
  const seed = { url: 'wss://seed.example/ws', env: await relayEnv() };
  const local = { url: 'ws://127.0.0.1:8788/ws', env: await relayEnv({ KADEMLIA_BOOTSTRAP_URLS: seed.url }) };
  wire([seed, local], t);
  const result = await heartbeatKademlia(local.env, local.url);
  assert.equal(result.enabled, false, 'it does not join');
  assert.deepEqual((await listKnownRelays(seed.env, seed.url)).map((relay) => relay.url), [seed.url], 'the seed never hears of it');
});

test('a public relay refuses a private relay that tries to join through it', async (t) => {
  const seed = { url: 'wss://seed.example/ws', env: await relayEnv() };
  const mesh = { url: 'ws://192.168.1.20:8788/ws', env: await relayEnv({ FREERTC_PUBLIC: 'false', KADEMLIA_BOOTSTRAP_URLS: seed.url }) };
  wire([seed, mesh], t);
  await heartbeatKademlia(mesh.env, mesh.url);
  assert.deepEqual((await listKnownRelays(seed.env, seed.url)).map((relay) => relay.url), [seed.url]);
});

test('relays in a private mesh federate on local addresses', async (t) => {
  const a = { url: 'ws://127.0.0.1:8801/ws', env: await relayEnv({ FREERTC_PUBLIC: 'false' }) };
  const b = { url: 'ws://127.0.0.1:8802/ws', env: await relayEnv({ FREERTC_PUBLIC: 'false', KADEMLIA_BOOTSTRAP_URLS: 'ws://127.0.0.1:8801/ws' }) };
  wire([a, b], t);
  assert.equal((await heartbeatKademlia(b.env, b.url)).enabled, true);
  assert.deepEqual((await listKnownRelays(a.env, a.url)).map((relay) => relay.url).sort(), [a.url, b.url].sort());
});

test('every federated relay is a bootstrap, not only the configured ones', async (t) => {
  const { listBootstrapUrls } = await import('../src/relay-overlay.js');
  const a = { url: 'wss://a.example/ws', env: await relayEnv() };
  const b = { url: 'wss://b.example/ws', env: await relayEnv({ KADEMLIA_BOOTSTRAP_URLS: 'wss://a.example/ws' }) };
  const c = { url: 'wss://c.example/ws', env: await relayEnv({ KADEMLIA_BOOTSTRAP_URLS: 'wss://a.example/ws' }) };
  wire([a, b, c], t);
  await heartbeatKademlia(b.env, b.url);
  await heartbeatKademlia(c.env, c.url);
  // a was configured with no seeds at all, and b only with a; both list every relay they federate with.
  assert.deepEqual((await listBootstrapUrls(a.env, a.url)).sort(), [b.url, c.url].sort());
  assert.ok((await listBootstrapUrls(c.env, c.url)).includes(a.url));
});
