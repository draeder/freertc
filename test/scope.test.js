import assert from "node:assert/strict";
import test from "node:test";

import { createRegistrationAck, peerScopeKey, scopeKey, validEnvelope } from "../src/index.js";

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

test("accepted announcements receive a scoped registration acknowledgement", () => {
  const ack = createRegistrationAck(envelope, "relay-one");
  assert.equal(ack.type, "ack");
  assert.equal(ack.network, envelope.network);
  assert.equal(ack.session_id, envelope.session_id);
  assert.equal(ack.to, envelope.from);
  assert.equal(ack.reply_to, envelope.message_id);
  assert.deepEqual(ack.body, { status: "ok", action: "announce" });
  assert.equal(validEnvelope(ack), true);
});
