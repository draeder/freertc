import assert from 'node:assert/strict';
import test from 'node:test';

import {
  claimLivePeer,
  deleteLivePeerIfOwned,
  forwardFederatedMessage,
  forwardToRelay,
  getPeerRelayHint,
  rememberPeerRelayHint,
} from '../src/index.js';

test('a replaced WebSocket cannot reclaim or delete the newer live peer route', () => {
  const key = '["network-a","room-a","peer-a"]';
  const oldSocket = {};
  const newSocket = {};
  const peers = new Map();

  assert.equal(claimLivePeer(peers, key, {
    socket: oldSocket,
    socketGeneration: 1,
  }), true);
  assert.equal(claimLivePeer(peers, key, {
    socket: newSocket,
    socketGeneration: 2,
  }), true);
  assert.equal(claimLivePeer(peers, key, {
    socket: oldSocket,
    socketGeneration: 1,
  }), false);
  assert.equal(deleteLivePeerIfOwned(peers, key, oldSocket), false);
  assert.equal(peers.get(key).socket, newSocket);
  assert.equal(deleteLivePeerIfOwned(peers, key, newSocket), true);
  assert.equal(peers.has(key), false);
});

test('cross-relay forwarding consumes the HTTP response body', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  let response;

  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    response = new Response(JSON.stringify({ ok: true, delivered: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    return response;
  };

  try {
    const message = {
      psp_version: '1.0',
      type: 'offer',
      network: 'network-a',
      from: 'peer-a',
      to: 'peer-b',
      session_id: 'room-a',
      message_id: 'message-a',
      timestamp: Date.now(),
      ttl_ms: null,
      reply_to: null,
      body: { sdp: { type: 'offer', sdp: 'v=0\r\n' } },
    };

    assert.equal(await forwardToRelay('wss://relay-b.example/ws', message, 'relay-a'), true);
    assert.equal(request.url, 'https://relay-b.example/api/v1/relay');
    assert.equal(request.method, 'POST');
    assert.equal(response.bodyUsed, true);
    assert.deepEqual(await request.json(), { message, via: 'relay-a' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a remote queue response is not mistaken for live delivery', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true,
    delivered: false,
    queued: true,
  }), {
    status: 202,
    headers: { 'Content-Type': 'application/json' },
  });

  try {
    assert.equal(await forwardToRelay('wss://relay-b.example/ws', {
      psp_version: '1.0',
      type: 'offer',
      network: 'network-a',
      from: 'peer-a',
      to: 'peer-b',
      session_id: 'room-a',
      message_id: 'message-a',
      timestamp: Date.now(),
      ttl_ms: null,
      reply_to: null,
      body: {},
    }, 'wss://relay-a.example/ws'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fresh discovery route hints bypass a Kademlia lookup in both relay directions', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    requests.push(new Request(input, init));
    return new Response(JSON.stringify({ ok: true, delivered: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const now = Date.now();
  rememberPeerRelayHint('network-hint', 'room-hint', 'peer-b', 'wss://relay-b.example/ws', now);
  assert.equal(
    getPeerRelayHint('network-hint', 'room-hint', 'peer-b', now + 1),
    'wss://relay-b.example/ws',
  );
  assert.equal(getPeerRelayHint('network-hint', 'other-room', 'peer-b', now + 1), null);

  const message = {
    psp_version: '1.0',
    type: 'offer',
    network: 'network-hint',
    from: 'peer-a',
    to: 'peer-b',
    session_id: 'room-hint',
    message_id: 'message-hint',
    timestamp: now,
    ttl_ms: null,
    reply_to: null,
    body: {},
  };

  try {
    assert.equal(await forwardFederatedMessage(
      {},
      'wss://relay-a.example/ws',
      'network-hint',
      'room-hint',
      message,
    ), true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://relay-b.example/api/v1/relay');
    assert.deepEqual(await requests[0].json(), {
      message,
      via: 'wss://relay-a.example/ws',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
