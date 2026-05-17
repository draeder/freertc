# Production Deployment Architecture

## Overview

FreeRTC now supports production-ready local deployment with mandatory domain configuration for security and WebRTC compatibility.

```
┌─────────────────────────────────────────────────────────────┐
│              FreeRTC Deployment Options                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │   Local Dev  │  │ Local Prod   │  │ Cloudflare      │  │
│  │  (Node.js)   │  │ (Docker)     │  │ Production      │  │
│  │              │  │              │  │                 │  │
│  │ localhost:8  │  │ localhost:84 │  │ yourdomain.com  │  │
│  │      788     │  │      43      │  │                 │  │
│  │   ws://      │  │   wss://     │  │     wss://      │  │
│  │   (HTTP)     │  │   (HTTPS)    │  │   (HTTPS)       │  │
│  └──────────────┘  └──────────────┘  └─────────────────┘  │
│                                                              │
│  npm run dev:local  npm run dev:prod   npm run deploy      │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Configuration System

### Mandatory Domain Configuration

Production deployment **requires** domain configuration through environment variables:

```
✓ Must be set: PROD_DOMAIN
✓ Examples:
  - localhost:8443
  - 192.168.1.100:8443
  - example.local:8443
  - prod.example.com:8443
```

### Configuration Files

| File | Purpose | Required | Version Control |
|------|---------|----------|-----------------|
| `.env.example` | All available options | Reference | ✓ Tracked |
| `.env.local.prod.example` | Production template | Reference | ✓ Tracked |
| `.env.local.prod` | Your actual config | ✓ Yes | ✗ Ignored |
| `config.local-prod.json` | Generated config | Auto-generated | ✗ Ignored |
| `certs/` | TLS certificates | ✓ For HTTPS | ✗ Ignored |

### Configuration Flow

```
.env.local.prod
    ↓
scripts/validate-config.mjs (config:validate)
    ↓ [Validates PROD_DOMAIN exists]
    ↓
scripts/generate-prod-config.mjs (config:gen)
    ↓ [Creates config.local-prod.json]
    ↓ [Creates directories]
    ↓ [Validates TLS certs exist]
    ↓
scripts/prod-server.mjs (dev:prod)
    ↓ [Starts HTTPS server]
    ↓
Server listening on wss://PROD_DOMAIN/ws
```

## Deployment Modes

### Mode 1: Local Development (npm run dev:local)

- **Protocol**: WS (unencrypted)
- **Server**: Node.js HTTP server
- **Domain**: Not applicable (localhost only)
- **Use Case**: Development and testing
- **Port**: 8788

```bash
npm run dev:local
# ws://localhost:8788/ws
```

### Mode 2: Local Production (npm run dev:prod)

- **Protocol**: WSS (encrypted)
- **Server**: Node.js HTTPS server
- **Domain**: Required (localhost, IP, or domain)
- **Use Case**: Staging, testing with HTTPS
- **Port**: 8443 (default)
- **Configuration**: `.env.local.prod` required

```bash
npm run dev:prod
# wss://localhost:8443/ws
# OR
# wss://example.local:8443/ws
```

### Mode 3: Docker Production (npm run deploy:local-prod)

- **Protocol**: WSS (encrypted)
- **Server**: Containerized Node.js HTTPS
- **Domain**: Required (localhost, IP, or domain)
- **Use Case**: Production-like environment
- **Port**: 8443 (configurable)
- **Configuration**: `.env.local.prod` required

```bash
npm run deploy:local-prod
# Starts Docker container with production config
```

### Mode 4: Cloudflare Workers (npm run deploy)

- **Protocol**: WSS (encrypted)
- **Server**: Cloudflare Workers + D1 DB
- **Domain**: Custom domain on Cloudflare
- **Use Case**: Production global deployment
- **Configuration**: `wrangler.jsonc`

```bash
npm run deploy
# Deploys to Cloudflare Workers
```

## Domain Requirements

### Why Domain is Required for Production

1. **WebRTC Requirement**: WebRTC demands secure WebSocket (WSS) over HTTPS
2. **Certificate Validation**: Browsers require valid certificates
3. **Network Identification**: Domain identifies your relay in the peer network
4. **Security**: HTTPS enforces encrypted connections

### Valid Domain Options

| Type | Example | Use Case | Setup |
|------|---------|----------|-------|
| Localhost | `localhost:8443` | Local testing | No setup |
| IP Address | `192.168.1.100:8443` | Network testing | Self-signed cert |
| Custom Domain | `example.local:8443` | Team testing | Edit `/etc/hosts` |
| Public Domain | `prod.example.com:8443` | Production | Valid certificate |

### TLS Certificate Requirements

**For localhost/IP:**
- Self-signed certificate (auto-generated or manual)
- Browser shows security warning (expected for self-signed)
- Clients must accept self-signed certs

**For public domain:**
- Valid certificate from Certificate Authority (Let's Encrypt, etc.)
- Browser recognizes certificate automatically
- No warnings, production-ready

## Configuration Validation

### Pre-Deployment Checks

```bash
# Validate configuration is correct
npm run config:validate

