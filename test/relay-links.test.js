// Links between local relays: authenticated both ways before anything crosses,
// and federation calls to a linked relay's tunnel URL go over the link.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { generateRandomPair } from 'unsea';
import { bucketOf, chooseLinkTargets, createRelayLinks } from '../src/node/relay-links.js';
import { isLanAddress } from '../src/node/lan-beacon.js';
import { createRelayIdentity, createSignedNodeRecord } from '../src/relay-identity.js';

async function relay(name) {
  const pair = await generateRandomPair();
  const identity = await createRelayIdentity(pair.pub, pair.priv);
  const url = `wss://${name}.example/t/${identity.nodeId}/ws`;
  const handled = [];
  const links = createRelayLinks({
    identity,
    nodeRecord: () => createSignedNodeRecord(identity, { url, relayKind: 'local' }),
    handleRequest: async (request) => {
      handled.push(`${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`);
      return new Response(JSON.stringify({ from: name, body: request.method === 'POST' ? await request.text() : null }), { headers: { 'Content-Type': 'application/json' } });
    },
  });
  return { identity, url, links, handled };
}

/** Two connected in-memory sockets with the ws-style surface the links use. */
function socketPair({ dropFirstFromA = false } = {}) {
  const make = () => Object.assign(new EventEmitter(), { readyState: 1 });
  const a = make();
  const b = make();
  let dropped = !dropFirstFromA;
  a.send = (data) => { if (!dropped) { dropped = true; return; } setImmediate(() => b.emit('message', data)); };
  b.send = (data) => setImmediate(() => a.emit('message', data));
  const close = () => { if (a.readyState === 3) return; a.readyState = 3; b.readyState = 3; a.emit('close'); b.emit('close'); };
  a.close = close;
  b.close = close;
  return [a, b];
}

const until = async (check, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test('two relays link only after each proves its key, and calls to the other\'s tunnel go over the link', async () => {
  const one = await relay('home-a');
  const two = await relay('home-b');
  // The first challenge one sends is lost, as when the other end attaches its
  // handler a moment after the channel opens: the resend still completes it.
  const [sa, sb] = socketPair({ dropFirstFromA: true });
  one.links.accept(sa, { via: 'punch', expectNodeId: two.identity.nodeId });
  two.links.accept(sb, { via: 'punch' });
  try {
    await until(() => one.links.links.get(two.identity.nodeId)?.open && two.links.links.get(one.identity.nodeId)?.open);
    const direct = [];
    const fetchViaLinks = one.links.wrapFetch(async (input) => { direct.push(String(input)); return new Response('direct'); });
    const response = await fetchViaLinks(`https://home-b.example/t/${two.identity.nodeId}/api/v1/kad/find?x=1`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"target":"t"}',
    });
    assert.deepEqual(await response.json(), { from: 'home-b', body: '{"target":"t"}' });
    assert.deepEqual(two.handled, ['POST /api/v1/kad/find?x=1']);
    assert.deepEqual(direct, [], 'nothing went out through the home');

    // Anything else is fetched as before.
    assert.equal(await (await fetchViaLinks('https://cloud.example/api/v1/relays')).text(), 'direct');
    assert.equal(await (await fetchViaLinks(`https://home-c.example/t/${'d'.repeat(64)}/api/v1/peers`)).text(), 'direct');
  } finally {
    one.links.stop();
    two.links.stop();
  }
});

test('a relay that is not the one dialed, or cannot sign, is never linked', async () => {
  const one = await relay('home-a');
  const two = await relay('home-b');
  const three = await relay('home-c');
  const [sa, sb] = socketPair();
  one.links.accept(sa, { via: 'punch', expectNodeId: three.identity.nodeId });
  two.links.accept(sb, { via: 'punch' });
  try {
    await until(() => sa.readyState === 3, 3_000);
    assert.equal(one.links.links.size, 0);

    // A hello with a valid record but a signature over the wrong nonce.
    const fake = Object.assign(new EventEmitter(), { readyState: 1, sent: [] });
    fake.send = (data) => fake.sent.push(JSON.parse(data));
    fake.close = () => { fake.readyState = 3; fake.emit('close'); };
    one.links.accept(fake, { via: 'lan' });
    fake.emit('message', JSON.stringify({ t: 'hello', record: await createSignedNodeRecord(two.identity, { url: two.url }), signature: 'not-a-signature' }));
    await until(() => fake.readyState === 3, 3_000);
    assert.equal(one.links.links.size, 0);
    // And no request is served before a link is authenticated.
    const early = Object.assign(new EventEmitter(), { readyState: 1, sent: [] });
    early.send = (data) => early.sent.push(JSON.parse(data));
    early.close = () => {};
    one.links.accept(early, { via: 'lan' });
    early.emit('message', JSON.stringify({ t: 'req', id: 'r1', method: 'GET', path: '/api/v1/peers' }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(one.handled, []);
    assert.ok(early.sent.every((frame) => frame.t === 'challenge'));
  } finally {
    one.links.stop();
    two.links.stop();
    three.links.stop();
  }
});

test('links go to distinct XOR buckets first, and LAN links never use loopback', () => {
  const self = '0'.repeat(64);
  assert.equal(bucketOf(self, '8' + '0'.repeat(63)), 255);
  assert.equal(bucketOf(self, '1' + '0'.repeat(63)), 252);
  assert.equal(bucketOf(self, '0'.repeat(63) + '1'), 0);
  const records = [
    { node_id: '8' + '1'.repeat(63) }, { node_id: '9' + '1'.repeat(63) },
    { node_id: '4' + '1'.repeat(63) }, { node_id: '1' + '1'.repeat(63) },
  ];
  assert.deepEqual(chooseLinkTargets(self, records, 3).map((r) => r.node_id[0]), ['8', '4', '1']);
  assert.equal(isLanAddress('192.168.1.20'), true);
  assert.equal(isLanAddress('10.0.0.5'), true);
  assert.equal(isLanAddress('127.0.0.1'), false);
  assert.equal(isLanAddress('8.8.8.8'), false);
});
