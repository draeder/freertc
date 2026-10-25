#!/usr/bin/env node
// A Node stand-in for the worker's rendezvous, for running hole punching
// locally. The worker mounts the same handleRendezvousRequest.
import { createServer } from 'node:http';
import { handleRendezvousRequest, MemoryRendezvousStore } from '../src/punch/rendezvous.js';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8790);
const store = new MemoryRendezvousStore();
const counts = new Map();

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://${req.headers.host}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
  });
  const route = new URL(request.url).pathname;
  counts.set(route, (counts.get(route) ?? 0) + 1);
  if (route === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(Object.fromEntries(counts)));
    return;
  }
  const response = await handleRendezvousRequest(request, store)
    ?? new Response('Not Found', { status: 404 });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});

server.listen(PORT, HOST, () => console.log(`[punch-rendezvous] http://${HOST}:${PORT}`));
