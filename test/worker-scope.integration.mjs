import assert from "node:assert/strict";

const relayUrl = process.env.FREERTC_TEST_WS || "ws://127.0.0.1:8799/ws";
const network = "network-integration";

function envelope(type, from, room, to = null, body = {}) {
  return {
    psp_version: "1.0",
    type,
    network,
    session_id: room,
    from,
    to,
    message_id: crypto.randomUUID(),
    timestamp: Date.now(),
    ttl_ms: 30000,
    body
  };
}

function waitFor(predicate, timeoutMs = 3000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        reject(new Error("Timed out waiting for Worker message"));
      }
    }, 20);
  });
}

async function connectPeer(peerId, room) {
  const socket = new WebSocket(relayUrl);
  const messages = [];
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(event.data));
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.send(JSON.stringify(envelope("announce", peerId, room, null, {
    instance_id: network,
    roles: ["peer"]
  })));
  return { socket, messages, peerId, room };
}

const peerA = await connectPeer("aaaaaaaaaaaaaaaa", "room-blue");
const peerB = await connectPeer("bbbbbbbbbbbbbbbb", "room-red");
const peerC = await connectPeer("cccccccccccccccc", "room-blue");

try {
  peerA.messages.length = 0;
  peerA.socket.send(JSON.stringify(envelope("discover", peerA.peerId, peerA.room)));
  await waitFor(() => peerA.messages.some((message) => message.type === "peer_list"));

  const peerList = peerA.messages.find((message) => message.type === "peer_list");
  const discoveredIds = (peerList.body?.peers || []).map((peer) => peer.peer_id);
  assert.deepEqual(discoveredIds, [peerC.peerId]);

  peerB.messages.length = 0;
  peerA.socket.send(JSON.stringify(envelope("offer", peerA.peerId, peerA.room, peerB.peerId, { sdp: "test" })));
  peerB.socket.send(JSON.stringify(envelope("ping", peerB.peerId, peerB.room, peerB.peerId)));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(peerB.messages.some((message) => message.type === "offer"), false);

  peerC.messages.length = 0;
  peerA.socket.send(JSON.stringify(envelope("offer", peerA.peerId, peerA.room, peerC.peerId, { sdp: "test" })));
  // A local Worker cannot reuse another request's WebSocket object, so the
  // relay safely queues the message. The destination's next scoped heartbeat
  // drains that queue.
  peerC.socket.send(JSON.stringify(envelope("ping", peerC.peerId, peerC.room, peerC.peerId)));
  await waitFor(() => peerC.messages.some((message) => message.type === "offer"));
  assert.equal(peerC.messages.find((message) => message.type === "offer")?.session_id, "room-blue");

  console.log("Worker scope isolation passed");
} finally {
  peerA.socket.close();
  peerB.socket.close();
  peerC.socket.close();
}
