const gitpigeonDir = process.env.GITPIGEON_DIR || `${process.env.HOME}/Documents/ChatGPT/GitPigeon`;
const { installNativeWebRTC } = await import(`${gitpigeonDir}/src/webrtc.js`);
import { tapRTC } from './rtc-tap.js';
const room = process.env.ROOM || 'harness-room';
const secret = process.env.SECRET || 'harness-secret-0123456789abcdef';
const started = Date.now();
const log = (m) => console.log(`[node ${new Date().toISOString().slice(11, 23)}] ${m}`);
await installNativeWebRTC();
tapRTC(log);
const { PeerPigeonNode } = await import('peerpigeon');
const node = new PeerPigeonNode({
  crypto: { roomId: `harness:${room}`, roomSecret: secret },
  networkId: 'gitpigeon-harness-v1',
  sessionId: room,
});
node.mesh.on('identity:ready', ({ clientId } = {}) => log(`identity ${String(clientId).slice(0, 12)}`));
node.mesh.on('signaling:connected', ({ signalingServer } = {}) => log(`signaling via ${signalingServer}`));
node.mesh.on('signaling:log', ({ message } = {}) => log(`sig: ${message}`));
node.mesh.on('peer:discovered', (p) => log(`discovered ${String(p).slice(0, 12)}`));
node.on('peerConnected', (p) => log(`PEER CONNECTED ${String(p).slice(0, 12)} after ${((Date.now() - started) / 1000).toFixed(1)}s`));
node.on('peerDisconnected', (p) => log(`peer disconnected ${String(p).slice(0, 12)}`));
node.on('error', (e) => log(`error: ${e?.message ?? e}`));
await node.start();
log('started');
setInterval(() => log(`peers=${node.getConnectedPeers().map((p) => p.slice(0, 12)).join(',') || '-'}`), 10_000);
setTimeout(() => { log('exiting'); process.exit(0); }, Number(process.env.RUN_MS || 240_000));
