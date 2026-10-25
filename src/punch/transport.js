// A hole-punched transport for a freertc server behind NAT.
//
// The local server cannot be dialed over TCP from the public internet, but it
// can open UDP flows outward, and so can whoever wants to reach it. Each side
// learns its public address from STUN and both send at once, so each one's
// own packets open the hole the other's arrive through. ICE does exactly that,
// with candidate pairing and keepalives, so the punch is a WebRTC data channel
// negotiated through the rendezvous (rendezvous.js) and then used for the
// relay protocol itself: the same JSON envelopes a WebSocket carries.

const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
const POLL_WAIT_MS = 20_000;
const REGISTER_EVERY_MS = 60_000;
const DIAL_TIMEOUT_MS = 20_000;
const CHANNEL_LABEL = 'freertc-relay';

async function loadRTCPeerConnection(provided) {
  if (provided) return provided;
  if (typeof globalThis.RTCPeerConnection === 'function') return globalThis.RTCPeerConnection;
  const { RTCPeerConnection } = await import('werift');
  return RTCPeerConnection;
}

function randomId(prefix) {
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}

async function post(base, path, body, fetchImpl) {
  const response = await fetchImpl(new URL(path, base), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return response.json();
}

async function poll(base, id, waitMs, fetchImpl, signal) {
  const url = new URL('/api/v1/punch/poll', base);
  url.searchParams.set('id', id);
  url.searchParams.set('waitMs', String(waitMs));
  const response = await fetchImpl(url, { signal });
  if (!response.ok) throw new Error(`poll answered ${response.status}`);
  const body = await response.json();
  return Array.isArray(body?.messages) ? body.messages : [];
}

/**
 * Make a data channel look like the `ws` socket the relay already handles:
 * send(), readyState/OPEN, and on('message' | 'close' | 'error').
 */
export class DataChannelSocket {
  constructor(channel, peerConnection, meta = {}) {
    this.channel = channel;
    this.peerConnection = peerConnection;
    this.meta = meta;
    this.OPEN = 1;
    this.CLOSED = 3;
    this.listeners = { message: [], close: [], error: [] };
    this.closed = false;
    const emit = (event, value) => { for (const listener of this.listeners[event]) listener(value); };
    channel.onmessage = (event) => emit('message', typeof event.data === 'string' ? event.data : Buffer.from(event.data));
    channel.onclose = () => this.finish(emit);
    channel.onerror = (error) => emit('error', error);
    peerConnection.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(peerConnection.connectionState)) this.finish(emit);
    };
  }

  finish(emit) {
    if (this.closed) return;
    this.closed = true;
    emit('close');
  }

  get readyState() {
    return !this.closed && this.channel.readyState === 'open' ? this.OPEN : this.CLOSED;
  }

  send(data) {
    if (this.readyState !== this.OPEN) throw new Error('Punched channel is not open');
    this.channel.send(typeof data === 'string' ? data : String(data));
  }

  on(event, listener) {
    this.listeners[event]?.push(listener);
    return this;
  }

  close() {
    try { this.channel.close(); } catch {}
    try { this.peerConnection.close(); } catch {}
  }
}

/** Wire one side's ICE candidates to the rendezvous and apply the other side's. */
function bridgeIce(pc, send) {
  pc.onicecandidate = (event) => {
    const candidate = event?.candidate;
    send(candidate ? { kind: 'candidate', candidate: candidate.toJSON?.() ?? candidate } : { kind: 'end' }).catch(() => {});
  };
}

// A candidate can reach the rendezvous before the description it belongs to:
// gathering starts the moment the other side sets its local description. One
// applied too early is refused, so it waits here until the description lands.
async function applySignal(pc, signal) {
  pc.__pendingCandidates ??= [];
  if (signal.kind === 'offer' || signal.kind === 'answer') {
    await pc.setRemoteDescription({ type: signal.kind, sdp: signal.sdp });
    pc.__remoteSet = true;
    for (const candidate of pc.__pendingCandidates.splice(0)) {
      await pc.addIceCandidate(candidate).catch(() => {});
    }
  } else if (signal.kind === 'candidate' && signal.candidate) {
    if (!pc.__remoteSet) pc.__pendingCandidates.push(signal.candidate);
    else await pc.addIceCandidate(signal.candidate).catch(() => {});
  }
}