# Checks:
# ✓ .env.local.prod exists
# ✓ PROD_DOMAIN is set
# ✓ TLS certificates exist (for non-localhost)
# ✓ Directories are writable
```

### Configuration Generation

```bash
# Generate production config from environment
npm run config:gen

# Creates:
# ✓ config.local-prod.json
# ✓ certs/ directory
# ✓ data/ directory
# ✓ Validates all requirements
```

## Environment Variables Reference

```env
# REQUIRED for production
PROD_DOMAIN=localhost:8443

# Server binding
HOST=0.0.0.0              # 0.0.0.0 = all interfaces, 127.0.0.1 = localhost only
PORT=8443

# Relay identification
RELAY_PEER_ID=local-prod-relay
RELAY_NAME=Local Production Relay

# WebSocket URL (auto-constructed if empty)
RELAY_URL=wss://localhost:8443/ws

# Network discovery (optional)
GLOBAL_RELAY_URL=wss://peer.ooo/ws

# TLS Configuration
TLS_CERT_PATH=./certs/server.crt
TLS_KEY_PATH=./certs/server.key

# Database
DB_PATH=./data/freertc.db

# Runtime
NODE_ENV=production
LOG_LEVEL=info
```

## Security Considerations

### Local Development (🟢 Safe for Local Testing)
- No HTTPS required
- Unencrypted WebSocket
- Localhost only
- No configuration needed

### Local Production (🟡 Review Before Deployment)
- Self-signed HTTPS
- Encrypted WebSocket
- Accept risk: browser warning for self-signed certs
- Network accessible if HOST=0.0.0.0
- **Only deploy on trusted networks**

### Public Production (🔴 Requires Valid Certificate)
- Valid HTTPS certificate required
- Cloudflare recommended for easiest setup
- Or: deploy behind reverse proxy with valid cert
- Domain must be registered and DNS configured

## Monitoring and Health Checks

### Health Endpoint
```bash
curl -k https://localhost:8443/health
# Returns: {"status":"ok","relay":"Local Production Relay"}
```

### Configuration Endpoint
```bash
curl -k https://localhost:8443/config
# Returns relay configuration
```

### Docker Health Check
```bash
# Automatic health checks included
docker-compose -f docker-compose.prod.yml ps

# STATUS shows: healthy, unhealthy, or starting
```

## Troubleshooting

### Domain Configuration Issues

**Error: "PROD_DOMAIN not set in .env.local.prod"**
```bash
# Solution: Set required domain
echo "PROD_DOMAIN=localhost:8443" >> .env.local.prod
npm run config:validate
```

**Error: "TLS certificates not found"**
```bash
# Solution: Generate certificates
openssl req -x509 -newkey rsa:4096 \
  -keyout certs/server.key \
  -out certs/server.crt \
  -days 365 -nodes \
  -subj "/CN=localhost"
```

### Connection Issues

**"Connection refused" on localhost:8443**
- Ensure server is running: `npm run dev:prod`
- Check if port is available: `lsof -i :8443`
- Change port in `.env.local.prod` if needed

**"Certificate verification failed" from remote machine**
- Expected for self-signed certificates
- Client must add certificate to trusted store or disable verification
- Or: use valid certificate from CA

## Best Practices

1. **Always set PROD_DOMAIN** - Fails fast if not configured
2. **Use TLS certificates** - Even self-signed for local prod
3. **Validate before deploy** - Run `npm run config:validate` first
4. **Monitor logs** - Check production server output
5. **Back up data** - Persist database outside container
6. **Firewall rules** - Restrict access appropriately
7. **Network isolation** - Use on trusted networks only

## Migration Path

### From Dev to Production

```
1. Local Dev (localhost:8788)
   ↓ Works? Proceed to production setup
   
2. Copy .env.local.prod.example → .env.local.prod
   ↓
   
3. Set PROD_DOMAIN=your-domain:8443
   ↓
   
4. Generate TLS certificates
   ↓
   
5. npm run config:validate
   ↓ Valid? Proceed to deployment
   
6a. npm run dev:prod (Node.js)
    OR
6b. npm run deploy:local-prod (Docker)
    OR
6c. npm run deploy (Cloudflare)
```

## Files Added/Modified

### New Files
- `scripts/validate-config.mjs` - Config validation
- `scripts/generate-prod-config.mjs` - Config generation  
- `scripts/prod-server.mjs` - Production HTTPS server
- `.env.example` - All config options
- `.env.local.prod.example` - Production template
- `Dockerfile.prod` - Docker production image
- `docker-compose.prod.yml` - Docker Compose setup
- `DEPLOYMENT.md` - Full deployment guide
- `QUICKSTART-PROD.md` - Quick start guide

### Modified Files
- `package.json` - Added npm scripts
- `.gitignore` - Ignore production files
