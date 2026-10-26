# FreeRTC Production Deployment Guide

## Local Production Deployment

This document guides you through setting up a production-ready local deployment of FreeRTC.

### Prerequisites

- **Domain name** (required for production)
  - For local development: `localhost`, `127.0.0.1`, or `example.local`
  - For network access: IP address (e.g., `192.168.1.100`) or custom domain
  - For public access: valid domain with DNS

- **TLS Certificate**
  - Self-signed for local/testing
  - Valid certificate for public deployment

- **Node.js 20+** (for non-Docker deployment)
- **Docker** (optional, for containerized deployment)

### Quick Start

#### 1. Create Configuration

```bash
# Copy example configuration
cp .env.local.prod.example .env.local.prod

# Edit configuration with your domain
nano .env.local.prod
```

Edit `.env.local.prod`:
```env
PROD_DOMAIN=localhost:8443      # Your domain or IP
HOST=0.0.0.0                     # 0.0.0.0 for network access, 127.0.0.1 for localhost only
PORT=8443
RELAY_NAME=My Production Relay
```

#### 2. Generate TLS Certificates

```bash
# Create certs directory
mkdir -p certs

# Generate self-signed certificate
openssl req -x509 -newkey rsa:4096 \
  -keyout certs/server.key \
  -out certs/server.crt \
  -days 365 -nodes \
  -subj "/CN=localhost"
```

#### 3. Validate Configuration

```bash
npm run config:validate
```

#### 4. Generate Production Config

```bash
npm run config:gen
```

#### 5. Start Server

**Option A: Node.js (Direct)**
```bash
npm run dev:prod
```

**Option B: Docker**
```bash
docker-compose -f docker-compose.prod.yml up -d
```

### Verification

```bash
# Check health
curl -k https://localhost:8443/health

# Get relay configuration
curl -k https://localhost:8443/config

# Access web interface
open https://localhost:8443
```

### Network Access (Non-localhost)

To access from other machines:

#### 1. Update `/etc/hosts` (or `C:\Windows\System32\drivers\etc\hosts` on Windows)

```
192.168.1.100  example.local
```

#### 2. Generate Certificate for Custom Domain

```bash
openssl req -x509 -newkey rsa:4096 \
  -keyout certs/server.key \
  -out certs/server.crt \
  -days 365 -nodes \
  -subj "/CN=example.local" \
  -addext "subjectAltName=DNS:example.local,DNS:192.168.1.100"
```

#### 3. Set Environment

```env
PROD_DOMAIN=example.local:8443
HOST=0.0.0.0
```

#### 4. Start Server

```bash
npm run dev:prod
```

#### 5. Connect from Other Machine

```bash
# Test from another machine
curl -k https://example.local:8443/health

# Use relay URL in WebRTC client
# wss://example.local:8443/ws
```

### Docker Deployment

#### Build and Run

```bash
# Build image
docker build -f Dockerfile.prod -t freertc-prod:latest .

# Run container
docker run -d \
  --name freertc-prod \
  -p 8443:8443 \
  -e PROD_DOMAIN=localhost:8443 \
  -v $(pwd)/certs:/app/certs:ro \
  -v freertc-data:/data \
  freertc-prod:latest
```

#### Using Docker Compose

```bash
# Start
docker-compose -f docker-compose.prod.yml up -d

# Stop
docker-compose -f docker-compose.prod.yml down

# View logs
docker-compose -f docker-compose.prod.yml logs -f

# Check status
docker-compose -f docker-compose.prod.yml ps
```

### NPM Scripts Reference

```bash
# Validate production configuration
npm run config:validate

# Generate production config from .env.local.prod
npm run config:gen

# Start production server (Node.js)
npm run dev:prod

# Deploy to Cloudflare (from package.json "deploy" script)
npm run deploy
```

### Environment Variables

See `.env.local.prod.example` for all available options:

| Variable | Required | Description |
|----------|----------|-------------|
| `PROD_DOMAIN` | ✓ | Domain name (localhost, IP, or custom) |
| `HOST` | | Server bind address (default: 0.0.0.0) |
| `PORT` | | HTTPS port (default: 8443) |
| `RELAY_NAME` | | Relay display name |
| `RELAY_URL` | | WSS URL (auto-generated if blank) |
| `GLOBAL_RELAY_URL` | | Global relay for peer discovery |
| `TLS_CERT_PATH` | | Path to certificate |
| `TLS_KEY_PATH` | | Path to private key |
| `DB_PATH` | | Local database path |
| `LOG_LEVEL` | | Logging level (debug/info/warn/error) |

### Troubleshooting

#### Certificate Errors

```
Error: ENOENT: no such file or directory, open './certs/server.crt'
```

