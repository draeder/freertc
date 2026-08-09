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
