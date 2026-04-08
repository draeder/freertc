# freertc — WebRTC Signaling Worker

A production-ready WebRTC rendezvous and signaling service built on **Cloudflare Workers**, **WebSockets**, and **MongoDB Atlas**.

**GitHub:** [github.com/draeder/freertc](https://github.com/draeder/freertc)

The signaling protocol is an implementation of the [Peer Signaling Protocol (PSP) specification](https://github.com/draeder/Peer-Signaling-Protocol-Specification) — a transport-agnostic standard defining peer announcement, discovery, and WebRTC handshake relay.

Deploy on **Cloudflare** in minutes — on your own domain or the free `*.workers.dev` subdomain. Run `npm run setup` to get started. **The demo UI is optional** — the Worker is fully functional as a headless signaling service.

---

## Table of Contents

1. [What this system is](#what-this-system-is)
2. [Protocol specification (PSP)](#protocol-specification-psp)
3. [What it is not](#what-it-is-not)
4. [Why no Durable Objects](#why-no-durable-objects)
5. [Why Worker memory is best-effort only](#why-worker-memory-is-best-effort-only)
6. [Why discovery data is advisory only](#why-discovery-data-is-advisory-only)
7. [How bootstrap discovery works](#how-bootstrap-discovery-works)
8. [How signaling relay works](#how-signaling-relay-works)
9. [Why peers own topology and state](#why-peers-own-topology-and-state)
10. [Peer ID and Network ID rules](#peer-id-and-network-id-rules)
11. [Data model](#data-model)
12. [Rate limiting and abuse resistance](#rate-limiting-and-abuse-resistance)
13. [Optional auth hook](#optional-auth-hook)
14. [Protocol reference](#protocol-reference)
15. [Project structure](#project-structure)
16. [Quick start](#quick-start)
17. [Manual deployment](#manual-deployment)
18. [Using the service without the demo UI](#using-the-service-without-the-demo-ui)
19. [Local dev and testing](#local-dev-and-testing)
20. [Manual test scenarios](#manual-test-scenarios)
21. [Failure modes and recovery](#failure-modes-and-recovery)
22. [Known limitations](#known-limitations)
23. [Architecture and tradeoffs](#architecture-and-tradeoffs)

---

## What this system is

This is a **thin WebRTC rendezvous and signaling edge** built on Cloudflare Workers. Its responsibilities are:

- Accept WebSocket connections from browser or Node.js peers.
- Register a peer identity (`peerId` + `networkId`) for the duration of a connection.
- Store an **advisory peer advertisement** in MongoDB for bootstrap discovery.
- Serve a bounded list of **advisory bootstrap candidates** to connecting peers.
- **Relay** of WebRTC signaling messages (`offer`, `answer`, `ICE candidate`) — directly via in-memory socket forwarding when both peers share the same Worker isolate, or via a MongoDB mailbox when they don't.

The Worker is a **rendezvous point and signaling relay** — not a topology authority, not a room server, not a membership registry.

---

## Protocol specification (PSP)

This Worker implements the signaling layer defined by the **[Peer Signaling Protocol (PSP)](https://github.com/draeder/Peer-Signaling-Protocol-Specification)** — a transport-agnostic, open specification for WebRTC peer rendezvous and handshake relay.

PSP defines:
- A standard JSON envelope (`psp_version`, `type`, `network`, `from`, `message_id`, `timestamp`, `body`)
- Core message types: `announce`, `withdraw`, `discover`, `peer_list`, `offer`, `answer`, `ice_candidate`, `ice_end`, `bye`, `error`, `ack`, and extension types
- State machines for glare handling, ICE trickling, and session teardown
- Optional signing, replay protection, and acknowledgment semantics

The Worker's message types (`register`, `relay`, `get_bootstrap`, etc.) map to the PSP "minimal profile" required types. Any PSP-compliant client can use this service as a signaling transport. See the [Protocol reference](#protocol-reference) section below for the exact wire format this Worker uses, and the [PSP specification](https://github.com/draeder/Peer-Signaling-Protocol-Specification) for the full standard.

---

## What it is not

| NOT this | Reason |
|----------|--------|
| A TURN server | No media relay |
| A canonical room server | No authoritative member list |
| A global peer registry | Worker memory is isolate-local |
| A Kademlia DHT node | No routing table in the Worker |
| A STUN server | Use public STUN (e.g. `stun.l.google.com`) |
| A guaranteed-delivery relay | Relay is best-effort: in-memory if same isolate, MongoDB mailbox otherwise. Messages expire (TTL) and are lost if MongoDB is unreachable or if the receiver never calls `pull_mailbox` |
| A presence/liveness oracle | The Worker never knows who is "really" online |

---

## Why no Durable Objects

Durable Objects would provide a single consistent WebSocket hub per room or peer, enabling reliable relay across all Worker isolates. We deliberately avoid them because:

1. **The mesh owns routing.** If the overlay network (Kademlia-like peer mesh) is the authority on topology, there is no need for server-authoritative state.
2. **Simplicity and cost.** Durable Objects have extra complexity and billing. A pure Worker + MongoDB design is simpler to operate.
3. **Design correctness.** Relying on Durable Objects would create a temptation to build server-authoritative rooms, which conflicts with the decentralized design goal.

**Consequence for relay:** Direct socket forwarding only works when both peers land on the same isolate. When they don't, the Worker falls back to a MongoDB mailbox. Peer B drains the mailbox by sending `pull_mailbox` after connecting. If the mailbox enqueue also fails, a `target_not_connected` error is returned and mesh-level fallback routing is needed.

---

## Why Worker memory is best-effort only

Each Cloudflare Worker **isolate** is a separate V8 context. Cloudflare routes incoming requests across many isolates globally. The `peers` Map in `src/index.js` is **local to one isolate instance**. It is not shared between isolates.

This means:

- A peer registered to isolate A **cannot** be reached by relay from isolate B.
- There is no coordination between isolate instances.
- After a Worker update or idle eviction, all in-memory state is gone.

**Design implication:** This Worker never claims to know all currently-connected peers. The `target_not_connected` error is normal and expected. Peers must use their mesh for routing when relay misses.

---

## Why discovery data is advisory only

MongoDB Atlas is used as the advisory hint store for peer bootstrap discovery. Data here is eventually consistent and may be stale.

- A peer record may be seconds to minutes stale when read.
- A peer that has disconnected may still appear until its TTL expires.
- A peer that just connected may not yet be visible to other regions.

**Design implication:** Bootstrap candidates from MongoDB are hints, not facts. Every peer that receives a candidate must probe it (e.g. via WebRTC offer or mesh ping) to confirm it is alive and reachable.

---

## How bootstrap discovery works

1. When a peer registers, the Worker writes an advisory advertisement to MongoDB:
   - Collection `peers`: full advertisement record keyed by `networkId` + `peerId`
   - Collection `shards`: shard index (array of peer IDs) keyed by `networkId` + first hex digit of `peerId`
2. Shard indices use the first hex digit of the peer ID (16 shards, `0`–`f`).
3. On `get_bootstrap`, the Worker reads **all 16 shard indices**, collects peer IDs, then fetches their advertisement records in parallel. (Reading all shards avoids false negatives in small or skewed networks.)
4. Stale records (older than `BOOTSTRAP_STALE_MS`, default 5 minutes) are filtered before being returned.
5. The response is annotated with `advisory: true` to signal that candidates must be verified.

**The client MUST NOT assume bootstrap candidates are live.**

---

## How signaling relay works

1. Peer A and Peer B both connect to `wss://your-domain.example/ws` and register.
2. Peer A sends a `relay` message with `toPeerId = B` and `relayType = offer`.
3. The Worker checks its isolate-local `peers` Map for peer B.
4. **If B is in the same isolate:** The offer is forwarded to B's socket. A receives `relayed` confirmation.
5. **If B is not in this isolate:** The Worker enqueues the message into a MongoDB mailbox keyed to B (`mailbox` collection). A receives a `relayed` confirmation with `via: "kv_mailbox"`. Peer B drains its mailbox by sending a `pull_mailbox` message after connecting.
6. **If the mailbox enqueue also fails:** A receives a `target_not_connected` error. A must use its mesh to reach B via another route (e.g. relay through a mutual peer, or try another bootstrap candidate endpoint).

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

## Data model

Stored in MongoDB Atlas, database `signal`:

```
Collection: peers
  { peerId, networkId, capabilities, regionHint, ts }
  TTL index: ts + CONFIG.KV_PEER_TTL_SECONDS (default 600s)

Collection: shards
  { networkId, shard, peers: [ peerId, ... ] }  (up to 32 per shard)
  shard = peerId[0]  (first hex digit, '0'–'f')

Collection: mailbox
  { networkId, toPeerId, payload, ts }
  TTL index: ts + 120s
  Written on cross-isolate relay miss; consumed by pull_mailbox
```

**Notes:**

- There is no global list. Discovery reads all 16 shards to build a candidate pool.
- Shard indices are approximate (race conditions on concurrent writes are fine).
- Peer records expire automatically via MongoDB TTL. On clean disconnect, the TTL is shortened to 60 seconds.
- Mailbox messages expire after 120 seconds if not consumed.
- MongoDB values are bounded: no SDP, no large payloads, only metadata.
- Eventual consistency means duplicate entries, stale entries, and missing entries are all normal.

---

## Rate limiting and abuse resistance

Per-socket controls (isolate-local only):

| Control | Default | Description |
|---------|---------|-------------|
| Registration timeout | 10 seconds | Socket closed if no `register` arrives |
| Max message size | 16 KiB | Socket closed on violation |
| Message rate limit | 120 messages / 10 seconds | Socket closed on violation |
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

1. Set `AUTH_REQUIRED = true` in `src/config.js` (the install wizard does this automatically).
2. Add a Worker secret: `npx wrangler secret put AUTH_SECRET`.
3. Peers include `auth: { token: "..." }` in their `register` message.
4. The token is verified as `base64url(payload).base64url(HMAC-SHA-256(payload, secret))`.

**What auth protects:** Prevents unauthenticated peers from registering and consuming bootstrap/relay resources.

**What auth does NOT protect:**
- A valid token holder can still claim any peer ID (no peer ID binding).
- There is no end-to-end identity proof between peers.
- For peer-to-peer identity, sign your peer ID at the overlay layer.

---

## Protocol reference

> This Worker implements a subset of the [Peer Signaling Protocol (PSP) specification](https://github.com/draeder/Peer-Signaling-Protocol-Specification). The message types below are the Worker's wire format. See the spec for the full envelope definition and extended message types.

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

#### `pull_mailbox`
```json
{ "type": "pull_mailbox" }
```
Drains all pending cross-isolate relay messages from the peer's MongoDB mailbox. The Worker responds with zero or more `incoming_relay` messages. Clients should send this immediately after registering and periodically while connected.

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
├── package.json               # npm scripts + dependencies
├── wrangler.jsonc             # Cloudflare Workers deployment config (gitignored)
├── wrangler.template.jsonc    # Template — copy to wrangler.jsonc and fill in
├── README.md                  # This file
├── src/
│   ├── index.js               # Main Worker entry point (HTTP + WebSocket handler)
│   ├── config.js              # Tunable constants
│   ├── protocol.js            # Message type constants + outbound builders
│   ├── validation.js          # Strict input validation and normalization
│   ├── kv.js                  # MongoDB-backed advisory store helpers
│   ├── rate-limit.js          # Per-socket sliding-window rate limiter
│   ├── log.js                 # Structured logging helpers
│   ├── errors.js              # Error codes and structured error factories
│   ├── util.js                # Miscellaneous helpers
│   └── auth.js                # Optional HMAC auth hook
├── scripts/
│   ├── install-wizard.js      # Interactive setup wizard (npm run setup)
│   └── setup-mongo-indexes.js # Create MongoDB TTL indexes
├── demo/                      # (optional) Vue 3 + Vite demo UI (builds into public/)
└── public/                    # Static assets served by the Worker
    ├── index.html
    ├── client.html
    └── client.js
```

---

## Quick start

```bash
npm run setup
```

The interactive wizard will:
- Check and offer to install prerequisites (wrangler, Atlas CLI)
- Pre-fill your worker name and optional domain from any existing `wrangler.jsonc`
- Authenticate with MongoDB Atlas CLI and let you pick a project, cluster, and DB user
- Write `wrangler.jsonc` for you
- Push `MONGODB_URI` (and optionally `AUTH_SECRET`) as Worker secrets
- Optionally deploy

---

## Manual deployment

### Prerequisites

- [Cloudflare account](https://cloudflare.com) (free tier works; a custom domain is optional — see below)
- [MongoDB Atlas](https://www.mongodb.com/atlas) cluster (free tier works)
- Node.js 18+

### 1. Configure `wrangler.jsonc`

Copy the template and fill in your values:

```bash
cp wrangler.template.jsonc wrangler.jsonc
```

**With a custom domain:**
```jsonc
{
  "name": "your-worker-name",
  "routes": [
    { "pattern": "your-domain.example/*", "zone_name": "your-domain.example" }
  ]
}
```

**Without a custom domain (free `workers.dev` subdomain):**
```jsonc
{
  "name": "your-worker-name"
}
```
Your Worker will be reachable at `https://your-worker-name.<account>.workers.dev` and the WebSocket URL is `wss://your-worker-name.<account>.workers.dev/ws`.

### 2. Add MongoDB URI secret

```bash
npx wrangler secret put MONGODB_URI
# Paste your mongodb+srv://... URI when prompted
```

### 3. Create MongoDB indexes

```bash
MONGODB_URI="mongodb+srv://..." node scripts/setup-mongo-indexes.js
```

### 4. (Optional) Enable auth

```bash
npx wrangler secret put AUTH_SECRET
```

Then set `AUTH_REQUIRED = true` in `src/config.js`.

### 5. Deploy

**With demo UI** (default):
```bash
npm run deploy
```
Builds the demo UI, clears stale assets, copies the fresh bundle to `public/`, then deploys the Worker.

**Worker only** (no demo UI):
```bash
npx wrangler deploy
```
Deploys just the Worker. The demo UI is not required — the signaling service works as a headless API. See [Using the service without the demo UI](#using-the-service-without-the-demo-ui).

### 6. Verify

```bash
curl https://your-domain.example/
# → {"status":"ok","service":"webrtc signaling edge","ts":...}
```

---

## Using the service without the demo UI

The Worker is a fully standalone WebSocket signaling service. The demo UI is optional — you can delete or ignore the `demo/` directory entirely.

### Connecting with wscat

Install [wscat](https://github.com/websockets/wscat) (`npm install -g wscat`) and connect directly:

```bash
# Deployed
wscat -c wss://your-domain.example/ws

# Local dev (npm run dev)
wscat -c ws://localhost:8787/ws
```

Register a peer:
```json
{"type":"register","peerId":"a1b2c3d4e5f6a1b2a1b2c3d4e5f6a1b2","networkId":"my-app","timestamp":1700000000000}
```

Request bootstrap candidates:
```json
{"type":"get_bootstrap","networkId":"my-app"}
```

Relay a WebRTC offer to another peer:
```json
{"type":"relay","toPeerId":"deadbeefdeadbeefdeadbeefdeadbeef","fromPeerId":"a1b2c3d4e5f6a1b2a1b2c3d4e5f6a1b2","relayType":"offer","payload":{"type":"offer","sdp":"v=0\r\n..."},"messageId":"abc123","timestamp":1700000000000}
```

### Using `signalingClient.js` as a standalone library

`demo/src/utils/signalingClient.js` is a self-contained client that works in both browsers and Node.js:

```js
import { createSignalingClient } from './demo/src/utils/signalingClient.js'

const client = createSignalingClient({
  signalUrl: 'wss://your-domain.example/ws',
  peerId: 'a1b2c3d4e5f6a1b2a1b2c3d4e5f6a1b2',
  networkId: 'my-app',
})

client.on('registered', () => console.log('registered'))
client.on('bootstrap_candidates', ({ candidates }) => console.log(candidates))
client.on('incoming_relay', ({ fromPeerId, relayType, payload }) => {
  // handle offer/answer/candidate from fromPeerId
})

client.connect()
```

The client handles WebSocket lifecycle, exponential backoff reconnection, and re-registration automatically.

### Implementing a custom client

Any WebSocket client that speaks JSON can use this service. The wire protocol is documented in the [Protocol reference](#protocol-reference) section above. For the formal type definitions and state machines, refer to the [PSP specification](https://github.com/draeder/Peer-Signaling-Protocol-Specification).

**Minimal session lifecycle:**
1. Open a WebSocket to `wss://your-domain/ws`
2. Send `register` within a few seconds (connection closes on timeout)
3. Receive `registered` confirmation
4. Send `get_bootstrap` to get a list of known peers in your network
5. Initiate WebRTC handshake by sending `relay` messages (`offer` → `answer` → `candidate`)
6. Send `pull_mailbox` periodically to retrieve cross-isolate relay messages
7. Send `unregister` (or just close the WebSocket) when done

---

## Local dev and testing

```bash
npm install
npm run dev
# Wrangler starts a local server at http://localhost:8787
```

The full signaling service runs locally — no Cloudflare account or deployment needed:

| Endpoint | Local URL |
|----------|-----------|
| Health check | `http://localhost:8787/` |
| WebSocket signal | `ws://localhost:8787/ws` |
| Demo UI | `http://localhost:8787/` |

Set `MONGODB_URI` for local dev:
```bash
MONGODB_URI="mongodb+srv://..." npm run dev
```

Or add it to a `.dev.vars` file (gitignored):
```
MONGODB_URI=mongodb+srv://...
```

Demo UI:
```
http://localhost:8787/
```

**Tail logs:**
```bash
npm run tail
# Streams structured JSON logs from the deployed Worker
```

---

## Manual test scenarios

Replace `your-domain.example` with your actual domain (or `localhost:8787` for local dev).

### 1. Health endpoint works
```bash
curl https://your-domain.example/
# Expected: {"status":"ok","service":"webrtc signaling edge",...}
```

### 2. WebSocket connection upgrades
```bash
# Using wscat: npm install -g wscat
wscat -c wss://your-domain.example/ws
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

### 6. Relay to connected peer succeeds
```
Open two wscat connections, register both, then from connection A:
Send: {"type":"relay","toPeerId":"<B's peerId>","fromPeerId":"<A's peerId>","relayType":"offer","payload":{"type":"offer","sdp":"test"},"messageId":"abc123","timestamp":1700000000000}
Expected on A: {"type":"relayed",...}
Expected on B: {"type":"incoming_relay","fromPeerId":"<A>","relayType":"offer",...}
(If B is on a different isolate, B must send pull_mailbox to drain the message from MongoDB)
```

### 7. Relay to unavailable peer returns structured error
```
Send: {"type":"relay","toPeerId":"ffffffffffffffffffffffffffffffff","relayType":"offer","payload":{},"messageId":"xyz","timestamp":1700000000000}
Expected: {"type":"error","code":"target_not_connected",...}
```

### 8. Reconnect and re-register works
The client library (`demo/src/utils/signalingClient.js`) implements exponential backoff reconnect automatically. Closing the WebSocket triggers a reconnect after `BACKOFF_BASE_MS` (default 1 second), increasing up to `BACKOFF_MAX_MS` (30 seconds).

### 9. Stale candidate handling
Bootstrap candidates include `advertisedAt` timestamps. The client tracks `localSeenAt` and provides `mesh.getFreshCandidates(maxAgeMs)`. Peers should probe candidates with a WebRTC offer before trusting they are live, and discard candidates that fail to respond within a reasonable timeout.

### 10. Oversized message handling
```
Send a message larger than 16 KiB.
Expected: {"type":"error","code":"message_too_large",...} followed by socket close 4007.
```

---

## Failure modes and recovery

| Failure | Behavior | Recovery |
|---------|----------|----------|
| Target peer in different isolate | Message queued in MongoDB mailbox; `target_not_connected` only if mailbox write also fails | Peer B calls `pull_mailbox` on connect; mesh routing if mailbox unavailable |
| Stale MongoDB bootstrap entry | Candidate returned but probe fails | Discard candidate; re-bootstrap |
| Worker restarted / isolate evicted | All in-memory peers lost | Client reconnects and re-registers |
| MongoDB write fails | Advisory advertisement not stored | Peer still works; just not discoverable via bootstrap until next successful write |
| Register timeout | Socket closed with code 4008 | Client reconnects and retries register |
| Rate limit exceeded | Socket closed with code 4029 | Client backs off before reconnecting |
| Network partition | WebSocket disconnects | Client reconnects with exponential backoff |
| SDP too large for relay | Message rejected (>16 KiB) | Compress or trim SDP; use trickle ICE |

---

## Known limitations

1. **Cross-isolate relay requires `pull_mailbox`.** When two peers land on different Worker isolates, the relay message is queued in MongoDB. Peer B must send `pull_mailbox` after connecting to drain it. If B never polls, the message expires. For time-sensitive signaling, peers should poll on connect and periodically.

2. **Bootstrap is approximate.** MongoDB is eventually consistent from the Worker's perspective. Discovery misses and stale results are expected; the design accounts for them.

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
- Bounded-size advisory peer advertisements in MongoDB
- Signaling relay — in-memory (same isolate) or via MongoDB mailbox (cross-isolate)
- Structured error reporting so clients know when to fall back

### Tradeoffs accepted

| Tradeoff | Accepted because |
|----------|-----------------|
| Relay sometimes fails | Mesh provides fallback; Worker is not a relay guarantee |
| Bootstrap data is stale | Peers verify candidates; stale data is harmless with probing |
| No global peer list | Correctness — a global list would be misleading anyway |
| No Durable Objects | Simplicity, cost, and design correctness |
| No auth by default | Anonymous overlay; auth hook available when needed |
| MongoDB over Cloudflare KV | More flexible TTL/query semantics; no KV binding required |

