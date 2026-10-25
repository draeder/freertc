#!/usr/bin/env node
// Two peers in one room, each reaching a (possibly different) relay either
// over WebSocket or through a hole-punched channel. Passes only when each
// peer appears in the other's peer list and a relayed offer/answer crosses
// between them.
//
//   node scripts/federation-demo.mjs ws:ws://127.0.0.1:8801/ws ws:ws://127.0.0.1:8802/ws
//   node scripts/federation-demo.mjs punch:local-relay-1 ws:ws://127.0.0.1:8801/ws
import WebSocket from 'ws';
import { dialPunched } from '../src/punch/transport.js';

const RENDEZVOUS = process.env.PUNCH_RENDEZVOUS_URL || 'http://127.0.0.1:8790';
const WAIT_MS = Number(process.env.WAIT_MS || 30_000);
const [specA, specB] = process.argv.slice(2);
const NETWORK = `fedtest-${Date.now().toString(36)}`;
const ROOM = 'room-1';
const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s`;

async function open(spec) {
  const [kind, target] = [spec.slice(0, spec.indexOf(':')), spec.slice(spec.indexOf(':') + 1)];
  if (kind === 'punch') return dialPunched({ rendezvousUrl: RENDEZVOUS, listenerId: target });
  const ws = new WebSocket(target);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return ws;
}

const envelope = (type, from, extra = {}) => ({
  psp_version: '1.0', type, network: NETWORK, from, to: null, session_id: ROOM,
  message_id: `${type}-${crypto.randomUUID()}`, timestamp: Date.now(), ttl_ms: 30_000,
  body: type === 'announce' ? { instance_id: NETWORK, hints: { wants_peers: true } } : {}, ...extra,
});

const peers = [{ name: 'peer-A', spec: specA, inbox: [] }, { name: 'peer-B', spec: specB, inbox: [] }];
for (const peer of peers) {
  peer.socket = await open(peer.spec);
  console.log(ts(), `${peer.name} connected via ${peer.spec}`);
  peer.socket.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    peer.inbox.push(message);
    if (message.type === 'peer_list') console.log(ts(), `${peer.name} <- peer_list [${message.body.peers.map((p) => p.peer_id).join(', ')}]`);
    else if (['offer', 'answer'].includes(message.type)) console.log(ts(), `${peer.name} <- ${message.type} from ${message.from}`);
  });
  peer.socket.send(JSON.stringify(envelope('announce', peer.name)));
}

const [a, b] = peers;
const sees = (peer, id) => peer.inbox.some((m) => m.type === 'peer_list' && m.body.peers.some((p) => p.peer_id === id));
const deadline = Date.now() + WAIT_MS;
while (Date.now() < deadline && !(sees(a, 'peer-B') && sees(b, 'peer-A'))) {
  await new Promise((r) => setTimeout(r, 2_000));
  for (const peer of peers) if (!sees(peer, peer === a ? 'peer-B' : 'peer-A')) peer.socket.send(JSON.stringify(envelope('discover', peer.name)));
}
const found = sees(a, 'peer-B') && sees(b, 'peer-A');
let relayed = false;
if (found) {
  a.socket.send(JSON.stringify(envelope('offer', 'peer-A', { to: 'peer-B', body: { sdp: 'test' } })));
  const end = Date.now() + 10_000;
  while (Date.now() < end && !b.inbox.some((m) => m.type === 'offer')) await new Promise((r) => setTimeout(r, 100));
  if (b.inbox.some((m) => m.type === 'offer')) {
    b.socket.send(JSON.stringify(envelope('answer', 'peer-B', { to: 'peer-A', body: { sdp: 'test' } })));
    const end2 = Date.now() + 10_000;
    while (Date.now() < end2 && !a.inbox.some((m) => m.type === 'answer')) await new Promise((r) => setTimeout(r, 100));
    relayed = a.inbox.some((m) => m.type === 'answer');
  }
}
console.log(`\nRESULT ${found && relayed ? 'PASS' : 'FAIL'}: A sees B=${sees(a, 'peer-B')}, B sees A=${sees(b, 'peer-A')}, offer/answer crossed=${relayed}`);
for (const peer of peers) peer.socket.close();
process.exit(found && relayed ? 0 : 1);
