# FreeRTC Local Production Quick Start

> **IMPORTANT:** Domain configuration is REQUIRED for production deployment.

## 30-Second Setup

### 1. Copy Configuration Template
```bash
cp .env.local.prod.example .env.local.prod
```

### 2. Edit Configuration
```bash
# Edit with your text editor and set PROD_DOMAIN
nano .env.local.prod
```

Set `PROD_DOMAIN` to one of:
- `localhost:8443` - Local machine only
- `192.168.1.100:8443` - Network IP address
- `example.local:8443` - Custom domain (requires /etc/hosts entry)

### 3. Generate Self-Signed Certificate
```bash
mkdir -p certs
openssl req -x509 -newkey rsa:4096 \
  -keyout certs/server.key \
  -out certs/server.crt \
  -days 365 -nodes \
  -subj "/CN=localhost"
```

### 4. Start Server
```bash
npm run dev:prod
```

### 5. Verify It's Working
```bash
# In another terminal
curl -k https://localhost:8443/health
```

## That's It! 🎉

Your relay is now available at:
- **WebSocket**: `wss://localhost:8443/ws`
- **HTTP**: `https://localhost:8443`
- **Health**: `https://localhost:8443/health`

## For Network Access

If you need to connect from other machines:

### Update Hosts File
```bash
# On macOS/Linux
sudo nano /etc/hosts
# Add: 192.168.1.100 example.local

# On Windows
# Edit: C:\Windows\System32\drivers\etc\hosts
# Add: 192.168.1.100 example.local
```

### Update Configuration
```env
PROD_DOMAIN=example.local:8443
HOST=0.0.0.0
```

### Regenerate Certificate
```bash
openssl req -x509 -newkey rsa:4096 \
  -keyout certs/server.key \
  -out certs/server.crt \
  -days 365 -nodes \
  -subj "/CN=example.local"
```

### Restart Server
```bash
npm run dev:prod
```

## Troubleshooting

**Configuration error?**
```bash
npm run config:validate
```

**Port already in use?**
- Change `PORT` in `.env.local.prod`
- Or kill existing process: `lsof -i :8443 | grep LISTEN | awk '{print $2}' | xargs kill -9`

**Certificate errors?**
```bash
rm -rf certs/
mkdir -p certs
openssl req -x509 -newkey rsa:4096 -keyout certs/server.key -out certs/server.crt -days 365 -nodes -subj "/CN=localhost"
```

**Still having issues?**
- See [DEPLOYMENT.md](./DEPLOYMENT.md) for detailed troubleshooting
- Check logs: `npm run dev:prod` shows output directly
- View Docker logs: `docker-compose -f docker-compose.prod.yml logs -f`

## Docker Deployment

For containerized deployment:

```bash
npm run deploy:local-prod
```

View logs:
```bash
npm run deploy:local-prod:logs
```

Stop:
```bash
npm run deploy:local-prod:stop
```

## Next Steps

- Read [DEPLOYMENT.md](./DEPLOYMENT.md) for detailed configuration options
- Set up firewall rules if accessing from external networks
- Configure monitoring/alerting for production
- Consider reverse proxy (nginx, Caddy) for advanced setups
