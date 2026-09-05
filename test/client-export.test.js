import assert from "node:assert/strict";
import test from "node:test";

import { createSignalingClient, withdrawSignalingIdentity } from "freertc/client";

test("the browser signaling client is exported as a package API", () => {
  assert.equal(typeof createSignalingClient, "function");
  assert.equal(typeof withdrawSignalingIdentity, "function");

  const client = createSignalingClient({
    peerId: "local-peer",
    networkId: "test-network",
    roomId: "test-room",
    signalUrl: "wss://signal.example/ws",
    autoConnect: false,
  });

  assert.equal(client.peerId, "local-peer");
  assert.equal(typeof client.connect, "function");
  assert.equal(typeof client.reconnectSignaling, "function");
  assert.equal(typeof client.closePeerConnection, "function");
  assert.equal(typeof client.initiateConnection, "function");
  assert.equal(typeof client.sendData, "function");
  client.disconnect();
});

test("signaling-only reconnect preserves healthy WebRTC peer channels", () => {
  const originalWebSocket = globalThis.WebSocket;
  const sockets = [];

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;

    constructor() {
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      sockets.push(this);
    }

    send(value) {
      this.sent.push(JSON.parse(value));
    }

    open() {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    }

    close(code = 1000) {
      this.readyState = FakeWebSocket.CLOSED;
      this.closeCode = code;
      this.onclose?.({ code });
    }
  }

  globalThis.WebSocket = FakeWebSocket;
  let client;
  try {
    client = createSignalingClient({
      peerId: "local-peer",
      networkId: "test-network",
      roomId: "test-room",
      signalUrl: "wss://signal.example/ws",
      autoConnect: false,
    });
    client.connect();
    sockets[0].open();

    let peerConnectionClosed = false;
    const peerEntry = {
      state: "connected",
      connection: { close() { peerConnectionClosed = true; } },
      channel: { readyState: "open" },
    };
    client.mesh.connections.set("remote-peer", peerEntry);

    assert.equal(client.reconnectSignaling("health check"), true);
    assert.equal(sockets.length, 2);
    assert.equal(sockets[0].closeCode, 4002);
    assert.equal(peerConnectionClosed, false);
    assert.equal(client.mesh.connections.get("remote-peer"), peerEntry);
  } finally {
    client?.disconnect();
    globalThis.WebSocket = originalWebSocket;
  }
});

test("peer close sends a coordinated bye and cancels the local transport", () => {
  const originalWebSocket = globalThis.WebSocket;
  const sockets = [];

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    constructor() {
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      sockets.push(this);
    }
    send(value) { this.sent.push(JSON.parse(value)); }
    open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
    receive(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
    close(code = 1000) { this.readyState = FakeWebSocket.CLOSED; this.onclose?.({ code }); }
  }

  globalThis.WebSocket = FakeWebSocket;
  let client;
  try {
    client = createSignalingClient({
      peerId: "local-peer",
      networkId: "test-network",
      roomId: "test-room",
      signalUrl: "wss://signal.example/ws",
      autoConnect: false,
    });
    client.connect();
    sockets[0].open();
    sockets[0].receive({ type: "ack", body: { status: "ok" } });

    let channelClosed = false;
    let peerConnectionClosed = false;
    client.mesh.connections.set("remote-peer", {
      connection: { close() { peerConnectionClosed = true; } },
      channel: { close() { channelClosed = true; } },
    });

    assert.equal(client.closePeerConnection("remote-peer", "capacity_shed"), true);
    const bye = sockets[0].sent.find((message) => message.type === "bye");
    assert.equal(bye.to, "remote-peer");
    assert.equal(bye.body.reason, "capacity_shed");
    assert.equal(client.mesh.connections.has("remote-peer"), false);
    assert.equal(channelClosed, true);
    assert.equal(peerConnectionClosed, true);
  } finally {
    client?.disconnect();
    globalThis.WebSocket = originalWebSocket;
  }
});

