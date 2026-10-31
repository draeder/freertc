import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHttpResponse, dechunk, isIpLiteralHost, relayFetch } from '../src/relay-fetch.js';
import { handleReachableRequest } from '../src/direct/reachable.js';

const bytes = (text) => new TextEncoder().encode(text);

test('a response with Content-Length is parsed', async () => {
  const response = parseHttpResponse(bytes('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{"ok":true}trailing'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.deepEqual(await response.json(), { ok: true });
});

test('a chunked response (as Node sends it) is decoded', async () => {
  const response = parseHttpResponse(bytes('HTTP/1.1 404 Not Found\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n7;x=1\r\n, world\r\n0\r\n\r\n'));
  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'hello, world');
  assert.equal(new TextDecoder().decode(dechunk(bytes('3\r\nabc\r\n0\r\n\r\n'))), 'abc');
});

test('a response read until close, with no length, keeps its whole body', async () => {
  const response = parseHttpResponse(bytes('HTTP/1.0 200 OK\r\n\r\nall of it'));
  assert.equal(await response.text(), 'all of it');
});

test('a broken response is refused', () => {
  assert.throws(() => parseHttpResponse(bytes('HTTP/1.1 200 OK\r\nContent-Length: 2')));
  assert.throws(() => parseHttpResponse(bytes('garbage\r\n\r\n')));
});

test('only bare IP hosts take the TCP path; outside a Worker everything is fetch', async () => {
  assert.equal(isIpLiteralHost('67.52.200.58'), true);
  assert.equal(isIpLiteralHost('[2001:db8::1]'), true);
  assert.equal(isIpLiteralHost('peer.ooo'), false);
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(`fetched ${url}`);
  try {
    assert.equal(await (await relayFetch('http://203.0.113.5:8788/health')).text(), 'fetched http://203.0.113.5:8788/health');
  } finally {
    globalThis.fetch = original;
  }
});

const NODE = 'a'.repeat(64);
const probe = (body, ip = '203.0.113.5') => new Request('https://peer.ooo/api/v1/reachable', {
  method: 'POST', body: JSON.stringify(body), headers: ip ? { 'CF-Connecting-IP': ip } : {},
});

test('the reachability check calls only the caller\'s own address, and needs that relay to answer', async () => {
  const called = [];
  const answer = (health, status = 200) => async (url) => { called.push(url); return new Response(JSON.stringify(health), { status }); };

  let result = await (await handleReachableRequest(probe({ port: 8788, node_id: NODE }), { fetchImpl: answer({ ok: true, node_id: NODE }) })).json();
  assert.equal(result.reachable, true);
  assert.equal(called.at(-1), 'http://203.0.113.5:8788/health');

  result = await (await handleReachableRequest(probe({ port: 8788, node_id: NODE }), { fetchImpl: answer({ ok: true, node_id: 'b'.repeat(64) }) })).json();
  assert.equal(result.reachable, false, 'another relay at that address does not count');

  result = await (await handleReachableRequest(probe({ port: 8788, node_id: NODE }), { fetchImpl: async () => { throw new Error('connection refused'); } })).json();
  assert.equal(result.reachable, false);
  assert.match(result.why, /refused/);

  result = await (await handleReachableRequest(probe({ port: 8788, node_id: NODE }, '2001:db8::7'), { fetchImpl: answer({ node_id: NODE }) })).json();
  assert.equal(called.at(-1), 'http://[2001:db8::7]:8788/health');

  for (const bad of [{ port: 25, node_id: NODE }, { port: 70000, node_id: NODE }, { port: 8788, node_id: 'x' }]) {
    assert.equal((await handleReachableRequest(probe(bad), { fetchImpl: answer({}) })).status, 400);
  }
  assert.equal((await handleReachableRequest(probe({ port: 8788, node_id: NODE }, null), { fetchImpl: answer({}) })).status, 400);
});
