# freertc Cloudflare Worker (WebSocket + D1)

This project provides a Cloudflare Worker signaling relay for WebRTC peers using the [Peer Signaling Protocol (PSP)](https://github.com/draeder/Peer-Signaling-Protocol-Specification) envelope shape.

## What this worker does

- Accepts WebSocket client connections at `/ws`.
- Validates [PSP](https://github.com/draeder/Peer-Signaling-Protocol-Specification) message envelopes (`psp_version`, `type`, `network`, `from`, `message_id`, `timestamp`).
- Supports discovery, negotiation, control, and extension message types.
- Stores peer announcements in Cloudflare D1 (`psp_announcements`).
- Stores directed signaling messages in Cloudflare D1 (`psp_relay`).
- Delivers queued relay messages when peers reconnect.
- Serves the browser demo from `public/`.

## Runtime scope

- Production Worker runtime is `src/index.js` with Cloudflare D1 (`DB` binding).
- The built-in browser demo served by the Worker is `public/index.html` + `public/app.js`.
- `src/kv.js` and `demo/src/*` are legacy/experimental code paths and are not used by `wrangler dev` or `wrangler deploy` in the current setup.

## Supported message types

- Discovery: `announce`, `withdraw`, `discover`, `peer_list`, `redirect`
- Negotiation: `connect_request`, `connect_accept`, `connect_reject`, `offer`, `answer`, `ice_candidate`, `ice_end`, `renegotiate`
- Control: `ping`, `pong`, `bye`, `error`, `ack`
- Extension: `ext`

## Wrangler install wizard (recommended)

Use the interactive wizard to set up Wrangler for local development, deploy, or both:

```bash
npm run wizard
```

The wizard can:

- Install npm dependencies.
- Verify Wrangler CLI.
- Create `wrangler.jsonc` from `wrangler.template.jsonc` if needed.
- Initialize local D1 schema for `wrangler dev`.
- Initialize remote D1 schema for deploy.
- Check existing Wrangler auth and only run `wrangler login` when needed.
- Optionally run `npm run dev` and `npm run deploy`.

## Manual setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure Wrangler

- If needed, copy `wrangler.template.jsonc` to `wrangler.jsonc`.
- Set your Worker name, route(s), and D1 database values.
- Ensure `d1_databases[0].binding` is `DB`.

### 3. Initialize D1 schema

Local (for `wrangler dev`):

```bash
npm run d1:init:local
```

Remote (for production):

```bash
npm run d1:init:remote
```

If your database name is not `freertc-signal`, use Wrangler directly:

```bash
wrangler d1 execute <your-db-name> --local --file scripts/d1-schema.sql
wrangler d1 execute <your-db-name> --remote --file scripts/d1-schema.sql
```

## Local development

```bash
npm run dev
```

Endpoints:

- WebSocket: `ws://127.0.0.1:8787/ws`
- Health: `http://127.0.0.1:8787/health`
- Demo UI: `http://127.0.0.1:8787/`

## Deploy

```bash
npm run deploy
```

Additional scripts:

- `npm run deploy:raw` deploys without `--env production`.
- `npm run check` runs syntax validation (`node --check src/index.js`).

## Auto WebRTC two-tab test

The demo defaults to Auto WebRTC and performs real offer/answer + ICE exchange over this Worker.

1. Open `http://127.0.0.1:8787/` in two tabs.
2. Set both tabs to the same `network` and `session_id`.
3. Set opposite peer IDs using random hex strings:
   - Tab A `from`: `fc2142e44ec5c76f1bd46ccbb1eb2ed48f66f64260a5299c871f37ac742fa0c9`
   - Tab B `from`: `3e45d44c4ce4f9304a53f42b978fd13d23f85df4d97a88f8eb33ec13a2f8f7b1`
4. Set each tab `to` to the other tab `from`, or leave `to` empty for auto-discovery.
5. Connect both sockets and click Start Auto Handshake in both tabs.
6. When DataChannel is open, send chat messages.

## Minimal client expectations

- Send `announce` first to bind socket identity (`from`, `network`).
- Include `session_id` for negotiation messages.
- Include `to` for directed messages.
- Use periodic `announce` to refresh presence TTL and receive queued relay messages.
- Use `ping` for liveness (`pong`) and keepalive.

## Notes

- TTL is enforced using `timestamp + ttl_ms` (default 30 seconds, max 120 seconds).
- Malformed envelopes produce [PSP](https://github.com/draeder/Peer-Signaling-Protocol-Specification) `error` responses.

