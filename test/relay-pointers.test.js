// Relay pointers (node records that say what a relay is and how to reach it)
// and punched relay sockets (a client reaches a relay behind NAT over a direct
// data channel introduced through its tunnel, instead of through the tunnel).
import assert from 'node:assert/strict';
import test from 'node:test';

import { generateRandomPair } from 'unsea';
import { openRelaySocket, punchOfferUrlForRelay } from '../src/client.js';
import { createPunchOfferHandler, punchOfferAvailable } from '../src/punch/offer.js';
import {
  createRelayIdentity,
  createSignedNodeRecord,
  normalizeReach,
  verifySignedRelayRecord,
} from '../src/relay-identity.js';
import { punchOfferUrlFor, relayKindOf, relayReachOf } from '../src/relay-overlay.js';

async function identity() {
  const pair = await generateRandomPair();
  return createRelayIdentity(pair.pub, pair.priv);
}

test('a node record signs what the relay is and how to reach it', async () => {
  const id = await identity();
  const url = `wss://home.example/t/${id.nodeId}/ws`;
  const reach = relayReachOf({ PUNCH_OFFER: 'on' }, url);
  assert.deepEqual(reach.map((entry) => entry.via), ['punch', 'tunnel']);
  assert.equal(reach[0].url, `https://home.example/t/${id.nodeId}/api/v1/punch/offer`);
  const record = await createSignedNodeRecord(id, { url, relayKind: 'local', reach });
  assert.equal(record.relay_kind, 'local');
  assert.deepEqual(record.reach, reach);
  assert.equal(await verifySignedRelayRecord(record), true);

  // The pointers are covered by the signature.
  assert.equal(await verifySignedRelayRecord({ ...record, relay_kind: 'cloud' }), false);
  assert.equal(await verifySignedRelayRecord({ ...record, reach: [reach[1]] }), false);
});

test('a relay can only point at its own tunnel, and reach entries are kept in normal form', async () => {
  const id = await identity();
  const other = await identity();
  const reach = normalizeReach([
    { via: 'punch', url: `https://home.example/t/${other.nodeId}/api/v1/punch/offer` },
    { via: 'tunnel', url: `wss://home.example/t/${id.nodeId}/ws` },
    { via: 'teleport', url: 'wss://x.example/ws' },
    { via: 'direct', url: 'ftp://x.example/' },
  ], id.nodeId);
  assert.deepEqual(reach, [{ via: 'tunnel', url: `wss://home.example/t/${id.nodeId}/ws` }]);

  // A record whose reach is not in normal form is refused, so a signed record
  // means exactly one thing.
  const record = await createSignedNodeRecord(id, { url: `wss://home.example/t/${id.nodeId}/ws`, relayKind: 'local', reach });
  assert.equal(await verifySignedRelayRecord(record), true);
});

test('a relay is cloud unless it says local, and a public relay is reached at its own address', () => {
  assert.equal(relayKindOf({}), 'cloud');
  assert.equal(relayKindOf({ RELAY_KIND: 'local' }), 'local');
  assert.equal(relayKindOf({ RELAY_KIND: 'anything' }), 'cloud');
  assert.deepEqual(relayReachOf({}, 'wss://relay.example/ws'), [{ via: 'direct', url: 'wss://relay.example/ws' }]);
  // Without punched connections, a relay behind NAT is reached through its tunnel only.
  const tunnel = `wss://home.example/t/${'a'.repeat(64)}/ws`;
  assert.deepEqual(relayReachOf({}, tunnel), [{ via: 'tunnel', url: tunnel }]);
  assert.equal(punchOfferUrlFor(tunnel), `https://home.example/t/${'a'.repeat(64)}/api/v1/punch/offer`);
  assert.equal(punchOfferUrlForRelay(`${tunnel}?networkId=n&room=r`), punchOfferUrlFor(tunnel));
  assert.equal(punchOfferUrlForRelay('wss://relay.example/ws'), null, 'only a tunnel URL is punched');
});

