// Links between local relays: authenticated both ways before anything crosses,
// and federation calls to a linked relay's tunnel URL go over the link.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { generateRandomPair } from 'unsea';
import { bucketOf, chooseLinkTargets, createRelayLinks } from '../src/node/relay-links.js';
import { isLanAddress } from '../src/node/lan-beacon.js';
import { createRelayIdentity, createSignedNodeRecord } from '../src/relay-identity.js';

async function relay(name, { pq = undefined } = {}) {
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
    ...(pq === undefined ? {} : { pq: pq === null ? null : { identity: pq.identity ?? { pub: pair.pub, priv: pair.priv, qpub: pair.qpub, qpriv: pair.qpriv }, pins: pq.pins, required: pq.required } }),
  });
  return { identity, url, links, handled, pair };
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

function memoryPins() {
  const pins = new Map();
  return { get: (id) => pins.get(id) ?? null, set: (id, key) => pins.set(id, key), map: pins };
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

test('local relays with post-quantum keys link only with a hybrid proof, pinned on first sight', async () => {
  const pinsOne = memoryPins();
  const one = await relay('home-a', { pq: { pins: pinsOne } });
  const two = await relay('home-b', { pq: { pins: memoryPins() } });
  let [sa, sb] = socketPair();
  one.links.accept(sa, { via: 'lan' });
  two.links.accept(sb, { via: 'lan' });
  try {
    await until(() => one.links.links.get(two.identity.nodeId)?.open && two.links.links.get(one.identity.nodeId)?.open);
    assert.equal(pinsOne.get(two.identity.nodeId), two.pair.qpub, 'pinned');
  } finally {
    one.links.stop();
    two.links.stop();
  }

  // The same node id with another post-quantum key (what someone who forged
  // its P-256 signature could show) is refused.
  const lines = [];
  const again = await relay('home-a2', { pq: { pins: pinsOne } });
  const impostor = createRelayLinks({
    identity: two.identity,
    nodeRecord: () => createSignedNodeRecord(two.identity, { url: two.url, relayKind: 'local' }),
    handleRequest: async () => new Response('x'),
    pq: { identity: { ...(await generateRandomPair()), pub: two.pair.pub, priv: two.pair.priv }, pins: memoryPins() },
  });
  const checker = createRelayLinks({
    identity: again.identity,
    nodeRecord: () => createSignedNodeRecord(again.identity, { url: again.url, relayKind: 'local' }),
    handleRequest: async () => new Response('x'),
    pq: { identity: { pub: again.pair.pub, priv: again.pair.priv, qpub: again.pair.qpub, qpriv: again.pair.qpriv }, pins: pinsOne },
    log: (line) => lines.push(line),
  });
  [sa, sb] = socketPair();
  checker.accept(sa, { via: 'lan' });
  impostor.accept(sb, { via: 'lan' });
  try {
    await until(() => lines.some((line) => line.includes('not the one it had before')));
    assert.equal(checker.links.get(two.identity.nodeId)?.open ?? false, false);
  } finally {
    checker.stop();
    impostor.stop();
    again.links.stop();
  }
});

test('a relay without a post-quantum key is not linked by one that requires it', async () => {
  const lines = [];
  const strict = await relay('home-a', { pq: { pins: memoryPins() } });
  const old = await relay('home-b');
  const strictLinks = createRelayLinks({
    identity: strict.identity,
    nodeRecord: () => createSignedNodeRecord(strict.identity, { url: strict.url, relayKind: 'local' }),
    handleRequest: async () => new Response('x'),
    pq: { identity: { pub: strict.pair.pub, priv: strict.pair.priv, qpub: strict.pair.qpub, qpriv: strict.pair.qpriv }, pins: memoryPins() },
    log: (line) => lines.push(line),
  });
  const [sa, sb] = socketPair();
  strictLinks.accept(sa, { via: 'lan' });
  old.links.accept(sb, { via: 'lan' });
  try {
    await until(() => lines.some((line) => line.includes('did not prove a post-quantum key')));
    assert.equal(strictLinks.links.get(old.identity.nodeId)?.open ?? false, false);
  } finally {
    strictLinks.stop();
    old.links.stop();
    strict.links.stop();
  }
});

test('a post-quantum link is encrypted end to end: a relay in the middle sees and can change nothing', async () => {
  const one = await relay('home-a', { pq: { pins: memoryPins() } });
  const two = await relay('home-b', { pq: { pins: memoryPins() } });
  // Everything crosses a middle that records it, and can tamper with it.
  const [sa, ma] = socketPair();
  const [mb, sb] = socketPair();
  const seen = [];
  let tamper = false;
  ma.on('message', (data) => {
    seen.push(String(data));
    let out = String(data);
    if (tamper && out.includes('"t":"enc"')) out = out.replace(/"c":"(.)/, (m, ch) => `"c":"${ch === 'A' ? 'B' : 'A'}`);
    mb.send(out);
  });
  mb.on('message', (data) => { seen.push(String(data)); ma.send(String(data)); });
  one.links.accept(sa, { via: 'lan', expectNodeId: two.identity.nodeId });
  two.links.accept(sb, { via: 'lan' });
  try {
    await until(() => one.links.links.get(two.identity.nodeId)?.open && two.links.links.get(one.identity.nodeId)?.open);
    const viaLinks = one.links.wrapFetch(async () => new Response('direct'));
    const response = await viaLinks(`https://home-b.example/t/${two.identity.nodeId}/api/v1/idp`, { method: 'POST', body: 'secret-body' });
    assert.deepEqual(await response.json(), { from: 'home-b', body: 'secret-body' });
    const wire = seen.join('\n');
    assert.ok(!wire.includes('secret-body') && !wire.includes(Buffer.from('secret-body').toString('base64')), 'the body never crosses in the clear');
    assert.ok(!/"t":"(req|res)"/.test(wire), 'no unsealed requests or responses');
    // An unsealed request sent into the link is ignored.
    ma.emit('message', JSON.stringify({ t: 'req', id: 'x', method: 'GET', path: '/injected', headers: [] }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(!two.handled.includes('GET /injected'));
    // A changed sealed frame closes the link.
    tamper = true;
    viaLinks(`https://home-b.example/t/${two.identity.nodeId}/api/v1/idp`, { method: 'POST', body: 'again' }).catch(() => {});
    await until(() => !two.links.links.get(one.identity.nodeId)?.open);
    assert.ok(!two.handled.some((line) => line.includes('again')));
  } finally {
    one.links.stop();
    two.links.stop();
  }
});