test("page shutdown events withdraw the current signaling identity", () => {
  const originalWindow = globalThis.window;
  const originalWebSocket = globalThis.WebSocket;
  const fakeWindow = new EventTarget();
  const sockets = [];

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
      this.url = String(url);
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      sockets.push(this);
    }

    send(value) {
      this.sent.push(JSON.parse(value));
    }

    open() {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    }

    close(code = 1000) {
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.({ code });
    }
  }

  globalThis.window = fakeWindow;
  globalThis.WebSocket = FakeWebSocket;
  try {
    for (const eventName of ["pagehide", "beforeunload", "unload"]) {
      const peerId = `${eventName}-peer`;
      const client = createSignalingClient({
        peerId,
        networkId: "test-network",
        roomId: "test-room",
        signalUrl: "wss://signal.example/ws",
        autoConnect: false,
      });
      client.connect();
      const socket = sockets.at(-1);
      socket.open();

      fakeWindow.dispatchEvent(new Event(eventName));

      assert.equal(socket.sent.at(-1).type, "withdraw");
      assert.equal(socket.sent.at(-1).from, peerId);
      assert.equal(socket.readyState, FakeWebSocket.CLOSED);
      client.disconnect();
    }
  } finally {
    globalThis.window = originalWindow;
    globalThis.WebSocket = originalWebSocket;
  }
});

test("browser suspension does not withdraw a live signaling identity", () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalWebSocket = globalThis.WebSocket;
  const fakeDocument = new EventTarget();
  const fakeWindow = new EventTarget();
  const sockets = [];

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor() {
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      sockets.push(this);
    }

    send(value) {
      this.sent.push(JSON.parse(value));
    }

    open() {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    }

    close(code = 1000) {
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.({ code });
    }
  }

  globalThis.document = fakeDocument;
  globalThis.window = fakeWindow;
  globalThis.WebSocket = FakeWebSocket;
  let client;
  try {
    client = createSignalingClient({
      peerId: "suspended-peer",
      networkId: "test-network",
      roomId: "test-room",
      signalUrl: "wss://signal.example/ws",
      autoConnect: false,
    });
    client.connect();
    const socket = sockets[0];
    socket.open();

    fakeDocument.dispatchEvent(new Event("freeze"));
    const persistedPageHide = new Event("pagehide");
    Object.defineProperty(persistedPageHide, "persisted", { value: true });
    fakeWindow.dispatchEvent(persistedPageHide);

    assert.deepEqual(socket.sent.map((message) => message.type), ["announce"]);
    assert.equal(socket.readyState, FakeWebSocket.OPEN);
  } finally {
    client?.disconnect();
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.WebSocket = originalWebSocket;
  }
});

