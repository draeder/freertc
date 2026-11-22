// Who runs a relay (src/relay-owner.js): the relay signs its owner for the
// asker's nonce, and the console checks that answer.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { generateRandomPair } from 'unsea';
import worker from '../src/index.js';
import { encodeRelayIdentitySecret } from '../src/relay-identity.js';
import { relayNodeIdOf } from '../src/relay-overlay.js';
import { ownerProof, verifyOwnerProof } from '../src/relay-owner.js';
import { readOwnerFile, removeOwnerFile, writeOwnerFile } from '../src/node/owner-file.js';
import { MemoryD1 } from './harness/memory-d1.js';

const NONCE = 'nonce-0123456789abcdef';

async function relayEnv(extra = {}) {
  const pair = await generateRandomPair();
  return { DB: new MemoryD1(), RELAY_IDENTITY_SECRET: encodeRelayIdentitySecret(pair.pub, pair.priv), ...extra };
}

async function ask(env, nonce = NONCE) {
  const response = await worker.fetch(new Request(`https://owned.example/api/v1/owner?nonce=${nonce}`), env, { waitUntil() {} });
  return { status: response.status, cors: response.headers.get('access-control-allow-origin'), body: await response.json() };
}

test('a relay names its owner, signed for the nonce, and the answer checks out', async () => {
  const owner = (await generateRandomPair()).pub;
  const env = await relayEnv({ RELAY_OWNER: owner });
  const { status, cors, body } = await ask(env);
  assert.equal(status, 200);
  assert.equal(cors, '*', 'the console reads it from another origin');
  assert.equal(body.owner, owner);
  assert.equal(body.node_id, await relayNodeIdOf(env), 'the same node id as /health and the registry');
  assert.equal(await verifyOwnerProof(body, { nonce: NONCE, nodeId: body.node_id, owner }), true);
});

test('an answer does not check out for another nonce, owner, node id or relay key', async () => {
  const owner = (await generateRandomPair()).pub;
  const { body } = await ask(await relayEnv({ RELAY_OWNER: owner }));
  assert.equal(await verifyOwnerProof(body, { nonce: 'another-nonce-0123456', owner }), false, 'replayed');
  assert.equal(await verifyOwnerProof(body, { nonce: NONCE, owner: (await generateRandomPair()).pub }), false);
  assert.equal(await verifyOwnerProof(body, { nonce: NONCE, owner, nodeId: 'f'.repeat(64) }), false);
  const other = (await generateRandomPair()).pub;
  assert.equal(await verifyOwnerProof({ ...body, relay_pub: other }, { nonce: NONCE, owner }), false, 'a key that is not the node id');
  // A character in the middle: the last one of a base64url signature can carry unused bits.
  const mid = Math.floor(body.signature.length / 2);
  const flipped = body.signature.slice(0, mid) + (body.signature[mid] === 'A' ? 'B' : 'A') + body.signature.slice(mid + 1);
  assert.equal(await verifyOwnerProof({ ...body, signature: flipped }, { nonce: NONCE, owner }), false);
});

test('a relay without an owner, or without an identity, says so', async () => {
  const unowned = await ask(await relayEnv());
  assert.equal(unowned.body.ok, true);
  assert.equal(unowned.body.owner, null);
  const anonymous = await ask({ DB: new MemoryD1() });
  assert.deepEqual(anonymous.body, { ok: false, error: 'no identity' });
});

test('a bad nonce is refused', async () => {
  const { status } = await ask(await relayEnv(), 'short');
  assert.equal(status, 400);
});

test('a Node relay reads its owner from owner.json on each ask', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'freertc-owner-'));
  const env = await relayEnv({ RELAY_OWNER: () => readOwnerFile(dir) });
  assert.equal((await ownerProof(env, NONCE)).body.owner, null);
  const owner = (await generateRandomPair()).pub;
  writeOwnerFile(dir, owner);
  assert.equal((await ownerProof(env, NONCE)).body.owner, owner, 'no restart needed');
  assert.equal(removeOwnerFile(dir), true);
  assert.equal((await ownerProof(env, NONCE)).body.owner, null);
  assert.throws(() => writeOwnerFile(dir, 'not a key'));
});

test('the owner, and nobody else, may read the relay\'s numbers from elsewhere', async () => {
  const { signMessage } = await import('unsea');
  const { ownerAsked, ownerStatsText } = await import('../src/relay-owner.js');
  const owner = await generateRandomPair();
  const env = await relayEnv({ RELAY_OWNER: owner.pub });
  const nodeId = await relayNodeIdOf(env);
  const at = Date.now();
  assert.equal(await ownerAsked(env, at, await signMessage(ownerStatsText(nodeId, at), owner.priv)), true);
  const stranger = await generateRandomPair();
  assert.equal(await ownerAsked(env, at, await signMessage(ownerStatsText(nodeId, at), stranger.priv)), false);
  assert.equal(await ownerAsked(env, at, await signMessage(ownerStatsText('a'.repeat(64), at), owner.priv)), false, 'another relay\'s');
  const old = at - 10 * 60_000;
  assert.equal(await ownerAsked(env, old, await signMessage(ownerStatsText(nodeId, old), owner.priv)), false, 'too old');
  assert.equal(await ownerAsked(await relayEnv(), at, await signMessage(ownerStatsText(nodeId, at), owner.priv)), false, 'no owner');
});
