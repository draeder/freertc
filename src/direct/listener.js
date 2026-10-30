// Accept direct browser connections (see common.js) on one UDP port and hand
// each opened data channel to the relay as a socket with the WebSocket surface
// node-relay's acceptSocket expects (send, close, readyState, on message/close/error).
//
// Needs node-datachannel 0.33 or later (an optional dependency): its ICE UDP
// mux reports the first check of an unknown connection together with the ICE
// username it was sent to, which is where the browser put its credentials.

import { DIRECT_CHANNEL_LABEL, directBrowserOfferSdp, parseRelayIceCredential } from './common.js';

const OPEN_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_PENDING = 64;
const DEFAULT_MAX_OPEN = 2_000;

export async function loadNodeDataChannel() {
  try {
    const mod = await import('node-datachannel');
    const ndc = mod.default ?? mod;
    if (typeof ndc.IceUdpMuxListener !== 'function') return null;
    return ndc;
  } catch {
    return null;
  }
}

/** True when this machine can accept direct connections. */
export async function directListenerAvailable() {
  return Boolean(await loadNodeDataChannel());
}

class DirectChannelSocket {
  constructor(channel, pc) {
    this.channel = channel;
    this.peerConnection = pc;
    this.OPEN = 1;
    this.CLOSED = 3;
    this.closed = false;
    this.listeners = { message: [], close: [], error: [] };
    this.meta = { direct: true };
    const emit = (event, value) => { for (const listener of this.listeners[event]) listener(value); };
    channel.onMessage((message) => emit('message', typeof message === 'string' ? message : Buffer.from(message)));
    channel.onClosed(() => this.finish(emit));
    channel.onError((error) => emit('error', new Error(String(error))));
    this.emit = emit;
  }

  finish(emit = this.emit) {
    if (this.closed) return;
    this.closed = true;
    try { this.peerConnection.close(); } catch {}
    emit('close');
  }

  get readyState() {
    return !this.closed && this.channel.isOpen() ? this.OPEN : this.CLOSED;
  }

  send(data) {
    if (this.readyState !== this.OPEN) throw new Error('Direct channel is not open');
    this.channel.sendMessage(typeof data === 'string' ? data : String(data));
  }

  on(event, listener) {
    this.listeners[event]?.push(listener);
    return this;
  }

  close() {
    try { this.channel.close(); } catch {}
    this.finish();
  }
}

/**
 * Listen for direct connections on UDP `port`. Returns { close, stats } or null
 * when node-datachannel (0.33+) is not installed.
 *
 *   onSocket(socket, { host, port })  a direct data channel opened
 */
export async function startDirectListener({
  port,
  bindAddress = '0.0.0.0',
  certFile,
  keyFile,
  onSocket,
  log = () => {},
  maxPending = DEFAULT_MAX_PENDING,
  maxOpen = DEFAULT_MAX_OPEN,
}) {
  const ndc = await loadNodeDataChannel();
  if (!ndc) return null;

  let listener;
  try {
    listener = new ndc.IceUdpMuxListener(port, bindAddress);
  } catch (error) {
    // Most often the port is taken (another relay on this machine). The relay
    // keeps running; only direct connections are off.
    log(`direct connections: off (cannot listen on udp ${bindAddress}:${port}: ${error?.message || error}; set FREERTC_DIRECT_PORT to a free port)`);
    return null;
  }
  // The native listener is released (and stops listening) when nothing on the
  // JavaScript side references it; keep it reachable for as long as we listen.
  const keepAlive = { listener };
  globalThis.__freertcDirectListeners ??= new Set();
  globalThis.__freertcDirectListeners.add(keepAlive);

  const pending = new Map(); // relay ICE username -> PeerConnection
  let open = 0;
  let accepted = 0;
  let refused = 0;
  let sequence = 0;

  listener.onUnhandledStunRequest((request) => {
    const credential = request.localUfrag;
    if (!credential || pending.has(credential)) return;
    const browser = parseRelayIceCredential(credential);
    if (!browser || browser.ufrag !== request.ufrag) return;
    if (pending.size >= maxPending || open >= maxOpen) {
      refused += 1;
      return;
    }

    let pc;
    try {
      pc = new ndc.PeerConnection(`direct-${(sequence += 1)}`, {
        iceServers: [],
        enableIceUdpMux: true,
        bindAddress,
        portRangeBegin: port,
        portRangeEnd: port,
        certificatePemFile: certFile,
        keyPemFile: keyFile,
        disableFingerprintVerification: true,
        disableAutoNegotiation: true,
      });
    } catch (error) {
      log(`direct connection from ${request.host}:${request.port} failed to start: ${error?.message || error}`);
      return;
    }
    pending.set(credential, pc);
    const forget = () => { if (pending.get(credential) === pc) pending.delete(credential); };
    const timer = setTimeout(() => {
      if (!pending.has(credential)) return;
      forget();
      try { pc.close(); } catch {}
    }, OPEN_TIMEOUT_MS);

    pc.onStateChange((state) => {
      if (state === 'failed' || state === 'closed') {
        clearTimeout(timer);
        forget();
      }
    });
    pc.onDataChannel((channel) => {
      clearTimeout(timer);
      forget();
      if (channel.getLabel() !== DIRECT_CHANNEL_LABEL) {
        try { channel.close(); } catch {}
        try { pc.close(); } catch {}
        return;
      }
      const socket = new DirectChannelSocket(channel, pc);
      open += 1;
      accepted += 1;
      socket.on('close', () => { open -= 1; });
      try {
        onSocket(socket, { host: request.host, port: request.port });
      } catch (error) {
        log(`direct socket handler failed: ${error?.message || error}`);
        socket.close();
      }
    });

    try {
      pc.setRemoteDescription(directBrowserOfferSdp(browser), 'offer');
      pc.setLocalDescription('answer', { iceUfrag: credential, icePwd: credential });
      pc.addRemoteCandidate(`candidate:1 1 UDP 2130706431 ${request.host} ${request.port} typ host`, '0');
    } catch (error) {
      clearTimeout(timer);
      forget();
      try { pc.close(); } catch {}
      log(`direct connection from ${request.host}:${request.port} refused: ${error?.message || error}`);
    }
  });

  log(`accepting direct connections on udp ${bindAddress}:${port}`);
  return {
    stats: () => ({ pending: pending.size, open, accepted, refused }),
    close() {
      for (const pc of pending.values()) { try { pc.close(); } catch {} }
      pending.clear();
      try { listener.stop?.(); } catch {}
      globalThis.__freertcDirectListeners?.delete(keepAlive);
    },
  };
}