test("a scoped peer list completes registration for older relays", () => {
  const originalWebSocket = globalThis.WebSocket;
  const sockets = [];

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;

    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      sockets.push(this);
    }

    send(value) {
      this.sent.push(JSON.parse(value));
    }

    close(code = 1000) {
      this.readyState = 3;
      this.onclose?.({ code });
    }

    open() {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    }

    receive(message) {
      this.onmessage?.({ data: JSON.stringify(message) });
    }
  }

  globalThis.WebSocket = FakeWebSocket;
  try {
    let registrations = 0;
    let bootstrapCandidates = [];
    const client = createSignalingClient({
      peerId: "local-peer",
      networkId: "test-network",
      roomId: "test-room",
      signalUrl: "wss://signal.example/ws",
      autoConnect: false,
      onRegistered: () => { registrations += 1; },
      onBootstrap: (candidates) => { bootstrapCandidates = candidates; },
    });

    client.connect();
    const socket = sockets[0];
    socket.open();
    assert.equal(socket.sent[0].type, "announce");
    assert.equal(client.isRegistered, false);

    socket.receive({
      psp_version: "1.0",
      type: "peer_list",
      network: "test-network",
      session_id: "test-room",
      from: "relay",
      to: "local-peer",
      message_id: "peer-list-1",
      timestamp: Date.now(),
      body: {
        peers: [{
          peer_id: 'remote-peer',
          network: 'test-network',
          timestamp: 123456789,
        }],
      },
    });

    assert.equal(client.isRegistered, true);
    assert.equal(registrations, 1);
    assert.equal(bootstrapCandidates[0].advertisedAt, 123456789);
    client.disconnect();
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test("browser resume cancels backoff and replaces a stale signaling socket immediately", () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalWebSocket = globalThis.WebSocket;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const sockets = [];
  const retryDelays = [];
  const clearedTimers = [];
  let nextTimerId = 1;

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;

    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      sockets.push(this);
    }

    send() {}

    close(code = 1000) {
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.({ code });
    }

    fail(code = 1006) {
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.({ code });
    }
  }

  const fakeDocument = new EventTarget();
  fakeDocument.hidden = false;
  const fakeWindow = new EventTarget();
  globalThis.document = fakeDocument;
  globalThis.window = fakeWindow;
  globalThis.WebSocket = FakeWebSocket;
  globalThis.setTimeout = (_callback, delay) => {
    retryDelays.push(delay);
    return nextTimerId++;
  };
  globalThis.clearTimeout = (timerId) => {
    if (timerId != null) clearedTimers.push(timerId);
  };

  let client;
  try {
    client = createSignalingClient({
      peerId: "local-peer",
      networkId: "test-network",
      roomId: "test-room",
      signalUrl: "wss://signal.example/ws",
      autoConnect: false,
    });

    client.connect();
    sockets[0].fail();
    assert.deepEqual(retryDelays, [0]);

    // Simulate the stale state browsers can expose after thawing: the old
    // transport appears live even though its reconnect timer is still pending.
    sockets[0].readyState = FakeWebSocket.OPEN;
    fakeDocument.dispatchEvent(new Event("resume"));

    assert.equal(sockets.length, 2);
    assert.equal(sockets[0].readyState, FakeWebSocket.CLOSED);
    assert.deepEqual(clearedTimers, [1]);

    // A subsequent failure also retries immediately, proving resume reset the
    // attempt counter instead of carrying stale backoff into the live session.
    sockets[1].fail();
    assert.deepEqual(retryDelays, [0, 0]);
  } finally {
    client?.disconnect();
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.WebSocket = originalWebSocket;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("a silent signaling socket is detected without continually resetting its ping deadline", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const originalWebSocket = globalThis.WebSocket;
  const originalDateNow = Date.now;
  const sockets = [];
  let now = 0;

  class SilentWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;

    constructor() {
      this.readyState = SilentWebSocket.CONNECTING;
      this.sent = [];
      this.closeCode = null;
      sockets.push(this);
    }

    send(value) {
      this.sent.push(JSON.parse(value));
    }

    open() {
      this.readyState = SilentWebSocket.OPEN;
      this.onopen?.();
    }

    receive(message) {
      this.onmessage?.({ data: JSON.stringify(message) });
    }

    close(code = 1000) {
      this.closeCode = code;
      this.readyState = SilentWebSocket.CLOSED;
      this.onclose?.({ code });
    }
  }

  globalThis.WebSocket = SilentWebSocket;
  Date.now = () => now;
  let client;
  try {
    client = createSignalingClient({
      peerId: "local-peer",
      networkId: "test-network",
      roomId: "test-room",
      signalUrl: "wss://signal.example/ws",
      autoConnect: false,
    });
    client.connect();
    sockets[0].open();
    sockets[0].receive({ type: "ack", body: { status: "ok" } });

    now = 1_000;
    t.mock.timers.tick(1_000);
    assert.equal(sockets[0].sent.filter((message) => message.type === "ping").length, 1);
    // A second at a time: one large jump reads as a machine sleep to the
    // suspend watch, which is its own verdict.
    for (let second = 2; second <= 20; second += 1) {
      now = second * 1_000;
      t.mock.timers.tick(1_000);
    }
    assert.equal(sockets[0].closeCode, null);
    now = 21_000;
    t.mock.timers.tick(1_000);
    assert.equal(sockets[0].closeCode, 4000);
  } finally {
    client?.disconnect();
    globalThis.WebSocket = originalWebSocket;
    Date.now = originalDateNow;
  }
});
