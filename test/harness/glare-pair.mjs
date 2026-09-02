// Two werift peers started together in one throwaway room: the watcher↔watcher glare case.
const gitpigeonDir = process.env.GITPIGEON_DIR || `${process.env.HOME}/Documents/ChatGPT/GitPigeon`;
const { installNativeWebRTC } = await import(`${gitpigeonDir}/src/webrtc.js`);
const room = process.env.ROOM || `glare-${Date.now()}`;
const label = process.env.LABEL || 'x';
const runMs = Number(process.env.RUN_MS || 60_000);
const t0 = Date.now();
const log = (m) => console.log(`[${label} +${((Date.now() - t0) / 1000).toFixed(2)}s] ${m}`);
await installNativeWebRTC();
const { PeerPigeonNode } = await import('peerpigeon');
const node = new PeerPigeonNode({
  crypto: { roomId: `harness:${room}`, roomSecret: 'glare-secret-0123456789abcdef' },
  networkId: 'gitpigeon-harness-v1',
  sessionId: room,
});
let connects = 0, disconnects = 0;
node.mesh.on('signaling:log', ({ message } = {}) => { if (/withdrawn|duplicate|rolled back|colliding|released|stalled/.test(message)) log(`sig: ${message}`); });
node.on('peerConnected', (p) => { connects += 1; log(`CONNECTED ${String(p).slice(0, 12)}`); });
node.on('peerDisconnected', (p) => { disconnects += 1; log(`disconnected ${String(p).slice(0, 12)}`); });
node.on('error', (e) => log(`error: ${e?.message ?? e}`));
await node.start();
log('started');
setTimeout(() => { log(`SUMMARY connects=${connects} disconnects=${disconnects} peers=${node.getConnectedPeers().length}`); process.exit(0); }, runMs);
