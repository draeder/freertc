# freertc Cloudflare Worker (WebSocket + MongoDB)

This project provides a Cloudflare Worker signaling relay for WebRTC peers using the
Peer Signaling Protocol (PSP) envelope shape from:

- https://github.com/draeder/Peer-Signaling-Protocol-Specification

## What this worker does

- Accepts WebSocket client connections.
- Validates PSP message envelopes (`psp_version`, `type`, `network`, `from`, `message_id`, `timestamp`, `body`).
- Supports discovery + signaling/control message types.
- Stores peer announcements in MongoDB (`psp_announcements` by default).
- Stores directed signaling messages in MongoDB (`psp_relay` by default).
- Delivers queued signaling messages when a target peer is connected or sends messages/pings.
- Includes a Vue 3 browser demo in `public/` for manual signaling tests.

## Supported message types

- Discovery: `announce`, `withdraw`, `discover`, `peer_list`, `redirect`
- Negotiation: `connect_request`, `connect_accept`, `connect_reject`, `offer`, `answer`, `ice_candidate`, `ice_end`, `renegotiate`
- Control: `ping`, `pong`, `bye`, `error`, `ack`
- Extension: `ext`

## MongoDB setup (Native Driver via Cloudflare Workers)

This project uses the native MongoDB Node.js driver with native MongoDB connection strings (mongodb+srv://).
This project now requires MongoDB for signaling persistence and will reject WebSocket connections if the connection string is not configured.

1. Create a MongoDB Atlas cluster with a database user and get the connection string.
2. The connection string format is: `mongodb+srv://username:password@cluster.mongodb.net/?appName=yourappon`
3. Note your connection string securely.

Set Worker secret (required):

```bash
# local dev/default environment
wrangler secret put MONGODB_CONNECTION_STRING
# Paste the full mongodb+srv://... connection string when prompted

# production environment
wrangler secret put MONGODB_CONNECTION_STRING --env production
# Paste the full connection string when prompted
```

Optional vars in `wrangler.jsonc`:

- `MONGODB_DATABASE` (default: `signal`)
- `MONGODB_ANNOUNCEMENTS_COLLECTION` (default: `psp_announcements`)
- `MONGODB_RELAY_COLLECTION` (default: `psp_relay`)
- `RELAY_PEER_ID` (default: `bootstrap-relay`)

## Local development

```bash
npm install
npm run dev
```

Then connect your WebSocket client to:

- `ws://127.0.0.1:8787/ws`

Open browser demo:

- `http://127.0.0.1:8787/`
- The page defaults to the Auto WebRTC workflow, with the raw PSP console available as a secondary debug view.

### Auto WebRTC two-tab test

The demo defaults to **Auto WebRTC**, which performs real offer/answer + ICE exchange over this Worker.

- It auto-runs `announce` + `discover` loop.
- It auto-selects a peer from `peer_list` if `to` is empty.
- It auto-uses `connect_request` / `connect_accept` before offer/answer.
- `session_id` and `instance_id` are shared across tabs via localStorage by default.

1. Open `http://127.0.0.1:8787/` in two browser tabs.
2. Set both tabs to the same `network` and `session_id`.
3. Set opposite peer IDs using random hex strings:
   - Tab A `from`: `fc2142e44ec5c76f1bd46ccbb1eb2ed48f66f64260a5299c871f37ac742fa0c9`
   - Tab B `from`: `3e45d44c4ce4f9304a53f42b978fd13d23f85df4d97a88f8eb33ec13a2f8f7b1`
   - Set each tab's `to` value to the other tab's `from` value, or leave `to` empty and let auto-discovery select it.
4. Connect sockets in both tabs, then click **Start Auto Handshake** in both tabs.
5. The lower lexical peer ID becomes initiator (offerer) to avoid glare.
6. When DataChannel is `open`, send chat messages between tabs.

## Deploy

```bash
npm run deploy
```

## Minimal client expectations

- Send an `announce` first to bind socket identity (`from`, `network`, optional `instance_id`).
- Include `session_id` for negotiation messages.
- Include `to` for directed messages.
- Use `ping` periodically to maintain liveness and pull queued relay messages.

## Notes

- TTL is enforced using `timestamp + ttl_ms` (default 30s).
- The relay returns PSP `ack` for accepted directed signaling messages.
- Wrong-network and malformed envelopes produce PSP `error` responses.

