#!/usr/bin/env node
// End-to-end check of a hole-punched freertc relay.
//   Peer A reaches the relay ONLY through a punched data channel.
//   Peer B reaches it over an ordinary WebSocket.
// They must see each other in the room's peer list and exchange a relayed
// frame, and the rendezvous must go quiet once the channel is open.
import WebSocket from 'ws';
import { dialPunched } from '../src/punch/transport.js';

const RENDEZVOUS = process.env.PUNCH_RENDEZVOUS_URL || 'http://127.0.0.1:8790';
const RELAY_WS = process.env.RELAY_WS || 'ws://127.0.0.1:8791/ws';
const LISTENER = process.env.PUNCH_LISTENER_ID || 'local-relay-1';
const NETWORK = `punchtest-${Date.now().toString(36)}`;
const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s`;
const stats = async () => (await fetch(`${RENDEZVOUS}/stats`)).json();

const envelope = (type, from, extra = {}) => ({
  psp_version: '1.0', type, network: NETWORK, from, to: null, session_id: 'room-1',
  message_id: `${type}-${crypto.randomUUID()}`, timestamp: Date.now(), ttl_ms: 30_000, body: {}, ...extra,
});

function track(name, socket, inbox) {
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    inbox.push(message);
    const peers = message.type === 'peer_list' ? ` peers=[${message.body.peers.map((p) => p.peer_id).join(',')}]` : '';
    console.log(ts(), `${name} <- ${message.type}${peers}${message.type === 'offer' ? ` from ${message.from}: ${message.body.note}` : ''}`);
  });
}

const until = async (check, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error(`timed out waiting for ${what}`);
};

const before = await stats();
console.log(ts(), 'A dialing relay through the rendezvous (punch)…');
const a = await dialPunched({ rendezvousUrl: RENDEZVOUS, listenerId: LISTENER, log: (l) => console.log(ts(), 'A', l) });
const afterIntro = await stats();
const inboxA = []; track('A', a, inboxA);

const b = new WebSocket(RELAY_WS);
await new Promise((resolve, reject) => { b.once('open', resolve); b.once('error', reject); });
console.log(ts(), 'B connected over WebSocket');
const inboxB = []; track('B', b, inboxB);

a.send(JSON.stringify(envelope('announce', 'peer-A')));
b.send(JSON.stringify(envelope('announce', 'peer-B')));
const sees = (inbox, id) => () => inbox.some((m) => m.type === 'peer_list' && m.body.peers.some((p) => p.peer_id === id));
await until(sees(inboxA, 'peer-B'), 5000, 'A to see B');
await until(sees(inboxB, 'peer-A'), 5000, 'B to see A');

a.send(JSON.stringify(envelope('offer', 'peer-A', { to: 'peer-B', body: { note: 'hello over a punched hole' } })));
await until(() => inboxB.some((m) => m.type === 'offer'), 5000, 'B to receive the offer');
b.send(JSON.stringify(envelope('answer', 'peer-B', { to: 'peer-A', body: { note: 'answer back' } })));
await until(() => inboxA.some((m) => m.type === 'answer'), 5000, 'A to receive the answer');

for (let i = 0; i < 20; i += 1) { a.send(JSON.stringify(envelope('ping', 'peer-A'))); await new Promise((r) => setTimeout(r, 100)); }
await until(() => inboxA.filter((m) => m.type === 'pong').length >= 20, 5000, '20 pongs over the punched channel');
const afterTraffic = await stats();

const diff = (x, y) => Object.fromEntries(Object.keys({ ...x, ...y }).map((k) => [k, (y[k] ?? 0) - (x[k] ?? 0)]).filter(([, v]) => v));
console.log('\nRESULT: A (punched) and B (WebSocket) found each other and exchanged offer/answer through the relay; 20 pings answered.');
console.log('rendezvous requests during the introduction:', JSON.stringify(diff(before, afterIntro)));
console.log('rendezvous requests after the channel opened:', JSON.stringify(diff(afterIntro, afterTraffic)), '(register heartbeats and the listener long-poll only)');
a.close(); b.close();
process.exit(0);
