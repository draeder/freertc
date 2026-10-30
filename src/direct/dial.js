// Open a data channel straight to a direct relay (see common.js) with the
// standard WebRTC API, in a browser or with any W3C-compatible RTCPeerConnection.
// The browser's own offer is used exactly as created; only the relay's answer
// is written here.

import { DIRECT_CHANNEL_LABEL, directAnswerSdp, parseDirectRelayUrl, relayIceCredentialFor } from './common.js';

export const DIRECT_OPEN_TIMEOUT_MS = 5_000;

/** Resolves { pc, channel } once the channel is open; rejects if it does not open in time. */
export async function directRelayChannel(url, {
  PeerConnection = globalThis.RTCPeerConnection,
  timeoutMs = DIRECT_OPEN_TIMEOUT_MS,
  label = DIRECT_CHANNEL_LABEL,
} = {}) {
  const target = parseDirectRelayUrl(url);
  if (!target) throw new TypeError(`not a direct relay URL: ${url}`);
  if (typeof PeerConnection !== 'function') throw new Error('WebRTC is not available here');

  const pc = new PeerConnection({ iceServers: [] });
  const channel = pc.createDataChannel(label);
  let timer = null;
  try {
    const opened = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('direct channel did not open')), timeoutMs);
      channel.onopen = () => { clearTimeout(timer); resolve(); };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') { clearTimeout(timer); reject(new Error('direct connection failed')); }
      };
    });
    opened.catch(() => {});
    await pc.setLocalDescription(await pc.createOffer());
    const sdp = pc.localDescription.sdp;
    const ufrag = /a=ice-ufrag:(\S+)/.exec(sdp)?.[1];
    const pwd = /a=ice-pwd:(\S+)/.exec(sdp)?.[1];
    if (!ufrag || !pwd) throw new Error('offer has no ICE credentials');
    await pc.setRemoteDescription({ type: 'answer', sdp: directAnswerSdp(target, relayIceCredentialFor(ufrag, pwd)) });
    await opened;
    return { pc, channel };
  } catch (error) {
    clearTimeout(timer);
    try { channel.close(); } catch {}
    try { pc.close(); } catch {}
    throw error;
  }
}
