// Cloudflare's WebSocketPair for a relay running under Node. The worker
// creates a pair, keeps the "server" end (addEventListener, accept, send,
// close) and returns the "client" end in a 101 Response. Here the server end
// is a deferred wrapper: listeners and accept() are recorded while the worker
// runs, and attach() binds them to a real socket once the HTTP upgrade (or a
// hole-punched channel) delivers one. Anything that looks like a `ws` socket
// works: send(), close(), on('message' | 'close' | 'error').

export class NodeServerSocket {
  constructor() {
    this.listeners = { message: [], close: [], error: [] };
    this.socket = null;
    this.accepted = false;
    this.closed = false;
  }

  addEventListener(type, listener) {
    this.listeners[type]?.push(listener);
  }

  accept() {
    this.accepted = true;
  }

  attach(socket) {
    this.socket = socket;
    const emit = (type, event) => {
      for (const listener of this.listeners[type]) {
        try {
          const result = listener(event);
          if (result && typeof result.catch === 'function') result.catch(() => {});
        } catch {}
      }
    };
    socket.on('message', (data) => emit('message', { data: typeof data === 'string' ? data : data.toString() }));
    socket.on('close', (code, reason) => {
      if (this.closed) return;
      this.closed = true;
      emit('close', { code, reason: reason?.toString?.() ?? '' });
    });
    socket.on('error', (error) => emit('error', { error }));
  }

  send(data) {
    if (!this.socket || this.closed) throw new Error('WebSocket is not open');
    this.socket.send(typeof data === 'string' ? data : String(data));
  }

  close(code, reason) {
    try { this.socket?.close(code, reason); } catch {}
  }
}

export class NodeWebSocketPair {
  constructor() {
    const server = new NodeServerSocket();
    const client = { server };
    this[0] = client;
    this[1] = server;
  }
}

/**
 * Install the pair on globalThis so the worker's `new WebSocketPair()` resolves
 * to it, and let `new Response(null, { status: 101, webSocket })` through:
 * Node's Response only accepts 200–599 and drops the webSocket field.
 */
export function installWebSocketPair() {
  if (typeof globalThis.WebSocketPair !== 'function') globalThis.WebSocketPair = NodeWebSocketPair;
  if (globalThis.Response.__freertcUpgradeAware) return;
  const BaseResponse = globalThis.Response;
  class UpgradeAwareResponse extends BaseResponse {
    constructor(body, init = {}) {
      const upgrade = init?.status === 101;
      super(upgrade ? null : body, upgrade ? { ...init, status: 200 } : init);
      if (upgrade) {
        Object.defineProperty(this, 'status', { value: 101 });
        Object.defineProperty(this, 'webSocket', { value: init.webSocket ?? null });
      }
    }
  }
  UpgradeAwareResponse.__freertcUpgradeAware = true;
  globalThis.Response = UpgradeAwareResponse;
}

/** The server socket a worker Response carries for a 101 upgrade, if any. */
export function serverSocketOf(response) {
  return response?.status === 101 ? response.webSocket?.server ?? null : null;
}