**Solution:** Generate certificates
```bash
mkdir -p certs
openssl req -x509 -newkey rsa:4096 -keyout certs/server.key -out certs/server.crt -days 365 -nodes -subj "/CN=localhost"
```

#### Port Already in Use

```
Error: listen EADDRINUSE: address already in use :::8443
```

**Solution:** Change port in `.env.local.prod`
```env
PORT=8444
```

Or kill existing process:
```bash
lsof -i :8443
kill -9 <PID>
```

#### Connection Refused

```
curl: (7) Failed to connect to localhost:8443
```

**Solution:**
1. Check server is running: `npm run dev:prod`
2. Check firewall allows port 8443
3. Verify TLS certificates exist: `ls certs/`

#### CORS Issues

Enable CORS in the server. The relay is `scripts/node-relay.mjs`, which serves the same responses (and CORS headers) as the worker.

### Security Considerations

⚠️ **For Local/Testing Only**

1. **Self-Signed Certificates**: Browser will show security warnings
2. **Accept Risk**: Clients must accept self-signed certificates
3. **Network Security**: Only deploy on trusted networks
4. **Firewall**: Restrict port access appropriately

### Cloudflare Deployment (Alternative)

For production with custom domain:

```bash
npm run deploy
```

Requires:
- Cloudflare account
- `wrangler.jsonc` configuration
- Domain on Cloudflare nameservers

See [wrangler documentation](https://developers.cloudflare.com/workers/) for details.

### Production Checklist

- [ ] `PROD_DOMAIN` set to your domain
- [ ] TLS certificates generated
- [ ] Configuration validated (`npm run config:validate`)
- [ ] Config generated (`npm run config:gen`)
- [ ] Server starts without errors (`npm run dev:prod`)
- [ ] Health check passes (`curl -k https://localhost:8443/health`)
- [ ] WebSocket connection works
- [ ] Firewall rules configured
- [ ] Monitoring/logging enabled
- [ ] Backups configured (for data persistence)

## Local relay federation

Every local relay is `scripts/node-relay.mjs` (`npm run dev`, `freertc dev`, `npm run dev:prod`, Docker). It runs the same code as the Cloudflare worker, with SQLite in place of D1, and federates with other relays by default.

| Variable | Default | Meaning |
| --- | --- | --- |
| `FREERTC_FEDERATION` | `on` | `off` runs a standalone relay that joins no other relay. |
| `FREERTC_PUBLIC` | `true` | A public relay joins the public relays and never federates a loopback or private address (127.x, 10.x, 192.168.x, 172.16–31.x, 169.254.x, 100.64/10, ::1, fc00::/7, fe80::/10, `localhost`, `*.local`), whether its own or one another relay announces. `false` is a private/LAN mesh that takes local addresses. |
| `RELAY_URL` | `wss://PROD_DOMAIN/ws`, else `ws://HOST:PORT/ws` | The address other relays and peers use. A public relay with a private `RELAY_URL` is behind NAT: it takes a public address through a tunnel (below), or, with tunnels off, stays out of federation and logs why. |
| `FREERTC_TUNNEL` | `on` | A public relay behind NAT opens one outbound WebSocket to a public relay and is federated as `wss://<that relay>/t/<node id>/ws`. Federation calls and peer WebSockets sent there come down the tunnel. If the home goes away the relay moves to the next one. `off` disables this. |
| `FREERTC_TUNNEL_HOMES` | the bootstrap relays | Public relays to tunnel through, tried in order. |
| `KADEMLIA_BOOTSTRAP_URLS` | the public relays (public); none (private) | Relays to join through. |
| `FREERTC_DATA_DIR`, `DB_PATH` | `./.freertc-relay` | The SQLite database and the generated relay identity. |
| `TLS_CERT_PATH`, `TLS_KEY_PATH` | unset | Serve HTTPS/WSS. |

Node 22.5 or later is required (`node:sqlite`); before 22.13 the relay turns on `--experimental-sqlite` itself.

### Tunnels through NAT

A relay behind NAT reaches out, and everything else reaches it through its tunnel:

- **Out of NAT:** its own federation calls are ordinary outbound HTTPS, to public relays and to other NAT'd relays at their tunnel addresses.
- **Into NAT:** a public relay (the tunnel home) carries Kademlia `find`/`store`, `/api/v1/peers`, `/api/v1/relay` and peer WebSockets for `/t/<node id>/...` down the tunnel.
- **Ownership:** a home gives the address only to the relay that signs a fresh challenge with the key its node id comes from, and a signed record may only name its own tunnel.
- **Cost:** on Cloudflare the home is the `RelayTunnel` Durable Object (binding `RELAY_TUNNEL`, migration `relay-tunnel-v1`). It uses WebSocket hibernation, and keepalive pings are answered without waking it, so an idle tunnel uses no duration. Every Node relay is also a home.