class FakeWebSocket {
  static opened = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    FakeWebSocket.opened.push(this);
    setTimeout(() => { this.readyState = 1; this.onopen?.({}); }, 0);
  }
  send() {}
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
}

test('a client reaches a relay behind NAT over a punched data channel', { skip: !(await punchOfferAvailable()) && 'no werift' }, async () => {
  const { RTCPeerConnection } = await import('werift');
  const relayUrl = `ws://home.test/t/${'b'.repeat(64)}/ws?networkId=n&room=r`;
  let relaySide = null;
  const relayReceived = [];
  const handler = createPunchOfferHandler({
    RTCPeerConnection,
    iceServers: [],
    gatherTimeoutMs: 1_500,
    onSocket: (socket) => {
      relaySide = socket;
      socket.on('message', (data) => {
        relayReceived.push(String(data));
        socket.send(`echo:${data}`);
      });
    },
  });
  const posted = [];
  const fetchImpl = async (url, init) => {
    posted.push({ url: String(url), contentType: init.headers['Content-Type'] });
    return handler(new Request(url, init));
  };
  FakeWebSocket.opened.length = 0;
  const socket = openRelaySocket(relayUrl, {
    PeerConnection: RTCPeerConnection, iceServers: [], fetchImpl, WebSocketImpl: FakeWebSocket,
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no open')), 15_000);
      socket.onopen = () => { clearTimeout(timer); resolve(); };
    });
    assert.equal(socket.transport, 'punch');
    assert.equal(socket.readyState, 1);
    assert.equal(FakeWebSocket.opened.length, 0, 'the tunnel socket was never opened');
    assert.deepEqual(posted, [{ url: punchOfferUrlForRelay(relayUrl), contentType: 'text/plain' }], 'one simple request');
    const reply = new Promise((resolve) => { socket.onmessage = (event) => resolve(event.data); });
    socket.send('{"type":"ping"}');
    assert.equal(await reply, 'echo:{"type":"ping"}');
    assert.deepEqual(relayReceived, ['{"type":"ping"}']);
    const closed = new Promise((resolve) => { socket.onclose = resolve; });
    socket.close(1000, 'done');
    assert.equal((await closed).code, 1000);
  } finally {
    try { socket.close(); } catch {}
    try { relaySide?.close(); } catch {}
  }
});

test('a relay that will not punch is reached through its tunnel, and not asked again for a while', async () => {
  const relayUrl = `ws://home.test/t/${'c'.repeat(64)}/ws`;
  let posts = 0;
  const fetchImpl = async () => {
    posts += 1;
    return new Response(JSON.stringify({ ok: false, error: 'no WebRTC' }), { status: 501 });
  };
  class StubPeerConnection {
    constructor() { this.iceGatheringState = 'complete'; this.localDescription = { sdp: 'v=0\r\n' }; }
    createDataChannel() { return { close() {} }; }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\n' }; }
    async setLocalDescription() {}
    close() {}
  }
  FakeWebSocket.opened.length = 0;
  const first = openRelaySocket(relayUrl, { PeerConnection: StubPeerConnection, fetchImpl, WebSocketImpl: FakeWebSocket });
  await new Promise((resolve) => { first.onopen = resolve; });
  assert.equal(first.transport, 'tunnel');
  assert.equal(first.readyState, 1);
  assert.equal(FakeWebSocket.opened.length, 1);
  assert.equal(FakeWebSocket.opened[0].url, relayUrl);

  const second = openRelaySocket(relayUrl, { PeerConnection: StubPeerConnection, fetchImpl, WebSocketImpl: FakeWebSocket });
  assert.ok(second instanceof FakeWebSocket, 'straight to the tunnel');
  assert.equal(posts, 1, 'the refusal is remembered');
  first.close();
  second.close();
});
