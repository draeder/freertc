import { PeerPigeonNode } from 'peerpigeon';
import { tapRTC } from './rtc-tap.js';
const params = new URLSearchParams(location.search);
const room = params.get('room') || 'harness-room';
const secret = params.get('secret') || 'harness-secret-0123456789abcdef';
const out = document.getElementById('log');
const lines = [];
const log = (m) => { const line = `[web ${new Date().toISOString().slice(11, 23)}] ${m}`; lines.push(line); out.textContent = lines.slice(-400).join('\n'); console.log(line); };
window.harnessLines = lines;
tapRTC(log);
const started = Date.now();
const node = new PeerPigeonNode({
  crypto: { roomId: `harness:${room}`, roomSecret: secret },
  networkId: 'gitpigeon-harness-v1',
  sessionId: room,
});
window.node = node;
node.mesh.on('identity:ready', ({ clientId } = {}) => log(`identity ${String(clientId).slice(0, 12)}`));
node.mesh.on('signaling:connected', ({ signalingServer } = {}) => log(`signaling via ${signalingServer}`));
node.mesh.on('signaling:log', ({ message } = {}) => log(`sig: ${message}`));
node.mesh.on('peer:discovered', (p) => log(`discovered ${String(p).slice(0, 12)}`));
node.on('peerConnected', (p) => log(`PEER CONNECTED ${String(p).slice(0, 12)} after ${((Date.now() - started) / 1000).toFixed(1)}s`));
node.on('peerDisconnected', (p) => log(`peer disconnected ${String(p).slice(0, 12)}`));
node.on('error', (e) => log(`error: ${e?.message ?? e}`));
node.start().then(() => log('started')).catch((e) => log(`start failed: ${e.message}`));
setInterval(() => log(`peers=${node.getConnectedPeers().map((p) => p.slice(0, 12)).join(',') || '-'}`), 10_000);
