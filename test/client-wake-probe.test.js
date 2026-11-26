import assert from "node:assert/strict";
import test from "node:test";
import { createSignalingClient } from "../src/client.js";

// A laptop that slept leaves its relay socket reading OPEN while the relay dropped it long ago. A wake
// asks the relay; a socket that stays silent is replaced within seconds, not at the keepalive's minute.
function harness() {
  const sockets = [];
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    constructor() { this.readyState = FakeWebSocket.CONNECTING; this.sent = []; sockets.push(this); }
    send(value) { this.sent.push(JSON.parse(value)); }
    open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
    receive(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
    close(code = 1000) { this.readyState = FakeWebSocket.CLOSED; this.closeCode = code; this.onclose?.({ code }); }
  }
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  const client = createSignalingClient({
    peerId: "local-peer", networkId: "test-network", roomId: "test-room",
    signalUrl: "wss://signal.example/ws", autoConnect: false,
  });
  client.connect();
  sockets[0].open();
  sockets[0].receive({ type: "ack", body: { status: "ok" } });
  return { client, sockets, restore() { client.disconnect(); globalThis.WebSocket = original; } };
}

test("a silent relay socket is replaced within seconds of waking", async () => {
  const h = harness();
  try {
    assert.equal(h.client.isRegistered, true);
    let link = 0;
    h.client.mesh.connections.set("remote-peer", { state: "connected", connection: { close() { link += 1; } }, channel: { readyState: "open" } });
    assert.equal(h.client.probeSignaling("test"), true);
    const pings = h.sockets[0].sent.filter((m) => m.type === "ping");
    assert.equal(pings.length, 1, "the wake asks the relay once");
    assert.equal(h.client.probeSignaling("test"), true);
    assert.equal(h.sockets[0].sent.filter((m) => m.type === "ping").length, 1, "a second wake signal in the window sends no second ping");
    await new Promise((resolve) => setTimeout(resolve, 4_300));
    assert.equal(h.sockets.length, 2, "a new socket is opened");
    assert.equal(h.sockets[0].closeCode, 4000);
    assert.equal(h.client.isRegistered, false);
    assert.equal(link, 0, "peer links are left alone");
    assert.equal(h.client.mesh.connections.size, 1);
  } finally { h.restore(); }
});

test("a relay that answers keeps its socket", async () => {
  const h = harness();
  try {
    h.client.probeSignaling("test");
    h.sockets[0].receive({ type: "pong", body: {} });
    await new Promise((resolve) => setTimeout(resolve, 4_300));
    assert.equal(h.sockets.length, 1);
    assert.equal(h.client.isRegistered, true);
  } finally { h.restore(); }
});
