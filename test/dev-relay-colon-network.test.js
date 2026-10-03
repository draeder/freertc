// The demo's default network is "network:test". The in-memory dev relay used to split its
// announcement key on ":", so for such a network every peer list came back empty and no two
// peers could ever find each other.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

const SERVER = fileURLToPath(new URL('../scripts/non-cloudflare-server.mjs', import.meta.url));
const PORT = 18_700 + Math.floor(Math.random() * 200);
const STARTUP_TIMEOUT_MS = 5000;
const NETWORK = 'network:test';
const ROOM = 'room:test';

const envelope = (type, from, body = {}) => JSON.stringify({
  psp_version: '1.0',
  type,
  network: NETWORK,
  from,
  to: null,
  session_id: ROOM,
  message_id: `${type}-${from}-${Math.random()}`,
  timestamp: Date.now(),
  ttl_ms: 30_000,
  body,
});

async function startRelay() {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
  const deadline = AbortSignal.timeout(STARTUP_TIMEOUT_MS);
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => { if (String(chunk).includes('listening')) resolve(); });
    child.once('exit', (code) => reject(new Error(`relay exited early with ${code}`)));
    deadline.addEventListener('abort', () => reject(new Error('relay did not start')));
  });
  return child;
}

async function connect(onPeerList) {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    if (message.type === 'peer_list') onPeerList(message.body.peers.map((peer) => peer.peer_id));
  });
  await once(socket, 'open');
  return socket;
}

test('peers on a network whose name contains a colon find each other', async () => {
  const relay = await startRelay();
  const sockets = [];
  try {
    const seenByB = [];
    const a = await connect(() => {});
    const b = await connect((ids) => seenByB.push(ids));
    sockets.push(a, b);

    a.send(envelope('announce', 'peer-a-0000000000000001'));
    b.send(envelope('announce', 'peer-b-0000000000000002'));
    b.send(envelope('discover', 'peer-b-0000000000000002', { limit: 16 }));
    await new Promise((resolve) => setTimeout(resolve, 500));

    assert.ok(seenByB.some((ids) => ids.includes('peer-a-0000000000000001')), `peer lists seen: ${JSON.stringify(seenByB)}`);
  } finally {
    for (const socket of sockets) socket.close();
    relay.kill();
  }
});
