# peer.ooo — WebRTC Rendezvous & Signaling Edge

A production-minded WebRTC signaling service built on **Cloudflare Workers**, **WebSockets**, and **Cloudflare KV**.

---

## Table of Contents

1. [What this system is](#what-this-system-is)
2. [What it is not](#what-it-is-not)
3. [Why no Durable Objects](#why-no-durable-objects)
4. [Why Worker memory is best-effort only](#why-worker-memory-is-best-effort-only)
5. [Why KV is advisory only](#why-kv-is-advisory-only)
6. [How bootstrap discovery works](#how-bootstrap-discovery-works)
7. [How signaling relay works](#how-signaling-relay-works)
8. [Why peers own topology and state](#why-peers-own-topology-and-state)
9. [Peer ID and Network ID rules](#peer-id-and-network-id-rules)
10. [KV data model](#kv-data-model)
11. [Rate limiting and abuse resistance](#rate-limiting-and-abuse-resistance)
12. [Optional auth hook](#optional-auth-hook)
13. [Protocol reference](#protocol-reference)
14. [Project structure](#project-structure)
15. [Deployment on peer.ooo](#deployment-on-peerooo)
16. [Local dev and testing](#local-dev-and-testing)
17. [Manual test scenarios](#manual-test-scenarios)
18. [Failure modes and recovery](#failure-modes-and-recovery)
19. [Known limitations](#known-limitations)
20. [Architecture and tradeoffs](#architecture-and-tradeoffs)

---

## What this system is

`peer.ooo` is a **thin WebRTC rendezvous and signaling edge** built on Cloudflare Workers. Its responsibilities are:

- Accept WebSocket connections from browser or Node.js peers.
- Register a peer identity (`peerId` + `networkId`) for the duration of a connection.
- Store an **advisory peer advertisement** in Cloudflare KV for bootstrap discovery.
- Serve a bounded list of **advisory bootstrap candidates** to connecting peers.
- **Best-effort relay** of WebRTC signaling messages (`offer`, `answer`, `ICE candidate`) between two peers that happen to be connected to the **same Worker isolate**.

The Worker is a **rendezvous point and signaling relay** — not a topology authority, not a room server, not a membership registry.

---

## What it is not

| NOT this | Reason |
|----------|--------|
| A TURN server | No media relay |
| A canonical room server | No authoritative member list |
| A global peer registry | Worker memory is isolate-local |
| A Kademlia DHT node | No routing table in the Worker |
| A STUN server | Use public STUN (e.g. `stun.l.google.com`) |
| A reliable relay | Relay is best-effort; peers must fall back |
| A presence/liveness oracle | The Worker never knows who is "really" online |

---

## Why no Durable Objects

Durable Objects would provide a single consistent WebSocket hub per room or peer, enabling reliable relay across all Worker isolates. We deliberately avoid them because:

1. **The mesh owns routing.** If the overlay network (Kademlia-like peer mesh) is the authority on topology, there is no need for server-authoritative state.
2. **Simplicity and cost.** Durable Objects have extra complexity and billing. A pure Worker + KV design is simpler to operate.
3. **Design correctness.** Relying on Durable Objects would create a temptation to build server-authoritative rooms, which conflicts with the decentralized design goal.

**Consequence:** Relay between peers only succeeds when both peers land on the **same Cloudflare Worker isolate**. This is non-deterministic. Peers must implement mesh-level fallback routing.

---

## Why Worker memory is best-effort only

Each Cloudflare Worker **isolate** is a separate V8 context. Cloudflare routes incoming requests across many isolates globally. The `peers` Map in `src/index.js` is **local to one isolate instance**. It is not shared between isolates.

This means:

- A peer registered to isolate A **cannot** be reached by relay from isolate B.
- There is no coordination between isolate instances.
- After a Worker update or idle eviction, all in-memory state is gone.

**Design implication:** This Worker never claims to know all currently-connected peers. The `target_not_connected` error is normal and expected. Peers must use their mesh for routing when relay misses.

---

## Why KV is advisory only

Cloudflare KV is **eventually consistent** with high read availability. It is designed for read-heavy workloads, not for real-time membership.

- A KV entry may be seconds to minutes stale when read.
- A peer that has disconnected may still appear in KV until its TTL expires.
- A peer that just connected may not yet be visible in KV to other regions.
- KV has no efficient list-all operation; the shard index is an approximation.

**Design implication:** Bootstrap candidates from KV are hints, not facts. Every peer that receives a candidate must probe it (e.g. via WebRTC offer or mesh ping) to confirm it is alive and reachable.

---

## How bootstrap discovery works

1. When a peer registers, the Worker writes an advisory advertisement to KV:
   - Key: `net:{networkId}:peer:{peerId}` → JSON advertisement record
   - Key: `net:{networkId}:idx:{shard}` → shard index (array of peer IDs)
2. Shard indices use the first hex digit of the peer ID (16 shards, `0`–`f`).
3. On `get_bootstrap`, the Worker reads a random sample of shard indices, collects peer IDs, then fetches their advertisement records.
4. Stale records (older than `BOOTSTRAP_STALE_MS`, default 5 minutes) are filtered before being returned.
5. The response is annotated with `advisory: true` to signal that candidates must be verified.

**The client MUST NOT assume bootstrap candidates are live.**

---

## How signaling relay works

1. Peer A and Peer B both connect to `wss://peer.ooo/ws` and register.
2. Peer A sends a `relay` message with `toPeerId = B` and `relayType = offer`.
3. The Worker checks its isolate-local `peers` Map for peer B.
4. **If B is in the same isolate:** The offer is forwarded to B's socket. A receives `relayed` confirmation.
5. **If B is not in this isolate:** A receives `target_not_connected` error. A must use its mesh to reach B via another route (e.g. relay through a mutual peer, or try another bootstrap candidate endpoint).

**The Worker never pretends relay succeeded when it failed.**

---

## Why peers own topology and state

The overlay network is decentralized. Each peer maintains:

- **Kademlia-like buckets** — routing table of known peers by XOR distance.
- **Partial mesh** — direct WebRTC data channels to nearby peers.
- **Liveness state** — heartbeat tracking per peer connection.
- **Retry/reconnect behavior** — re-registration, re-bootstrap, re-signaling.
- **Local routing knowledge** — which peers to use for multi-hop relay.

The Worker contributes only **initial discovery** (bootstrap) and **direct signaling** (offer/answer/ICE relay). Once a peer has at least one active data channel, it no longer needs the Worker for routing.

---

## Peer ID and Network ID rules

### Peer ID (`peerId`)

- **Format:** lowercase hexadecimal string only (`[0-9a-f]+`)
- **Minimum length:** 16 hex characters (8 bytes / 64 bits)
- **Maximum length:** 128 hex characters (64 bytes / 512 bits)
- **Normalization:** automatically lowercased and trimmed
- **Rationale:** Hex format is unambiguous, encoding-safe, and maps naturally to cryptographic key material. The length bounds allow anything from a fast random ID (8 bytes) to a full 256-bit key hash (32 bytes).

### Network ID (`networkId`)

- **Format:** lowercase alphanumeric with optional internal hyphens (`[a-z0-9][a-z0-9\-]*[a-z0-9]` or a single `[a-z0-9]`)
- **Minimum length:** 1 character
- **Maximum length:** 64 characters
- **Normalization:** automatically lowercased and trimmed
- **Rationale:** Human-readable namespacing for overlay isolation. Hyphens allow descriptive names like `my-app-prod`. Leading/trailing hyphens are rejected to prevent ambiguity.

---

## KV data model

```
net:{networkId}:peer:{peerId}
  → { peerId, networkId, capabilities, regionHint, ts }
  → TTL: 600 seconds (CONFIG.KV_PEER_TTL_SECONDS)

net:{networkId}:idx:{shard}
  → [ peerId, peerId, ... ]   (up to 32 entries per shard)
  → TTL: 1200 seconds
  → shard = peerId[0] (first hex digit, '0'–'f')
```

**Notes:**

- There is no global list. Discovery reads a random sample of shards.
- Shard indices are approximate (race conditions on concurrent writes are fine).
- Peer records expire automatically via KV TTL. On clean disconnect, the TTL is shortened to 60 seconds.
- KV values are bounded: no SDP, no large payloads, only metadata.
- Eventual consistency means duplicate entries, stale entries, and missing entries are all normal.

---

## Rate limiting and abuse resistance

Per-socket controls (isolate-local only):

| Control | Default | Description |
|---------|---------|-------------|
| Registration timeout | 10 seconds | Socket closed if no `register` arrives |
| Max message size | 16 KiB | Socket closed on violation |
| Message rate limit | 60 messages / 10 seconds | Socket closed on violation |
| Idle timeout | 2 minutes | Socket closed if no messages received |

**Close codes used:**
- `4001` — unauthorized
- `4007` — message too large
- `4008` — register timeout
- `4009` — idle timeout
- `4029` — rate limit exceeded

These controls are per-connection. There is no cross-isolate IP-level rate limiting in this implementation. For production abuse resistance, add Cloudflare WAF rules or a rate-limit middleware at the zone level.

---

## Optional auth hook

See `src/auth.js`.

By default, all anonymous peers are accepted (`CONFIG.AUTH_REQUIRED = false`).

To enable:

1. Set `AUTH_REQUIRED = true` in `src/config.js`.
2. Add a Worker secret: `wrangler secret put AUTH_SECRET`.
3. Peers include `auth: { token: "..." }` in their `register` message.
4. The token is verified as `base64url(payload).base64url(HMAC-SHA-256(payload, secret))`.

**What auth protects:** Prevents unauthenticated peers from registering and consuming bootstrap/relay resources.

**What auth does NOT protect:**
- A valid token holder can still claim any peer ID (no peer ID binding).
- There is no end-to-end identity proof between peers.
- For peer-to-peer identity, sign your peer ID at the overlay layer.

---

## Protocol reference

All messages are JSON over WebSocket.

### Client → Worker

#### `register`
```json
{
  "type": "register",
  "peerId": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
  "networkId": "my-app",
  "timestamp": 1700000000000,
  "capabilities": { "role": "browser", "version": "1" },
  "regionHint": "us-east",
  "auth": { "token": "..." }
}
```

#### `advertise`
```json
{
  "type": "advertise",
  "capabilities": { "role": "browser", "relay": true }
}
```

#### `get_bootstrap`
```json
{
  "type": "get_bootstrap",
  "networkId": "my-app"
}
```

#### `relay`
```json
{
  "type": "relay",
  "toPeerId": "deadbeefdeadbeefdeadbeefdeadbeef",
  "fromPeerId": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
  "relayType": "offer",
  "payload": { "type": "offer", "sdp": "v=0\r\n..." },
  "messageId": "f1e2d3c4b5a60718",
  "timestamp": 1700000000000
}
```
`relayType` values: `offer`, `answer`, `candidate`, `renegotiate`, `bye`

#### `ping`
```json
{ "type": "ping", "ts": 1700000000000 }
```

#### `unregister`
```json
{ "type": "unregister" }
```

---

### Worker → Client

#### `registered`
```json
{
  "type": "registered",
  "peerId": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
  "networkId": "my-app",
  "ts": 1700000000001
}
```

#### `bootstrap_candidates`
```json
{
  "type": "bootstrap_candidates",
  "networkId": "my-app",
  "candidates": [
    {
      "peerId": "deadbeefdeadbeefdeadbeefdeadbeef",
      "networkId": "my-app",
      "capabilities": { "role": "browser" },
      "regionHint": "eu-west",
      "advertisedAt": 1699999900000,
      "advisory": true
    }
  ],
  "ts": 1700000000002
}
```

#### `incoming_relay`
```json
{
  "type": "incoming_relay",
  "fromPeerId": "deadbeefdeadbeefdeadbeefdeadbeef",
  "networkId": "my-app",
  "relayType": "offer",
  "payload": { "type": "offer", "sdp": "v=0\r\n..." },
  "messageId": "f1e2d3c4b5a60718",
  "originalTimestamp": 1700000000000,
  "ts": 1700000000003
}
```

#### `relayed`
```json
{
  "type": "relayed",
  "toPeerId": "deadbeefdeadbeefdeadbeefdeadbeef",
  "messageId": "f1e2d3c4b5a60718",
  "ts": 1700000000004
}
```

#### `pong`
```json
{ "type": "pong", "ts": 1700000000000, "serverTs": 1700000000001 }
```

#### `error`
```json
{
  "type": "error",
  "code": "target_not_connected",
  "message": "Target peer is not connected to this edge node.",
  "toPeerId": "deadbeefdeadbeefdeadbeefdeadbeef",
  "messageId": "f1e2d3c4b5a60718",
  "ts": 1700000000005
}
```

**Error codes:** `invalid_json`, `invalid_message`, `invalid_peer_id`, `invalid_network_id`, `not_registered`, `register_timeout`, `duplicate_register`, `network_mismatch`, `target_not_connected`, `rate_limit_exceeded`, `message_too_large`, `unauthorized`, `internal_error`, `invalid_relay_type`, `missing_field`

---

## Project structure

```
peer.ooo/
├── package.json          # npm scripts + wrangler dev dependency
├── wrangler.jsonc         # Cloudflare Workers deployment config
├── README.md             # This file
├── src/
│   ├── index.js          # Main Worker entry point (HTTP + WebSocket handler)
│   ├── config.js         # Tunable constants
│   ├── protocol.js       # Message type constants + outbound builders
│   ├── validation.js     # Strict input validation and normalization
│   ├── kv.js             # Advisory KV read/write helpers
│   ├── rate-limit.js     # Per-socket sliding-window rate limiter
│   ├── log.js            # Structured logging helpers
│   ├── errors.js         # Error codes and structured error factories
│   ├── util.js           # Miscellaneous helpers (ID gen, JSON parse, etc.)
│   └── auth.js           # Optional HMAC auth hook
└── public/
    ├── client.html       # Browser demo UI
    └── client.js         # Browser demo client (WebSocket + WebRTC scaffolding)
```

---

## Deployment on peer.ooo

### Prerequisites

- [Cloudflare account](https://cloudflare.com) with `peer.ooo` zone added
- Node.js 18+
- `npm install` to install wrangler

### 1. Create the KV namespace

```bash
npx wrangler kv namespace create PEERS
# Copy the resulting id into wrangler.jsonc → kv_namespaces[0].id

npx wrangler kv namespace create PEERS --preview
# Copy the resulting id into wrangler.jsonc → kv_namespaces[0].preview_id
```

### 2. Configure `wrangler.jsonc`

Replace the placeholder KV namespace IDs with the values from step 1.

Ensure the `routes` block matches your zone:
```jsonc
"routes": [
  { "pattern": "peer.ooo/*", "zone_name": "peer.ooo" }
]
```

### 3. (Optional) Add auth secret

```bash
npx wrangler secret put AUTH_SECRET
# Enter your shared secret when prompted
```

Then set `AUTH_REQUIRED = true` in `src/config.js`.

### 4. Deploy

```bash
npm run deploy
# or: npx wrangler deploy
```

### 5. Verify

```bash
curl https://peer.ooo/
# → {"status":"ok","service":"peer.ooo signaling edge","ts":...}
```

---

## Local dev and testing

```bash
npm install
npm run dev
# Wrangler starts a local server at http://localhost:8787
```

For local dev, update `public/client.js` or override via the browser demo UI:
```
Signal URL: ws://localhost:8787/ws
```

**Local KV:** Wrangler creates an in-memory local KV store automatically during `wrangler dev`. Data does not persist between restarts.

**Tail logs:**
```bash
npm run tail
# Streams structured JSON logs from the deployed Worker
```

---

## Manual test scenarios

### 1. Health endpoint works
```bash
curl https://peer.ooo/
# Expected: {"status":"ok",...}
```

### 2. WebSocket connection upgrades
```bash
# Using wscat: npm install -g wscat
wscat -c wss://peer.ooo/ws
# Expected: connected (no message yet — register timeout starts)
```

### 3. Register succeeds
```
Send: {"type":"register","peerId":"a1b2c3d4e5f6a1b2a1b2c3d4e5f6a1b2","networkId":"test","timestamp":1700000000000}
Expected: {"type":"registered","peerId":"a1b2c3d4e5f6a1b2a1b2c3d4e5f6a1b2","networkId":"test",...}
```

### 4. Malformed register fails
```
Send: {"type":"register","peerId":"not-hex!!","networkId":"test","timestamp":1700000000000}
Expected: {"type":"error","code":"invalid_peer_id",...}
```

### 5. Bootstrap lookup returns candidates
```
After registering:
Send: {"type":"get_bootstrap","networkId":"test"}
Expected: {"type":"bootstrap_candidates","candidates":[...],...}
(May be empty if no other peers have registered recently)
```

### 6. Relay to connected peer succeeds (same isolate)
```
Open two wscat connections, register both, then from connection A:
Send: {"type":"relay","toPeerId":"<B's peerId>","fromPeerId":"<A's peerId>","relayType":"offer","payload":{"type":"offer","sdp":"test"},"messageId":"abc123","timestamp":1700000000000}
Expected on A: {"type":"relayed",...}
Expected on B: {"type":"incoming_relay","fromPeerId":"<A>","relayType":"offer",...}
```

### 7. Relay to unavailable peer returns structured error
```
Send: {"type":"relay","toPeerId":"ffffffffffffffffffffffffffffffff","relayType":"offer","payload":{},"messageId":"xyz","timestamp":1700000000000}
Expected: {"type":"error","code":"target_not_connected",...}
```

### 8. Reconnect and re-register works
The browser client in `public/client.js` implements exponential backoff reconnect automatically. Closing the WebSocket triggers a reconnect after `BACKOFF_BASE_MS` (default 1 second), increasing up to `BACKOFF_MAX_MS` (30 seconds).

### 9. Stale candidate handling
Bootstrap candidates include `advertisedAt` timestamps. The client in `client.js` tracks `localSeenAt` and provides `mesh.getFreshCandidates(maxAgeMs)`. Peers should probe candidates with a WebRTC offer before trusting they are live, and discard candidates that fail to respond within a reasonable timeout.

### 10. Oversized message handling
```
Send a message larger than 16 KiB.
Expected: {"type":"error","code":"message_too_large",...} followed by socket close 4007.
```

---

## Failure modes and recovery

| Failure | Behavior | Recovery |
|---------|----------|----------|
| Target peer in different isolate | `target_not_connected` error | Use mesh routing; try another candidate |
| Stale KV bootstrap entry | Candidate returned but probe fails | Discard candidate; re-bootstrap |
| Worker restarted / isolate evicted | All in-memory peers lost | Client reconnects and re-registers |
| KV write fails | Advisory advertisement not stored | Peer still works; just not discoverable via bootstrap until next successful write |
| Register timeout | Socket closed with code 4008 | Client reconnects and retries register |
| Rate limit exceeded | Socket closed with code 4029 | Client backs off before reconnecting |
| Network partition | WebSocket disconnects | Client reconnects with exponential backoff |
| SDP too large for relay | Message rejected (>16 KiB) | Compress or trim SDP; use trickle ICE |

---

## Known limitations

1. **Relay is isolate-bound.** Without Durable Objects, relay between two peers only works in the same Worker isolate. This is non-deterministic in production. For reliable relay, route through the mesh.

2. **Bootstrap is approximate.** KV is eventually consistent. Discovery misses and stale results are expected; the design accounts for them.

3. **No cross-isolate presence.** The Worker cannot tell you whether a peer is "online". Only the mesh knows liveness.

4. **No TURN.** Media traversal through symmetric NAT requires a TURN server. This Worker does not provide one.

5. **No persistent rooms.** There is no server-side room concept. All grouping is peer-owned.

6. **Rate limiting is per-connection, per-isolate.** There is no global IP-level rate limiter in the Worker code. Use Cloudflare WAF for that.

---

## Architecture and tradeoffs

### Why this design is correct

The fundamental insight is that **the mesh, not the Worker, holds the real state**. A WebRTC rendezvous service only needs to solve the initial introduction problem: "how do two peers that don't know each other's address find each other?"

Once peers have exchanged SDP and ICE candidates (possibly via this Worker), they communicate directly via WebRTC data channels. From that point, the Worker is irrelevant to their communication.

The decentralized mesh handles:
- Peer discovery beyond initial bootstrap
- Liveness tracking and failure detection
- Multi-hop routing when direct relay fails
- Topology repair when peers join or leave

The Worker handles:
- TLS termination and WebSocket upgrade
- Bounded-size advisory peer advertisements in KV
- Best-effort direct signaling relay (works when peers land on same isolate)
- Structured error reporting so clients know when to fall back

### Tradeoffs accepted

| Tradeoff | Accepted because |
|----------|-----------------|
| Relay sometimes fails | Mesh provides fallback; Worker is not a relay guarantee |
| Bootstrap data is stale | Peers verify candidates; stale data is harmless with probing |
| No global peer list | Correctness — a global list would be misleading anyway |
| No Durable Objects | Simplicity, cost, and design correctness |
| No auth by default | Anonymous overlay; auth hook available when needed |
