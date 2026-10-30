// Run by test/direct.test.js in its own process: a WebRTC client connects to
// the direct listener over loopback with no signaling. node-datachannel's
// native threads can outlive the work, so this exits explicitly.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startDirectListener } from '../../src/direct/listener.js';
import { loadOrCreateDirectCertificate } from '../../src/direct/cert.js';
import { directRelayUrl } from '../../src/direct/common.js';
import { directRelayChannel } from '../../src/direct/dial.js';

const out = {};
try {
  const { RTCPeerConnection } = await import('node-datachannel/polyfill');
  const cert = loadOrCreateDirectCertificate(mkdtempSync(path.join(tmpdir(), 'freertc-direct-')));
  const port = Number(process.argv[2]);
  const listener = await startDirectListener({
    port, bindAddress: '127.0.0.1', certFile: cert.certFile, keyFile: cert.keyFile,
    onSocket: (socket) => socket.on('message', (m) => socket.send(`echo:${m}`)),
  });
  const { pc, channel } = await directRelayChannel(directRelayUrl({ host: '127.0.0.1', port, fingerprint: cert.fingerprint }), { PeerConnection: RTCPeerConnection });
  out.reply = await new Promise((resolve) => { channel.onmessage = (e) => resolve(String(e.data)); channel.send('hello'); });
  pc.close();
  try {
    await directRelayChannel(directRelayUrl({ host: '127.0.0.1', port, fingerprint: 'b'.repeat(64) }), { PeerConnection: RTCPeerConnection, timeoutMs: 3000 });
    out.wrongFingerprint = 'connected';
  } catch (error) {
    out.wrongFingerprint = `refused: ${error.message}`;
  }
  listener.close();
} catch (error) {
  out.error = String(error?.message || error);
}
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(0);
