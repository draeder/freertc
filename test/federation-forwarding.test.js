import assert from 'node:assert/strict';
import test from 'node:test';

import { forwardToRelay } from '../src/index.js';

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
