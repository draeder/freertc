import assert from "node:assert/strict";
import test from "node:test";

import { createSignalingClient } from "freertc/client";

test("the browser signaling client is exported as a package API", () => {
  assert.equal(typeof createSignalingClient, "function");

  const client = createSignalingClient({
    peerId: "local-peer",
    networkId: "test-network",
    roomId: "test-room",
    signalUrl: "wss://signal.example/ws",
    autoConnect: false,
  });

  assert.equal(client.peerId, "local-peer");
  assert.equal(typeof client.connect, "function");
  assert.equal(typeof client.initiateConnection, "function");
  assert.equal(typeof client.sendData, "function");
  client.disconnect();
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
    const client = createSignalingClient({
      peerId: "local-peer",
      networkId: "test-network",
      roomId: "test-room",
      signalUrl: "wss://signal.example/ws",
      autoConnect: false,
      onRegistered: () => { registrations += 1; },
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
      body: { peers: [] },
    });

    assert.equal(client.isRegistered, true);
    assert.equal(registrations, 1);
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
    assert.deepEqual(retryDelays, [1000]);

    // Simulate the stale state browsers can expose after thawing: the old
    // transport appears live even though its reconnect timer is still pending.
    sockets[0].readyState = FakeWebSocket.OPEN;
    fakeDocument.dispatchEvent(new Event("resume"));

    assert.equal(sockets.length, 2);
    assert.equal(sockets[0].readyState, FakeWebSocket.CLOSED);
    assert.deepEqual(clearedTimers, [1]);

    // A subsequent failure starts again from the base delay, proving the
    // accumulated exponential backoff was cleared by resume.
    sockets[1].fail();
    assert.deepEqual(retryDelays, [1000, 1000]);
  } finally {
    client?.disconnect();
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.WebSocket = originalWebSocket;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
