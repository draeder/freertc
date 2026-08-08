import assert from "node:assert/strict";
import test from "node:test";

import { peerScopeKey, scopeKey, validEnvelope } from "../src/index.js";

const envelope = {
  psp_version: "1.0",
  type: "announce",
  network: "network-alpha",
  session_id: "room-blue",
  from: "0123456789abcdef",
  message_id: "message-1",
  timestamp: 1,
  body: { instance_id: "network-alpha" }
};

test("Network and Room jointly define the routing scope", () => {
  assert.notEqual(
    scopeKey("network-alpha", "room-blue"),
    scopeKey("network-alpha", "room-red")
  );
  assert.notEqual(
    scopeKey("network-alpha", "room-blue"),
    scopeKey("network-beta", "room-blue")
  );
  assert.equal(
    scopeKey("network-alpha", "room-blue"),
    scopeKey("network-alpha", "room-blue")
  );
});

test("Peer lookup is isolated by both Network and Room", () => {
  assert.notEqual(
    peerScopeKey("network-alpha", "room-blue", "peer-a"),
    peerScopeKey("network-alpha", "room-red", "peer-a")
  );
});

test("Room is required on every client envelope", () => {
  assert.equal(validEnvelope(envelope), true);
  assert.equal(validEnvelope({ ...envelope, session_id: "" }), false);
  assert.equal(validEnvelope({ ...envelope, session_id: null }), false);
});
