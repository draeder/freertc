import assert from "node:assert/strict";
import test from "node:test";
import { claimFederationHeartbeat, sharedFederatedPeerQuery } from "../src/index.js";
import { openSqliteD1 } from "../src/node/d1-sqlite.js";

test("one federation heartbeat per relay per interval, whichever isolate asks", async () => {
  const db = await openSqliteD1({ filename: ":memory:", migrationsDir: new URL("../migrations", import.meta.url).pathname });
  const t0 = 10_000_000;
  // Two isolates check at once: one claims it.
  const first = await Promise.all([claimFederationHeartbeat(db, t0), claimFederationHeartbeat(db, t0)]);
  assert.deepEqual(first.sort(), [false, true]);
  // Within the interval nobody claims it again.
  assert.equal(await claimFederationHeartbeat(db, t0 + 60_000), false);
  // A little before the interval ends still claims (isolates check on their own clocks).
  assert.equal(await claimFederationHeartbeat(db, t0 + 2 * 60_000 - 1_000), true);
});

test("a room's discovers share one round of federated peer queries", async () => {
  const original = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    return new Response(JSON.stringify({ peers: [{ peer_id: "remote-1" }] }), { headers: { "Content-Type": "application/json" } });
  };
  try {
    const relays = ["wss://a.example/ws", "wss://b.example/ws"];
    const lists = await Promise.all([1, 2, 3].map(() => sharedFederatedPeerQuery("wss://self.example/ws", "net", "room-share", relays, new Map())));
    assert.equal(asked.length, 2, "one query per relay for three discovers");
    for (const list of lists) assert.equal(list.length, 2);
    assert.ok(asked.every((url) => !url.includes("exclude=")), "the shared list is not filtered for one requester");
    await sharedFederatedPeerQuery("wss://self.example/ws", "net", "other-room", relays, new Map());
    assert.equal(asked.length, 4, "another room asks for itself");
  } finally {
    globalThis.fetch = original;
  }
});