/**
 * Run inside a local freertc server: register with the rendezvous and accept
 * punched connections, handing each one to `onSocket` as a socket the relay
 * treats exactly like a WebSocket client.
 */
export function listenForPunches({
  rendezvousUrl,
  listenerId,
  name = '',
  onSocket,
  iceServers = DEFAULT_ICE_SERVERS,
  RTCPeerConnection = null,
  fetchImpl = globalThis.fetch,
  log = () => {},
}) {
  let stopped = false;
  const controller = new AbortController();
  const sessions = new Map(); // session -> { pc, remote }

  const register = () => post(rendezvousUrl, '/api/v1/punch/register', { listenerId, info: { name } }, fetchImpl)
    .then(() => log(`registered as ${listenerId}`))
    .catch((error) => log(`register failed: ${error.message}`));
  register();
  const timer = setInterval(register, REGISTER_EVERY_MS);
  timer.unref?.();

  const accept = async (from, session, signal) => {
    const PeerConnection = await loadRTCPeerConnection(RTCPeerConnection);
    const pc = new PeerConnection({ iceServers });
    sessions.set(session, { pc, remote: from });
    const send = (out) => post(rendezvousUrl, '/api/v1/punch/send', { to: from, from: listenerId, session, signal: out }, fetchImpl);
    bridgeIce(pc, send);
    pc.ondatachannel = (event) => {
      const channel = event.channel;
      const ready = () => {
        log(`punched channel open with ${from}`);
        onSocket(new DataChannelSocket(channel, pc, { remote: from, session }));
      };
      if (channel.readyState === 'open') ready(); else channel.onopen = ready;
    };
    await applySignal(pc, signal);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await send({ kind: 'answer', sdp: pc.localDescription.sdp });
  };

  (async () => {
    while (!stopped) {
      let messages = [];
      try {
        messages = await poll(rendezvousUrl, listenerId, POLL_WAIT_MS, fetchImpl, controller.signal);
      } catch (error) {
        if (stopped) break;
        log(`poll failed: ${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        continue;
      }
      for (const { from, session, signal } of messages) {
        try {
          if (signal?.kind === 'offer' && !sessions.has(session)) await accept(from, session, signal);
          else if (sessions.has(session)) await applySignal(sessions.get(session).pc, signal);
        } catch (error) {
          log(`session ${session} failed: ${error.message}`);
        }
      }
    }
  })();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      controller.abort();
      for (const { pc } of sessions.values()) { try { pc.close(); } catch {} }
    },
  };
}

/**
 * Reach a local freertc server that is listening for punches. Resolves with a
 * socket that speaks the relay protocol, as a WebSocket to it would.
 */
export async function dialPunched({
  rendezvousUrl,
  listenerId,
  iceServers = DEFAULT_ICE_SERVERS,
  RTCPeerConnection = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = DIAL_TIMEOUT_MS,
  log = () => {},
}) {
  const PeerConnection = await loadRTCPeerConnection(RTCPeerConnection);
  const selfId = randomId('dialer');
  const session = randomId('punch');
  const pc = new PeerConnection({ iceServers });
  const channel = pc.createDataChannel(CHANNEL_LABEL);
  const send = (signal) => post(rendezvousUrl, '/api/v1/punch/send', { to: listenerId, from: selfId, session, signal }, fetchImpl);
  bridgeIce(pc, send);
  const controller = new AbortController();

  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No punched channel to ${listenerId} within ${timeoutMs}ms`)), timeoutMs);
    channel.onopen = () => { clearTimeout(timer); resolve(); };
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await send({ kind: 'offer', sdp: pc.localDescription.sdp });
  log(`offer sent to ${listenerId}`);

  (async () => {
    while (!controller.signal.aborted) {
      let messages = [];
      try {
        messages = await poll(rendezvousUrl, selfId, 5_000, fetchImpl, controller.signal);
      } catch {
        if (controller.signal.aborted) break;
        continue;
      }
      for (const { session: incoming, signal } of messages) {
        if (incoming === session) await applySignal(pc, signal).catch(() => {});
      }
    }
  })();

  try {
    await opened;
  } finally {
    // The introduction is over either way: stop asking the rendezvous.
    controller.abort();
  }
  log(`punched channel open to ${listenerId}`);
  return new DataChannelSocket(channel, pc, { remote: listenerId, session });
}
