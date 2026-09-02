import assert from "node:assert/strict";
import test from "node:test";
import { createSignalingClient } from "../src/client.js";

// A Node peer has no pageshow or resume event. A one-second tick that fires
// many seconds late is the only sign it was suspended — and it must recover
// the way a browser does on thaw: fresh socket, dead links dropped, redial.
test("a clock jump is a suspend: the client resumes like a thawed browser", async () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalNow = Date.now;
  const sockets = [];
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    constructor() { this.readyState = FakeWebSocket.CONNECTING; this.sent = []; sockets.push(this); }
    send(value) { this.sent.push(JSON.parse(value)); }
    open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
    close(code = 1000) { this.readyState = FakeWebSocket.CLOSED; this.closeCode = code; this.onclose?.({ code }); }
  }
  globalThis.WebSocket = FakeWebSocket;
  const resumes = [];
  let client;
  try {
    client = createSignalingClient({
      peerId: "local-peer",
      networkId: "test-network",
      roomId: "test-room",
      signalUrl: "wss://signal.example/ws",
      autoConnect: false,
      onResume: (event) => resumes.push(event),
    });
    client.connect();
    sockets[0].open();
    let peerConnectionClosed = false;
    client.mesh.connections.set("remote-peer", {
      state: "connected",
      connection: { close() { peerConnectionClosed = true; } },
      channel: { readyState: "open" },
    });

    // Sixty seconds pass between two ticks: the machine slept.
    const realNow = originalNow();
    Date.now = () => realNow + 60_000;
    await new Promise((resolve) => setTimeout(resolve, 1_400));

    assert.equal(resumes.length, 1, "one resume for one suspend");
    assert.equal(resumes[0].reason, "clock_jump");
    assert.ok(resumes[0].gapMs >= 20_000);
    // The dead links are dropped and a fresh signaling socket is opened.
    assert.equal(peerConnectionClosed, true);
    assert.equal(client.mesh.connections.size, 0);
    assert.equal(sockets.length, 2);

    // A steady clock is not a suspend — and neither is a busy event loop
    // pausing for several seconds.
    Date.now = () => realNow + 60_000 + 1_000;
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(resumes.length, 1);
    Date.now = () => realNow + 60_000 + 1_000 + 9_000;
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(resumes.length, 1);
  } finally {
    Date.now = originalNow;
    client?.disconnect();
    globalThis.WebSocket = originalWebSocket;
  }
});
