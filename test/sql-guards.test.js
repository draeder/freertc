// The overlay's and the registry's writes are guarded in SQL: an upsert that does nothing when
// the row still has most of its life left. A test double that imitates that proves little, so
// these run the worker's actual statements on a real SQLite engine (skipped on a Node without one).
import assert from 'node:assert/strict';
import test from 'node:test';

import { generateRandomPair } from 'unsea';
import { upsertAnnouncement } from '../src/index.js';
import {
  createRelayIdentity,
  createSignedNodeRecord,
} from '../src/relay-identity.js';
import {
  handleKademliaRequest,
  heartbeatKademlia,
  lookupRoomProviders,
  publishPeerProviderRecords,
} from '../src/relay-overlay.js';
import { openSqliteD1 } from './harness/sqlite-d1.js';

const T0 = 1_800_000_000_000;

/** Runs `body` with Date.now() under the test's control. */
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

const rows = (d1, sql, ...values) => d1.raw.prepare(sql).all(...values);

test('a live peer is renewed at half its lease, not on every heartbeat', async (t) => {
  const d1 = await openSqliteD1();
  if (!d1) return t.skip('node:sqlite is not available on this Node');
  const announce = (session = 'room-a') => upsertAnnouncement(d1, { network: 'net', from: 'peer-a', session_id: session, ttl_ms: 30_000 });
  const lease = () => rows(d1, 'SELECT expires_at_ms FROM psp_announcements')[0].expires_at_ms;

  await withClock(T0, async (clock) => {
    await announce();
    assert.equal(d1.writes.psp_announcements, 1);
    assert.equal(lease(), T0 + 30_000);

    clock.advance(12_000); // the client's heartbeat: 18 s of the lease remain, over half
    await announce();
    assert.equal(d1.writes.psp_announcements, 1, 'a lease with most of its life left is not rewritten');
    assert.equal(lease(), T0 + 30_000);

    clock.advance(12_000); // 6 s remain: renewed before it can lapse
    await announce();
    assert.equal(d1.writes.psp_announcements, 2);
    assert.equal(lease(), T0 + 24_000 + 30_000);

    clock.advance(1_000);
    await announce('room-b'); // another room is its own announcement, never skipped
    assert.equal(d1.writes.psp_announcements, 3);
  });
  assert.equal(rows(d1, 'SELECT COUNT(*) AS n FROM psp_announcements')[0].n, 2, 'one announcement per room');
});

test('a peer that stops heartbeating still lapses on the lease it was given', async (t) => {
  const d1 = await openSqliteD1();
  if (!d1) return t.skip('node:sqlite is not available on this Node');
  await withClock(T0, async (clock) => {
    await upsertAnnouncement(d1, { network: 'net', from: 'peer-a', session_id: 'room-a', ttl_ms: 30_000 });
    clock.advance(12_000);
    await upsertAnnouncement(d1, { network: 'net', from: 'peer-a', session_id: 'room-a', ttl_ms: 30_000 });
    clock.advance(20_000); // past the original 30 s lease; no renewal came
    const live = rows(d1, 'SELECT peer_id FROM psp_announcements WHERE expires_at_ms > ?1', clock.now());
    assert.deepEqual(live, []);
  });
});

test('a known contact costs one write per half-life on a real engine, and the prune still runs', async (t) => {
  const d1 = await openSqliteD1();
  if (!d1) return t.skip('node:sqlite is not available on this Node');
  const [pairA, pairB] = await Promise.all([generateRandomPair(), generateRandomPair()]);
  const identityB = await createRelayIdentity(pairB.pub, pairB.priv);
  const env = { DB: d1, RELAY_SIGNING_PUBLIC_KEY: pairA.pub, RELAY_SIGNING_PRIVATE_KEY: pairA.priv };
  const hear = async (now) => (await handleKademliaRequest(
    new Request('https://relay-a.example/api/v1/kad/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requester: await createSignedNodeRecord(identityB, { url: 'wss://relay-b.example/ws', now }) }),
    }),
    env,
    { selfUrl: 'wss://relay-a.example/ws' },
  ));

  await withClock(T0, async (clock) => {
    for (let i = 0; i < 25; i += 1) {
      assert.equal((await hear(clock.now())).status, 200);
      clock.advance(1_000);
    }
    assert.equal(d1.writes.psp_kad_nodes, 1, 'twenty-five messages from one contact are one row written');

    clock.advance(160_000); // past half of the five-minute record
    assert.equal((await hear(clock.now())).status, 200);
    assert.equal(d1.writes.psp_kad_nodes, 2);
  });
  assert.equal(rows(d1, 'SELECT COUNT(*) AS n FROM psp_kad_nodes')[0].n, 1);
});

test('two relays on real SQLite join, announce a room, and find it', async (t) => {
  const [dbA, dbB] = [await openSqliteD1(), await openSqliteD1()];
  if (!dbA || !dbB) return t.skip('node:sqlite is not available on this Node');
  const [pairA, pairB] = await Promise.all([generateRandomPair(), generateRandomPair()]);
  const urlA = 'wss://relay-a.example/ws';
  const urlB = 'wss://relay-b.example/ws';
  const envA = { DB: dbA, RELAY_SIGNING_PUBLIC_KEY: pairA.pub, RELAY_SIGNING_PRIVATE_KEY: pairA.priv, KADEMLIA_BOOTSTRAP_URLS: urlB };
  const envB = { DB: dbB, RELAY_SIGNING_PUBLIC_KEY: pairB.pub, RELAY_SIGNING_PRIVATE_KEY: pairB.priv };
  const relays = new Map([['relay-a.example', { env: envA, selfUrl: urlA }], ['relay-b.example', { env: envB, selfUrl: urlB }]]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const target = relays.get(new URL(request.url).hostname);
    if (!target) return new Response('not found', { status: 404 });
    return handleKademliaRequest(request, target.env, { selfUrl: target.selfUrl });
  };
  try {
    await withClock(T0, async (clock) => {
      assert.equal((await heartbeatKademlia(envA, urlA)).joined, true);
      assert.equal((await heartbeatKademlia(envA, urlA)).joined, false);

      for (let i = 0; i < 10; i += 1) {
        await publishPeerProviderRecords(envA, urlA, 'net', 'room', `peer-${i}`, { connections: i });
        clock.advance(1_000);
      }
      const found = await lookupRoomProviders(envB, urlB, 'net', 'room');
      assert.deepEqual(found.map((record) => record.url), [urlA]);
      assert.equal(rows(dbB, 'SELECT COUNT(*) AS n FROM psp_kad_records')[0].n, 1, 'ten peers, one room record');
      assert.equal(rows(dbB, "SELECT COUNT(*) AS n FROM psp_kad_records WHERE kind = 'peer_provider'")[0].n, 0);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});
