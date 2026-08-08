import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

test("the UI names the two scopes Network and Room", () => {
  assert.match(appSource, /<div class="stat-label">Network<\/div>/);
  assert.match(appSource, /<div class="stat-label">Room<\/div>/);
  assert.doesNotMatch(appSource, /Room \/ Topic|Session ID|Instance ID/);
});

test("scope edits use the reconnecting change handlers", () => {
  assert.match(appSource, /v-model="network" @change="applyNetworkChange"/);
  assert.match(appSource, /v-model="sessionId" @change="applyRoomChange"/);
  assert.match(appSource, /sendRelayEnvelope\("bye", \{ reason: "scope_changed" \}/);
});

test("Network and Room map to PSP instance_id and session_id", () => {
  assert.match(appSource, /const instanceId = computed\(\(\) => normalizedAppliedNetworkValue\(\)\)/);
  assert.match(appSource, /session_id: normalizedAppliedRoomValue\(\)/);
  assert.match(appSource, /instance_id: instanceId\.value/);
});
