import assert from 'node:assert/strict';
import test from 'node:test';
import { generateRandomPair, sha256 } from 'unsea';

import {
  bucketIndex,
  canonicalJson,
  compactRoutingTable,
  peerRoutingKey,
  rankProviderRecords,
  relayNodeId,
  scopeRoutingKey,
  selectClosestNodes,
  xorDistanceHex,
} from '../src/kademlia.js';
import {
  createRelayIdentity,
  createSignedNodeRecord,
  createSignedProviderRecord,
  decodeRelayIdentitySecret,
  encodeRelayIdentitySecret,
  PEER_PROVIDER_RECORD_KIND,
  verifySignedRelayRecord,
} from '../src/relay-identity.js';

const id = (suffix) => `${'0'.repeat(64 - suffix.length)}${suffix}`;

test('canonical JSON sorts object keys while preserving array order', () => {
  assert.equal(canonicalJson({ z: 1, a: ['x', { b: true, a: false }] }), '{"a":["x",{"a":false,"b":true}],"z":1}');
});

test('routing IDs are deterministic UnSEA SHA-256 digests', async () => {
  const publicKey = 'public-key-fixture';
  assert.equal(await relayNodeId(publicKey), await sha256(canonicalJson(['freertc-kad', 1, 'relay', publicKey])));
  assert.equal(await scopeRoutingKey('network', 'room'), await scopeRoutingKey('network', 'room'));
  assert.notEqual(await scopeRoutingKey('network', 'room'), await scopeRoutingKey('network', 'other-room'));
  assert.notEqual(await peerRoutingKey('network', 'room', 'peer-a'), await peerRoutingKey('network', 'room', 'peer-b'));
});

test('relay identity secrets keep the complete UnSEA pair in one opaque value', async () => {
  const pair = await generateRandomPair();
  const secret = encodeRelayIdentitySecret(pair.pub, pair.priv);
  assert.deepEqual(decodeRelayIdentitySecret(secret), {
    publicKey: pair.pub,
    privateKey: pair.priv,
  });
  assert.throws(() => decodeRelayIdentitySecret('{"v":2}'), /unsupported format/);
});

test('XOR distance selects the closest relay and correct bucket', () => {
  const self = id('0');
  assert.equal(bucketIndex(self, id('1')), 0);
  assert.equal(bucketIndex(self, id('2')), 1);
  assert.equal(bucketIndex(self, `8${'0'.repeat(63)}`), 255);
  assert.equal(xorDistanceHex(id('1'), id('3')), id('2'));

  const nodes = [{ node_id: id('f') }, { node_id: id('2') }, { node_id: id('1') }];
  assert.deepEqual(selectClosestNodes(nodes, self, 2).map((node) => node.node_id), [id('1'), id('2')]);
});

test('routing table compaction enforces the per-bucket contact bound', () => {
  const self = id('0');
  const nodes = [
    { node_id: id('1'), last_seen_ms: 1 },
    { node_id: id('2'), last_seen_ms: 2 },
    { node_id: id('3'), last_seen_ms: 3 },
  ];
  const compacted = compactRoutingTable(self, nodes, 1);
  assert.deepEqual(compacted.map((node) => node.node_id).sort(), [id('1'), id('3')]);
});

test('provider ranking accounts for relay load and deduplicates owners', () => {
  const records = [
    { kind: 'scope-provider', node_id: id('1'), url: 'wss://one.test/ws', connections: 90, capacity: 100, sequence: 1 },
    { kind: 'scope-provider', node_id: id('2'), url: 'wss://two.test/ws', connections: 10, capacity: 100, sequence: 1 },
    { kind: 'scope-provider', node_id: id('2'), url: 'wss://two.test/ws', connections: 20, capacity: 100, sequence: 2 },
  ];
  assert.deepEqual(rankProviderRecords(records).map((record) => record.node_id), [id('2'), id('1')]);
});

test('UnSEA signs and verifies relay node and provider records', async () => {
  const pair = await generateRandomPair();
  const identity = await createRelayIdentity(pair.pub, pair.priv);
  const now = Date.now();
  const nodeRecord = await createSignedNodeRecord(identity, {
    url: 'https://relay.example.test',
    name: 'Relay One',
    connections: 12,
    capacity: 100,
    now,
  });

  assert.equal(nodeRecord.url, 'wss://relay.example.test/ws');
  assert.equal(await verifySignedRelayRecord(nodeRecord, { now }), true);
  assert.equal(await verifySignedRelayRecord({ ...nodeRecord, capacity: 101 }, { now }), false);

  const providerRecord = await createSignedProviderRecord(identity, {
    kind: PEER_PROVIDER_RECORD_KIND,
    key: await peerRoutingKey('network', 'room', 'peer-a'),
    url: 'wss://relay.example.test/ws',
    now,
  });
  assert.equal(await verifySignedRelayRecord(providerRecord, { now }), true);
  assert.equal(await verifySignedRelayRecord(providerRecord, { now: providerRecord.expires_at_ms }), false);
});

test('relay identity rejects a mismatched UnSEA key pair', async () => {
  const left = await generateRandomPair();
  const right = await generateRandomPair();
  await assert.rejects(() => createRelayIdentity(left.pub, right.priv), /do not match/);
});
