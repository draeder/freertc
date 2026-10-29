// A relay behind NAT is reached through a tunnel it opens to a public relay:
// HTTP and WebSockets sent to wss://<home>/t/<node id>/ws arrive at the relay.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';

import { generateRandomPair } from 'unsea';
import WebSocket, { WebSocketServer } from 'ws';

import { installWebSocketPair, serverSocketOf } from '../src/node/websocket-pair.js';
import { nodeDurableNamespace } from '../src/node/durable-object.js';
import { createRelayIdentity, tunnelNodeIdOf } from '../src/relay-identity.js';
import { RelayTunnel } from '../src/tunnel/home.js';
import { startTunnel } from '../src/tunnel/client.js';
import { tunnelRoute } from '../src/tunnel/frames.js';

installWebSocketPair();

/** A home: an HTTP server that sends /t/<node id>/... to that node's tunnel object. */
async function startHome(t) {
  const tunnels = nodeDurableNamespace(RelayTunnel, {});
  const route = (request) => {
    const target = tunnelRoute(new URL(request.url).pathname);
    if (!target) return new Response('not found', { status: 404 });
    return tunnels.get(tunnels.idFromName(target.nodeId)).fetch(request);
  };
  const toRequest = (req, body) => new Request(`http://${req.headers.host}${req.url}`, {
    method: req.method,
    headers: Object.entries(req.headers).filter(([, value]) => typeof value === 'string'),
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
  });
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const response = await route(toRequest(req, Buffer.concat(chunks)));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', async (req, socket, head) => {
    const response = await route(toRequest(req));
    const serverSocket = serverSocketOf(response);
    if (!serverSocket) {
      socket.end(`HTTP/1.1 ${response.status} No\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => serverSocket.attach(ws));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { wss.close(); server.close(); server.closeAllConnections?.(); });
  return `ws://127.0.0.1:${server.address().port}/ws`;
}

async function identity() {
  const pair = await generateRandomPair();
  return createRelayIdentity(pair.pub, pair.priv);
}

function relayBehindNat(t, homeUrl, id, overrides = {}) {
  const streams = [];
  const tunnel = startTunnel({
    homes: [homeUrl],
    identity: id,
    name: 'nat-relay',
    handleRequest: async (request) => new Response(JSON.stringify({
      method: request.method,
      path: new URL(request.url).pathname + new URL(request.url).search,
      body: request.method === 'POST' ? await request.text() : null,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    handleStream: (socket, info) => {
      streams.push(info);
      socket.on('message', (data) => socket.send(`echo:${data}`));
    },
    ...overrides,
  });
  t.after(() => tunnel.close());
  return { tunnel, streams };
}

test('HTTP and WebSockets sent to a relay\'s tunnel address reach the relay', async (t) => {
  const home = await startHome(t);
  const id = await identity();
  const { tunnel, streams } = relayBehindNat(t, home, id);
  const url = await tunnel.ready;
  assert.equal(url, home.replace(/\/ws$/, `/t/${id.nodeId}/ws`));
  assert.equal(tunnelNodeIdOf(url), id.nodeId);

  const base = url.replace(/^ws/, 'http').replace(/\/ws$/, '');
  const get = await (await fetch(`${base}/api/v1/peers?network=n&room=r`)).json();
  assert.deepEqual(get, { method: 'GET', path: '/api/v1/peers?network=n&room=r', body: null });
  const post = await (await fetch(`${base}/api/v1/kad/find`, { method: 'POST', body: '{"target":"x"}' })).json();
  assert.deepEqual(post, { method: 'POST', path: '/api/v1/kad/find', body: '{"target":"x"}' });

  const peer = new WebSocket(url);
  await once(peer, 'open');
  peer.send('hello');
  const [reply] = await once(peer, 'message');
  assert.equal(String(reply), 'echo:hello');
  assert.equal(streams[0].path, '/ws');
  peer.close();
});

test('a relay that cannot sign for a node id does not get its tunnel', async (t) => {
  const home = await startHome(t);
  const real = await identity();
  const impostor = await identity();
  // Claims the real node id with a key that is not its own.
  relayBehindNat(t, home, { ...impostor, nodeId: real.nodeId });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const response = await fetch(`${home.replace(/^ws/, 'http').replace(/\/ws$/, '')}/t/${real.nodeId}/api/v1/peers`);
  assert.equal(response.status, 502, 'nothing is connected for that node');
});

test('a relay that reconnects replaces its old tunnel', async (t) => {
  const home = await startHome(t);
  const id = await identity();
  const first = relayBehindNat(t, home, id);
  await first.tunnel.ready;
  first.tunnel.close();
  const second = relayBehindNat(t, home, id, {
    handleRequest: async () => new Response('second', { status: 200 }),
  });
  const url = await second.tunnel.ready;
  await new Promise((resolve) => setTimeout(resolve, 100));
  const text = await (await fetch(`${url.replace(/^ws/, 'http').replace(/\/ws$/, '')}/health`)).text();
  assert.equal(text, 'second');
});

test('without a connected relay the tunnel address answers 502, not a hang', async (t) => {
  const home = await startHome(t);
  const id = await identity();
  const response = await fetch(`${home.replace(/^ws/, 'http').replace(/\/ws$/, '')}/t/${id.nodeId}/health`);
  assert.equal(response.status, 502);
});

test('a signed record may name only its own tunnel address', async () => {
  const { createSignedNodeRecord, verifySignedRelayRecord } = await import('../src/relay-identity.js');
  const mine = await identity();
  const other = await identity();
  const own = await createSignedNodeRecord(mine, { url: `wss://peer.ooo/t/${mine.nodeId}/ws` });
  assert.equal(own.url, `wss://peer.ooo/t/${mine.nodeId}/ws`, 'the tunnel path survives normalisation');
  assert.equal(await verifySignedRelayRecord(own), true);
  const stolen = await createSignedNodeRecord(mine, { url: `wss://peer.ooo/t/${other.nodeId}/ws` });
  assert.equal(await verifySignedRelayRecord(stolen), false);
  const plain = await createSignedNodeRecord(mine, { url: 'wss://peer.ooo/some/other/path' });
  assert.equal(plain.url, 'wss://peer.ooo/ws', 'any other path is still /ws');
});

test('a tunnel that stops answering is dropped, and the relay comes back on a new one', async (t) => {
  const home = await startHome(t);
  const id = await identity();
  let calls = 0;
  const logs = [];
  const { tunnel } = relayBehindNat(t, home, id, {
    // The first request is swallowed, as by a connection that died without either end being told.
    handleRequest: async () => (++calls === 1 ? new Promise(() => {}) : new Response('back', { status: 200 })),
    log: (line) => logs.push(line),
  });
  const url = await tunnel.ready;
  const base = url.replace(/^ws/, 'http').replace(/\/ws$/, '');
  const first = await fetch(`${base}/health`);
  assert.equal(first.status, 504);
  let text = null;
  for (let i = 0; i < 40 && text !== 'back'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const response = await fetch(`${base}/health`);
    if (response.status === 200) text = await response.text();
  }
  assert.equal(text, 'back');
  assert.ok(logs.some((line) => /closed \(1011 Tunnel stopped answering\) after \d+s; reconnecting/.test(line)), logs.join('\n'));
});
