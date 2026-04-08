# demo

A **Vue 3 + Vite** site hosted on **Cloudflare Pages** to test P2P ws:// / wss:// servers across multiple decentralized technology stacks.

## What it does

Enter your server URL and a shared room/topic name, then click **Connect** on both Peer A and Peer B to run a live P2P connectivity test. Four protocols supported:

| Technology | Server role | What's tested |
|------------|-------------|---------------|
| **Raw WS** | WebSocket relay / WebRTC signaling | room-broadcast and direct P2P WebRTC channel via peer.ooo |

A **Protocol reference** panel shows the exact JSON (or protocol) your server must implement for each technology.

## Local development

```bash
npm install
npm run dev
# open http://localhost:5173
```

## Build

```bash
npm run build
# output → ./dist
```

## Deploy to Cloudflare Pages

### First-time setup

1. Install [Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/) and log in:
   ```bash
   npm install -g wrangler
   wrangler login
   ```
2. Create the Pages project:
   ```bash
   wrangler pages project create demo
   ```

### Deploy

```bash
npm run deploy
# equivalent to: npm run build && wrangler pages deploy dist
```

Or connect the repo in the Cloudflare Pages dashboard: build command `npm run build`, output directory `dist`.

