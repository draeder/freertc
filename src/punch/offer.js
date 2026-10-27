// A punched connection in one HTTP round trip: POST /api/v1/punch/offer.
//
// A relay behind NAT keeps a tunnel open to its home, so the home can carry an
// introduction to it without a rendezvous store or any polling: a client posts
// its complete offer (every ICE candidate gathered first) to
//   https://<home>/t/<node id>/api/v1/punch/offer
// the tunnel delivers it here, and the answer, complete too, comes back in the
// response. Both sides' own packets then open the path between them, and the
// data channel that opens carries the relay protocol, the same JSON frames a
// WebSocket would. The home sees one request per introduction and nothing
// after it.
//
//   request   { sdp }                 an offer with its candidates in it
//   response  { ok: true, sdp }       the answer, with this side's candidates
//             { ok: false, error }    no WebRTC here, too many at once, a bad offer

import { DataChannelSocket } from './transport.js';

const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
const MAX_OFFER_BYTES = 64 * 1024;
const GATHER_TIMEOUT_MS = 4_000;
const OPEN_TIMEOUT_MS = 20_000;
const MAX_PENDING = 64;

export const PUNCH_OFFER_PATH = '/api/v1/punch/offer';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

/** Resolve once ICE gathering is complete, or after timeoutMs with what there is. */
export function iceGatheringComplete(pc, timeoutMs = GATHER_TIMEOUT_MS) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const done = () => { clearTimeout(timer); resolve(); };
    const previousCandidate = pc.onicecandidate;
    pc.onicecandidate = (event) => {
      previousCandidate?.(event);
      if (!event?.candidate) done();
    };
    const previousState = pc.onicegatheringstatechange;
    pc.onicegatheringstatechange = (event) => {
      previousState?.(event);
      if (pc.iceGatheringState === 'complete') done();
    };
  });
}

async function loadPeerConnection(provided) {
  if (provided) return provided;
  if (typeof globalThis.RTCPeerConnection === 'function') return globalThis.RTCPeerConnection;
  try {
    const { RTCPeerConnection } = await import('werift');
    return RTCPeerConnection;
  } catch {
    return null;
  }
}

/** Whether this process can accept punched connections (it has WebRTC). */
export async function punchOfferAvailable(RTCPeerConnection = null) {
  return Boolean(await loadPeerConnection(RTCPeerConnection));
}

/**
 * Handler for POST /api/v1/punch/offer. Each opened channel is handed to
 * onSocket as a socket the relay treats exactly like a WebSocket client.
 */
export function createPunchOfferHandler({
  onSocket,
  iceServers = DEFAULT_ICE_SERVERS,
  RTCPeerConnection = null,
  log = () => {},
  openTimeoutMs = OPEN_TIMEOUT_MS,
  gatherTimeoutMs = GATHER_TIMEOUT_MS,
} = {}) {
  let pending = 0;
  return async function handlePunchOffer(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }
    if (request.method !== 'POST') return json({ ok: false, error: 'POST an offer' }, 405);
    const PeerConnection = await loadPeerConnection(RTCPeerConnection);
    if (!PeerConnection) return json({ ok: false, error: 'This relay has no WebRTC (npm install werift)' }, 501);
    if (pending >= MAX_PENDING) return json({ ok: false, error: 'Too many introductions at once' }, 503);

    const text = await request.text();
    if (text.length > MAX_OFFER_BYTES) return json({ ok: false, error: 'Offer too large' }, 413);
    let sdp;
    try { sdp = JSON.parse(text)?.sdp; } catch {}
    if (typeof sdp !== 'string' || !sdp.startsWith('v=')) return json({ ok: false, error: 'Missing offer sdp' }, 400);

    pending += 1;
    const pc = new PeerConnection({ iceServers });
    let settled = false;
    const release = () => { if (!settled) { settled = true; pending -= 1; } };
    const giveUp = setTimeout(() => {
      if (settled) return;
      release();
      log('punched channel did not open in time');
      try { pc.close(); } catch {}
    }, openTimeoutMs);
    giveUp.unref?.();

    pc.ondatachannel = (event) => {
      const channel = event.channel;
      const ready = () => {
        clearTimeout(giveUp);
        release();
        log('punched channel open');
        onSocket(new DataChannelSocket(channel, pc, { punched: true }));
      };
      if (channel.readyState === 'open') ready(); else channel.onopen = ready;
    };

    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      const gathered = iceGatheringComplete(pc, gatherTimeoutMs);
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered;
      return json({ ok: true, sdp: pc.localDescription.sdp });
    } catch (error) {
      clearTimeout(giveUp);
      release();
      try { pc.close(); } catch {}
      return json({ ok: false, error: `Bad offer: ${error?.message ?? error}` }, 400);
    }
  };
}
