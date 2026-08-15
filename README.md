# freertc

This project provides a Cloudflare Worker signaling relay for WebRTC peers using the [Peer Signaling Protocol (PSP)](https://github.com/draeder/Peer-Signaling-Protocol-Specification) envelope shape.

## Deploy your own federated relay

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/draeder/freertc)

**This is the fastest installation path.** The button creates the Worker and D1 database in your Cloudflare account, applies every D1 migration, generates an UnSEA relay identity, installs it directly as an encrypted Worker secret, and deploys the relay to your own `<worker>.<account>.workers.dev` address. The private identity is never printed or added to the generated repository.

Immediately after deployment, the install script requests the new Worker's `/health` endpoint. The Worker derives `wss://<worker>.<account>.workers.dev/ws` from that request and registers the address with the `wss://peer.ooo/ws` federation hub. No custom domain is required. Cloudflare lets you customize the Worker and database names before deployment.

See [Cloudflare's Deploy Button documentation](https://developers.cloudflare.com/workers/platform/deploy-buttons/) for details about the account and repository flow.

## Install from npm (manual)

Local project install:

```bash
npm install freertc
```

Global install:

```bash
npm install -g freertc
```

When installed as a project dependency, FreeRTC's postinstall step materializes
the installed package's `public/`, `src/`, and `migrations/` directories in the
project root. This gives one-click Git builders a deployable layout even when
the installer repository has no Wrangler file. If any of those paths already
contain files, the complete layout is placed in `freertc-deploy/` (or the next
available numbered directory) instead of mixing with the existing application.
Existing project files are never overwritten, and global installs do not modify
the current directory. A versioned manifest tracks files created by FreeRTC. If
a different pinned FreeRTC version is later installed, those managed files are
updated in place and obsolete managed files are removed; unrelated files remain
untouched. The postinstall output reports the selected deploy root.

When you run the CLI from your project directory, `freertc` copies the required worker files into that directory on first run:

- `src/index.js`
- `src/kademlia.js`
- `src/relay-identity.js`
- `src/relay-overlay.js`
- `public/index.html`
- `public/app.js`
- `migrations/0001_initial.sql`
- `migrations/0002_kademlia_overlay.sql`
- `scripts/d1-schema.sql`
- `scripts/deploy-cloudflare.mjs`
- `wrangler.template.jsonc`
- `wrangler.workers-dev.jsonc`

## Browser client

The package also exports the browser signaling and WebRTC client used by the demo:

```js
import { createSignalingClient } from "freertc/client";

const client = createSignalingClient({
  peerId: crypto.randomUUID(),
  networkId: "my-app",
  roomId: "pairing-room",
  signalUrl: "wss://your-relay.example/ws",
  autoConnect: false,
  onDataMessage: ({ peerId, data }) => {
    console.log("data from", peerId, data);
  },
});

client.connect();
```

Use `client.initiateConnection(peerId)` to open a WebRTC data channel and
`client.sendData(data, peerId)` to send an application payload. Calling
`client.disconnect()` closes signaling and peer connections.

## What this worker does

- Accepts WebSocket client connections at `/ws`.
- Validates [PSP](https://github.com/draeder/Peer-Signaling-Protocol-Specification) message envelopes (`psp_version`, `type`, `network`, `session_id`, `from`, `message_id`, `timestamp`).
- Supports discovery, negotiation, control, and extension message types.
- Stores peer announcements in Cloudflare D1 (`psp_announcements`).
- Stores directed signaling messages in Cloudflare D1 (`psp_relay`).
- Routes across federated relays through bounded Kademlia buckets when a signed relay identity is configured.
- Keeps the simple `/api/v1/relays` registry as a compatibility fallback for relays without signing keys.
- Exposes federation peer lookup at `/api/v1/peers` and message forwarding at `/api/v1/relay`.
- Delivers queued relay messages when peers reconnect.
- Serves the browser demo from `public/`.

## Network and Room scopes

The browser UI uses two distinct scopes:

- **Network** maps to the PSP envelope `network` and announce `instance_id`.
- **Room** maps to the PSP envelope `session_id`.

Peers are discoverable and relay messages are deliverable only when both Network and Room match. The relay domain is not an isolation boundary: `peer.ooo` and `decentralize.ooo` can federate peers that deliberately use the same Network and Room.

## Kademlia relay overlay

FreeRTC uses Kademlia between federated relays—not between browser peers. Relay IDs, scope keys, and exact-peer keys are deterministic 256-bit SHA-256 values produced by UnSEA. Relay and provider records are signed with stable UnSEA P-256 identities before they are accepted or replicated.

The overlay keeps at most 20 contacts per XOR-distance bucket, performs lookups three relays at a time with a 24-query ceiling, and replicates provider records to the five closest relays. Discovery queries at most eight load-ranked providers for a Network + Room; directed signaling forwards to at most two providers for the exact destination peer. These bounds replace federation-wide fanout as the relay population grows.

Kademlia is enabled when D1 and the relay identity secret are present. Both are configured automatically:

```bash
# Deploy from a cloned repository
npm run deploy

# Deploy an npm-installed project using its production environment
npx freertc deploy

# Local Cloudflare development
npm run dev:cf
```

Production deployment applies pending remote migrations, deploys the Worker, then checks for an existing relay identity. Existing identities are preserved. On the first deployment, a new UnSEA identity is held only in process memory and streamed directly to Wrangler's bulk-secret command. Local development stores its automatically generated identity in the git-ignored `.dev.vars` file and applies local migrations before starting Wrangler.

Optional routing settings remain ordinary Wrangler variables:

```jsonc
"KADEMLIA_BOOTSTRAP_URLS": "wss://peer.ooo/ws",
"RELAY_CAPACITY": "10000"
```

Every bootstrap URL must point to a FreeRTC relay with Kademlia enabled. `GLOBAL_RELAY_URL` is also treated as a bootstrap URL for compatibility. Legacy deployments using separate `RELAY_SIGNING_PUBLIC_KEY` and `RELAY_SIGNING_PRIVATE_KEY` values continue to work during migration. `npx freertc relay:keygen` remains available only for manual identity recovery or migration.

## Runtime scope

- The checked-in Cloudflare Worker runtime is `src/index.js` with Cloudflare D1 (`DB` binding).
- The Rust/WASM worker lives in `src/lib.rs` and is optional; the default template now uses the JS worker path.
- The built-in browser demo served by the Worker is `public/index.html` + `public/app.js`.
- `demo/src/*` is a legacy/experimental code path and is not used by `wrangler dev` or `wrangler deploy` in the current setup.

## Supported message types

- Discovery: `announce`, `withdraw`, `discover`, `peer_list`, `redirect`
- Negotiation: `connect_request`, `connect_accept`, `connect_reject`, `offer`, `answer`, `ice_candidate`, `ice_end`, `renegotiate`
- Control: `ping`, `pong`, `bye`, `error`, `ack`
- Extension: `ext`

## Wrangler install wizard (recommended)

Use the interactive wizard from the project directory where you want the worker files and Wrangler config to live:

```bash
npx freertc wizard
```

The default command runs full setup mode (`both`):

```bash
npx freertc
```

You can also preselect full setup mode explicitly:

```bash
npx freertc setup
```

Global install flow:

```bash
freertc wizard
freertc
```

After install, freertc prints a quick-start reminder with the exact next command.

The wizard can:

- Copy the worker runtime files into your current project when they are missing.
- Verify Wrangler CLI.
- Create `wrangler.jsonc` from `wrangler.template.jsonc` if needed.
- No domain? No problem. Press Enter at the domain prompt to deploy on a free `workers.dev` subdomain.
- Set Worker name automatically to `freertc-<your-domain>` when a domain is provided.
- Initialize local D1 schema for `wrangler dev`.
- Initialize remote D1 schema for deploy.
- Detect Rust build configs and install `worker-build`/WASM target automatically when required.
- Check existing Wrangler auth and only run `wrangler login` when needed.
- Optionally run `npm run dev:cf` and `npm run deploy`.

## Manual setup

### 1. Install dependencies

```bash
npm install
```

If you installed the npm package instead of cloning the repo, use `npx freertc wizard` instead of the repository scripts below.

### 2. Configure Wrangler

- If needed, copy `wrangler.template.jsonc` to `wrangler.jsonc`.
- Set your Worker name, route(s), and D1 database values.
- Ensure `d1_databases[0].binding` is `DB`.

### 3. Initialize D1 schema

Normal deploy and `dev:cf` commands perform this step automatically. The following commands are available for manual database maintenance.

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

`npm run dev` now runs the non-Cloudflare local runtime (plain Node.js + WebSocket).

Cloudflare/Wrangler runtime:

```bash
npm run dev:cf
```

Shortcut alias (same behavior):

```bash
npm run dev:local
```

You can also choose host/port:

```bash
HOST=127.0.0.1 PORT=8788 npm run dev:node
```

`npm run dev:cf` checks local Rust Worker prerequisites automatically:

- Uses `wrangler.workers-dev.jsonc` automatically when `wrangler.jsonc` is not present.
- Only installs `worker-build` and the WebAssembly Rust target when the selected Wrangler config uses a `worker-build` command.
- The checked-in `wrangler.workers-dev.jsonc` uses generic local-development values and points to `src/index.js`, so standard demo runs do not require Rust/WASM setup.

Endpoints:

- WebSocket: `ws://127.0.0.1:8788/ws` (`npm run dev`)
- Health: `http://127.0.0.1:8788/health` (`npm run dev`)
- Demo UI: `http://127.0.0.1:8788/` (`npm run dev`)

Cloudflare/Wrangler endpoints (default):

- WebSocket: `ws://127.0.0.1:8787/ws` (`npm run dev:cf`)
- Health: `http://127.0.0.1:8787/health` (`npm run dev:cf`)
- Demo UI: `http://127.0.0.1:8787/` (`npm run dev:cf`)
- Relay registry: `http://127.0.0.1:8787/api/v1/relays` (`GET`/`POST`, when D1 is configured)

## Deploy

```bash
npx freertc deploy
```

If you installed freertc globally:

```bash
freertc deploy
```

Repository-only scripts:

- `npm run build` bundles and validates the default JavaScript Worker without deploying it.
- `npm run build:rust` builds the optional Rust/WASM worker via `worker-build --release`.
- `npm run deploy:raw` deploys without `--env production`.
- `npm run check` runs `cargo check --target wasm32-unknown-unknown` for the Rust worker path.
- `npm run dev` runs the standalone local relay (non-Cloudflare).
- `npm run dev:cf` runs Wrangler/Cloudflare local dev.
- `npm run dev:node` runs a standalone local relay without Cloudflare/Wrangler.
- `npm run dev:local` is a no-env shortcut for the standalone local relay.

## Troubleshooting custom domain deploys

If your custom domain returns:

```json
{"error":"API key is missing"}
```

that error is usually from Cloudflare routing/auth config, not from this Worker runtime.

Quick checks:

1. Compare `https://<workers-subdomain>/health` and `https://<custom-domain>/health`.
2. Confirm your route/custom domain points to this Worker.
3. Review Cloudflare Access/API Shield/WAF rules on the custom hostname.
4. If deploying with `--env production`, verify that environment is the one bound to the route.

Expected `/health` response includes JSON like:

```json
{"ok":true,"version":"0.1.32","protocol_version":"1.0","peers":0}
```

## Auto WebRTC two-tab test

The demo defaults to Auto WebRTC and performs real offer/answer + ICE exchange over this Worker.

1. Open `http://127.0.0.1:8787/` in two tabs.
2. Set both tabs to the same **Network** and **Room**.
3. Set opposite peer IDs using random hex strings:
   - Tab A `from`: `fc2142e44ec5c76f1bd46ccbb1eb2ed48f66f64260a5299c871f37ac742fa0c9`
   - Tab B `from`: `3e45d44c4ce4f9304a53f42b978fd13d23f85df4d97a88f8eb33ec13a2f8f7b1`
4. Set each tab `to` to the other tab `from`, or leave `to` empty for auto-discovery.
5. Connect both sockets and click Start Auto Handshake in both tabs.
6. When DataChannel is open, send chat messages.

## Minimal client expectations

- Send `announce` first to bind socket identity (`from`, `network`, `session_id`).
- Set announce `body.instance_id` to the same value as `network`.
- Include the Room as `session_id` on every message.
- Include `to` for directed messages.
- Use periodic `announce` to refresh presence TTL and receive queued relay messages.
- Use `ping` for liveness (`pong`) and keepalive.

## Notes

- TTL is enforced using `timestamp + ttl_ms` (default 30 seconds, max 120 seconds).
- Malformed envelopes produce [PSP](https://github.com/draeder/Peer-Signaling-Protocol-Specification) `error` responses.
