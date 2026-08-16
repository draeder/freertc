import assert from "node:assert/strict";
import test from "node:test";

import {
  createRegistrationAck,
  discoverJoiningPeer,
  peerScopeKey,
  resolveSelfRelayUrl,
  scopeKey,
  validEnvelope
} from "../src/index.js";

test("joining-peer discovery starts before publication completes", async () => {
  let finishPublication;
  let publicationFinished = false;
  const events = [];
  const publication = new Promise((resolve) => {
    finishPublication = () => {
      publicationFinished = true;
      resolve([{ url: "wss://relay-b.example/ws" }]);
    };
  });

  const task = discoverJoiningPeer({
    discover: async () => {
      events.push("discover");
      return [{ peer_id: "peer-a" }];
    },
    publish: () => {
      events.push("publish");
      return publication;
    },
    send: (peers) => events.push(`send:${peers[0].peer_id}`),
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["discover", "publish", "send:peer-a"]);
  assert.equal(publicationFinished, false);
  finishPublication();
  assert.deepEqual(await task, [{ peer_id: "peer-a" }]);
});

test("an empty eager lookup uses publication results without a timer", async () => {
  const providers = [{ url: "wss://relay-b.example/ws" }];
  const discoveries = [];
  const sent = [];

  const peers = await discoverJoiningPeer({
    discover: async (publishedProviders) => {
      discoveries.push(publishedProviders);
      return publishedProviders ? [{ peer_id: "peer-b" }] : [];
    },
    publish: async () => providers,
    send: (nextPeers) => sent.push(nextPeers),
  });

  assert.deepEqual(discoveries, [undefined, providers]);
  assert.deepEqual(sent, [[{ peer_id: "peer-b" }]]);
  assert.deepEqual(peers, [{ peer_id: "peer-b" }]);
});

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

test("workers.dev deployments derive their public federation relay URL", () => {
  assert.equal(
    resolveSelfRelayUrl(
      new Request("https://freertc-relay.example-account.workers.dev/health"),
      null
    ),
    "wss://freertc-relay.example-account.workers.dev/ws"
  );
  assert.equal(
    resolveSelfRelayUrl(new Request("http://127.0.0.1:8787/health"), null),
    null
  );
  assert.equal(
    resolveSelfRelayUrl(new Request("https://relay.example.com/health"), null),
    null
  );
  assert.equal(
    resolveSelfRelayUrl(
      new Request("https://freertc-relay.example-account.workers.dev/health"),
      "https://relay.example.com"
    ),
    "wss://relay.example.com/ws"
  );
});
