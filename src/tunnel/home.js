// A tunnel home: a public relay that gives a relay behind NAT a public address.
//
// The relay behind NAT opens one WebSocket outward to /t/<its node id>/connect
// here and proves it holds that node's key. From then on its federation
// address is wss://<this host>/t/<node id>/ws, and anything sent there (HTTP
// federation calls, and WebSockets from peers) is carried down the tunnel and
// answered by the relay itself.
//
// One instance (one Durable Object on Cloudflare) per node id. Sockets are
// accepted through the hibernation API, so an idle tunnel costs no duration:
// keepalive pings are answered by the runtime without waking the object, and
// only a request or a message wakes it.
import { RELAY_NODE_RECORD_KIND, tunnelNodeIdOf, verifySignedRelayRecord, verifyTunnelChallenge } from '../relay-identity.js';
import {
  MAX_TUNNEL_BODY_BYTES, TUNNEL_PING, TUNNEL_PONG, decodeBody, encodeBody, forwardHeaders, tunnelRoute,
} from './frames.js';

const REQUEST_TIMEOUT_MS = 15_000;
const NODE_RECORD_KINDS = new Set([RELAY_NODE_RECORD_KIND]);

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

function closeQuietly(socket, code = 1000, reason = '') {
  try {
    socket.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000, reason);
  } catch {}
}

function attachmentOf(socket) {
  try {
    return socket.deserializeAttachment() ?? null;
  } catch {
    return null;
  }
}

export class RelayTunnel {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.pending = new Map();
    try {
      state.setWebSocketAutoResponse?.(new WebSocketRequestResponsePair(TUNNEL_PING, TUNNEL_PONG));
    } catch {}
  }

  /** The authenticated tunnel socket, if the relay is connected. */
  tunnelSocket() {
    return this.state.getWebSockets('tunnel').find((socket) => attachmentOf(socket)?.authed) ?? null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const route = tunnelRoute(url.pathname);
    if (!route) return json({ ok: false, error: 'Not a tunnel path' }, 404);
    const upgrade = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';

    if (route.rest === '/connect') {
      if (!upgrade) return json({ ok: false, error: 'Expected WebSocket upgrade' }, 426);
      const [client, server] = Object.values(new WebSocketPair());
      const nonce = crypto.randomUUID();
      this.state.acceptWebSocket(server, ['tunnel']);
      server.serializeAttachment({ role: 'tunnel', nodeId: route.nodeId, host: url.host, nonce, authed: false, gen: null });
      server.send(JSON.stringify({ t: 'challenge', nonce, host: url.host }));
      return new Response(null, { status: 101, webSocket: client });
    }

    const tunnel = this.tunnelSocket();
    if (!tunnel) return json({ ok: false, error: 'That relay is not connected through this tunnel' }, 502);
    const { gen } = attachmentOf(tunnel);
    const path = `${route.rest}${url.search}`;

    if (upgrade) {
      const [client, server] = Object.values(new WebSocketPair());
      const sid = crypto.randomUUID();
      this.state.acceptWebSocket(server, ['peer', `sid:${sid}`]);
      server.serializeAttachment({ role: 'peer', sid, gen });
      tunnel.send(JSON.stringify({ t: 'open', sid, path, headers: forwardHeaders(request.headers) }));
      return new Response(null, { status: 101, webSocket: client });
    }

    let body = null;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength > MAX_TUNNEL_BODY_BYTES) return json({ ok: false, error: 'Request too large' }, 413);
      body = encodeBody(bytes);
    }
    const id = crypto.randomUUID();
    const reply = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, (frame) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(frame);
      });
    });
    tunnel.send(JSON.stringify({ t: 'req', id, method: request.method, path, headers: forwardHeaders(request.headers), body }));
    const frame = await reply;
    if (!frame) return json({ ok: false, error: 'The tunneled relay did not answer' }, 504);
    const status = Number(frame.status) || 502;
    const nullBody = request.method === 'HEAD' || status === 204 || status === 304 || !frame.body;
    return new Response(nullBody ? null : decodeBody(frame.body), { status, headers: frame.headers || [] });
  }

  async webSocketMessage(socket, message) {
    const meta = attachmentOf(socket);
    if (!meta) return;
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);

    if (meta.role === 'peer') {
      const tunnel = this.tunnelSocket();
      if (!tunnel || attachmentOf(tunnel).gen !== meta.gen) {
        closeQuietly(socket, 1011, 'Relay tunnel closed');
        return;
      }
      tunnel.send(JSON.stringify({ t: 'data', sid: meta.sid, data: text }));
      return;
    }

    if (text === TUNNEL_PING) {
      // Where the runtime has no auto-response.
      socket.send(TUNNEL_PONG);
      return;
    }
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }

    if (!meta.authed) {
      if (frame?.t !== 'hello' || !meta.nonce) {
        closeQuietly(socket, 1008, 'hello expected');
        return;
      }
      const record = frame.record;
      let recordHost = null;
      try {
        recordHost = new URL(record?.url).host;
      } catch {}
      const ok = record?.node_id === meta.nodeId
        && tunnelNodeIdOf(record.url) === meta.nodeId
        && recordHost === meta.host
        && await verifySignedRelayRecord(record, { allowedKinds: NODE_RECORD_KINDS })
        && await verifyTunnelChallenge(record.public_key, meta.nonce, meta.host, frame.signature);
      if (!ok) {
        closeQuietly(socket, 1008, 'Tunnel authentication failed');
        return;
      }
      // The newest tunnel for a node wins: a relay that reconnects replaces its old one.
      for (const other of this.state.getWebSockets('tunnel')) {
        if (other !== socket) closeQuietly(other, 1012, 'Replaced by a newer tunnel');
      }
      socket.serializeAttachment({ ...meta, nonce: null, authed: true, gen: crypto.randomUUID() });
      socket.send(JSON.stringify({ t: 'ready', url: record.url }));
      return;
    }

    if (frame?.t === 'res') {
      this.pending.get(frame.id)?.(frame);
      return;
    }
    if (frame?.t === 'data') {
      for (const peer of this.state.getWebSockets(`sid:${frame.sid}`)) {
        try {
          peer.send(String(frame.data));
        } catch {}
      }
      return;
    }
    if (frame?.t === 'end') {
      for (const peer of this.state.getWebSockets(`sid:${frame.sid}`)) closeQuietly(peer, frame.code, frame.reason || '');
    }
  }

  async webSocketClose(socket, code, reason) {
    const meta = attachmentOf(socket);
    closeQuietly(socket, code, reason);
    if (!meta) return;
    if (meta.role === 'peer') {
      const tunnel = this.tunnelSocket();
      if (tunnel && attachmentOf(tunnel).gen === meta.gen) {
        try {
          tunnel.send(JSON.stringify({ t: 'end', sid: meta.sid, code, reason }));
        } catch {}
      }
      return;
    }
    if (meta.authed) {
      // Peers that came in through this tunnel have nothing on the other end now.
      for (const peer of this.state.getWebSockets('peer')) {
        if (attachmentOf(peer)?.gen === meta.gen) closeQuietly(peer, 1011, 'Relay tunnel closed');
      }
    }
  }

  async webSocketError(socket) {
    await this.webSocketClose(socket, 1011, 'error');
  }
}
