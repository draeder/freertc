// The relay end of a tunnel (see home.js): a relay behind NAT keeps one
// WebSocket open outward to a public relay and answers, through it, what is
// sent to its public tunnel address. If that home goes away it moves to the
// next one, and its address moves with it.
import { createSignedNodeRecord, signTunnelChallenge } from '../relay-identity.js';
import { TUNNEL_PING, TUNNEL_PONG, MAX_TUNNEL_BODY_BYTES, decodeBody, encodeBody, forwardHeaders, tunnelUrlFor } from './frames.js';

const PING_EVERY_MS = 25_000;
const DEAD_AFTER_MS = 70_000;
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_BACKOFF_MS = 30_000;

function connectUrl(homeUrl, nodeId) {
  return tunnelUrlFor(homeUrl, nodeId).replace(/\/ws$/, '/connect');
}

function httpOrigin(tunnelUrl) {
  return tunnelUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/t\/[0-9a-f]{64}\/ws$/, '');
}

/**
 * A WebSocket opened to the relay's public address, seen from the relay: the
 * same shape as a `ws` socket (send, close, on('message' | 'close' | 'error')).
 */
class TunnelStream {
  constructor(sid, sendFrame) {
    this.sid = sid;
    this.sendFrame = sendFrame;
    this.OPEN = 1;
    this.readyState = 1;
    this.handlers = { message: [], close: [], error: [] };
  }

  on(type, handler) {
    this.handlers[type]?.push(handler);
    return this;
  }

  emit(type, ...args) {
    for (const handler of this.handlers[type] || []) {
      try {
        handler(...args);
      } catch {}
    }
  }

  send(data) {
    if (this.readyState !== 1) throw new Error('WebSocket is not open');
    this.sendFrame({ t: 'data', sid: this.sid, data: String(data) });
  }

  close(code = 1000, reason = '') {
    if (this.readyState !== 1) return;
    this.sendFrame({ t: 'end', sid: this.sid, code, reason });
    this.ended(code, reason);
  }

  ended(code = 1000, reason = '') {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.emit('close', code, Buffer.from(String(reason)));
  }
}

/**
 * Keep a tunnel open through the first home that takes it.
 *
 *   homes          public relay URLs to try, in order
 *   identity       the relay identity (createRelayIdentity)
 *   handleRequest  (Request) => Response, for HTTP sent to the tunnel address
 *   handleStream   (socket, { path, headers }) => void, for WebSockets
 *   onUrl          (url | null) => void, when the public address changes or is lost
 */
export function startTunnel({ homes, identity, name, handleRequest, handleStream, onUrl = () => {}, log = () => {}, WebSocketImpl }) {
  if (!homes?.length) throw new Error('A tunnel needs at least one home relay');
  let stopped = false;
  let current = null;
  let currentUrl = null;
  let homeIndex = 0;
  let failures = 0;
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });

  const setUrl = (url) => {
    if (url === currentUrl) return;
    currentUrl = url;
    onUrl(url);
  };

  async function connect() {
    if (stopped) return;
    const WS = WebSocketImpl ?? (await import('ws')).default;
    const homeUrl = homes[homeIndex % homes.length];
    const tunnelUrl = tunnelUrlFor(homeUrl, identity.nodeId);
    const socket = new WS(connectUrl(homeUrl, identity.nodeId));
    current = socket;
    const streams = new Map();
    let isReady = false;
    let lastPong = Date.now();
    let pinger = null;
    const kill = () => (socket.terminate ? socket.terminate() : socket.close());
    const connectTimer = setTimeout(() => { if (!isReady) kill(); }, CONNECT_TIMEOUT_MS);
    const sendFrame = (frame) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(frame));
    };

    socket.on('message', async (raw) => {
      const text = String(raw);
      if (text === TUNNEL_PONG) {
        lastPong = Date.now();
        return;
      }
      let frame;
      try {
        frame = JSON.parse(text);
      } catch {
        return;
      }
      if (frame.t === 'challenge') {
        const record = await createSignedNodeRecord(identity, { url: tunnelUrl, name });
        const signature = await signTunnelChallenge(identity, frame.nonce, frame.host);
        sendFrame({ t: 'hello', record, signature });
        return;
      }
      if (frame.t === 'ready') {
        isReady = true;
        failures = 0;
        clearTimeout(connectTimer);
        lastPong = Date.now();
        pinger = setInterval(() => {
          if (Date.now() - lastPong > DEAD_AFTER_MS) {
            log(`tunnel to ${homeUrl} stopped answering`);
            kill();
            return;
          }
          if (socket.readyState === 1) socket.send(TUNNEL_PING);
        }, PING_EVERY_MS);
        log(`tunnel open: reachable at ${frame.url}`);
        setUrl(frame.url);
        readyResolve(frame.url);
        return;
      }
      if (frame.t === 'req') {
        let reply;
        try {
          const response = await handleRequest(new Request(new URL(frame.path, httpOrigin(tunnelUrl)), {
            method: frame.method,
            headers: frame.headers,
            body: frame.body && frame.method !== 'GET' && frame.method !== 'HEAD' ? decodeBody(frame.body) : undefined,
          }));
          const bytes = new Uint8Array(await response.arrayBuffer());
          reply = bytes.byteLength > MAX_TUNNEL_BODY_BYTES
            ? { status: 502, headers: [], body: null }
            : { status: response.status, headers: forwardHeaders(response.headers), body: bytes.byteLength ? encodeBody(bytes) : null };
        } catch (error) {
          log(`tunneled request ${frame.method} ${frame.path} failed: ${error?.message || error}`);
          reply = { status: 500, headers: [['content-type', 'application/json']], body: encodeBody(new TextEncoder().encode('{"ok":false,"error":"Relay error"}')) };
        }
        sendFrame({ t: 'res', id: frame.id, ...reply });
        return;
      }
      if (frame.t === 'open') {
        const stream = new TunnelStream(frame.sid, sendFrame);
        streams.set(frame.sid, stream);
        stream.on('close', () => streams.delete(frame.sid));
        try {
          await handleStream(stream, { path: frame.path, headers: frame.headers });
        } catch (error) {
          log(`tunneled WebSocket failed: ${error?.message || error}`);
          stream.close(1011, 'Relay error');
        }
        return;
      }
      if (frame.t === 'data') {
        streams.get(frame.sid)?.emit('message', String(frame.data));
        return;
      }
      if (frame.t === 'end') {
        streams.get(frame.sid)?.ended(frame.code, frame.reason);
      }
    });

    socket.on('error', (error) => log(`tunnel to ${homeUrl}: ${error?.message || error}`));
    socket.on('close', (code, reason) => {
      clearTimeout(connectTimer);
      clearInterval(pinger);
      for (const stream of streams.values()) stream.ended(1011, 'Relay tunnel closed');
      streams.clear();
      if (current === socket) current = null;
      if (stopped) return;
      if (isReady) {
        log(`tunnel to ${homeUrl} closed (${code} ${String(reason || '')}); reconnecting`);
        failures = 1;
      } else {
        failures += 1;
        // Two failed tries at one home: move to the next.
        if (failures >= 2) {
          homeIndex += 1;
          failures = 0;
          setUrl(null);
        }
      }
      const rounds = Math.floor(homeIndex / homes.length);
      const delay = isReady ? 1000 : Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(rounds, 5));
      setTimeout(connect, delay);
    });
  }

  connect();
  return {
    ready,
    get url() { return currentUrl; },
    close() {
      stopped = true;
      try { current?.close(1000, 'Relay shutting down'); } catch {}
    },
  };
}
