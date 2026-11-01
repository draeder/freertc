// Accounts between linked local relays: when a link opens, each side takes
// the other's whole store over it (src/node/account-sync.js).
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { generateRandomPair } from 'unsea';
import { createRelayLinks } from '../src/node/relay-links.js';
import { createAccountSync } from '../src/node/account-sync.js';
import { createRelayIdentity, createSignedNodeRecord } from '../src/relay-identity.js';

let idp = null;
try {
  idp = { ...(await import('pigeonidp/records')), ...(await import('pigeonidp/relay')) };
} catch { /* not installed: skipped */ }

function socketPair() {
  const make = () => Object.assign(new EventEmitter(), { readyState: 1 });
  const a = make();
  const b = make();
  a.send = (data) => setImmediate(() => b.emit('message', data));
  b.send = (data) => setImmediate(() => a.emit('message', data));
  const close = () => { if (a.readyState === 3) return; a.readyState = 3; b.readyState = 3; a.emit('close'); b.emit('close'); };
  a.close = close;
  b.close = close;
  return [a, b];
}

async function relay(name, records = []) {
  const dataDir = mkdtempSync(path.join(tmpdir(), `sync-${name}-`));
  if (records.length) writeFileSync(path.join(dataDir, 'identities.json'), JSON.stringify({ version: 1, records }));
  const events = [];
  const store = await idp.createRelayIdentityStore({ dataDir, onEvent: (e) => events.push(e) });
  const pair = await generateRandomPair();
  const identity = await createRelayIdentity(pair.pub, pair.priv);
  const sync = createAccountSync({ store: () => store, event: (e) => events.push(e) });
  const synced = [];
  const pins = new Map();
  const links = createRelayLinks({
    identity,
    nodeRecord: () => createSignedNodeRecord(identity, { url: `wss://${name}.example/t/${identity.nodeId}/ws`, relayKind: 'local' }),
    handleRequest: async (request) => sync.handleLinkRequest(request) ?? new Response('{}'),
    onLinked: async (nodeId, link) => { synced.push(await sync.syncOver(nodeId, link)); },
    pq: { identity: { pub: pair.pub, priv: pair.priv, qpub: pair.qpub, qpriv: pair.qpriv }, pins: { get: (id) => pins.get(id) ?? null, set: (id, k) => pins.set(id, k) } },
  });
  return { store, links, synced, events };
}

const until = async (check, ms = 8_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test('two relays swap their whole account stores when they link', { skip: !idp && 'pigeonidp not installed' }, async () => {
  const NS = 'pigeon-chess';
  const owner = await generateRandomPair();
  const modern = await idp.createAccountRecord({ alias: 'OnPro', namespace: NS, keys: owner, password: 'pw' });
  const old = await generateRandomPair({ postQuantum: false });
  const legacy = await idp.createAccountRecord({ alias: 'OldOnPro', namespace: NS, keys: old, password: 'pw', legacy: true });
  const other = await generateRandomPair();
  const onAir = await idp.createAccountRecord({ alias: 'OnAir', namespace: NS, keys: other, password: 'pw' });

  const pro = await relay('pro', [modern, legacy]);
  const air = await relay('air', [onAir]);
  const [sa, sb] = socketPair();
  pro.links.accept(sa, { via: 'lan' });
  air.links.accept(sb, { via: 'lan' });
  try {
    await until(() => pro.synced.length && air.synced.length);
    assert.deepEqual(air.synced[0], { stored: 2, skipped: 0 }, 'the Air took both of the Pro\'s accounts, the old one too');
    assert.deepEqual(pro.synced[0], { stored: 1, skipped: 0 });
    for (const node of [pro, air]) {
      assert.equal(node.store.size(), 3);
      for (const alias of ['onpro', 'oldonpro', 'onair']) {
        assert.ok((await node.store.handle({ action: 'idp-get', namespace: NS, alias, from_relay: true })).record, alias);
      }
    }
    assert.ok(air.events.some((e) => /synced \(2 new/.test(e)));
  } finally {
    pro.links.stop();
    air.links.stop();
  }
});
