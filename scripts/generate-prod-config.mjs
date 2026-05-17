#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, validateProdConfig } from './validate-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function generateRelayUrl(domain) {
  // Remove port if present for the WSS URL construction
  const [host] = domain.split(':');
  if (domain.includes(':')) {
    // If custom port, include it in WSS URL
    return `wss://${domain}/ws`;
  }
  return `wss://${host}/ws`;
}

function generateConfig() {
  console.log('🔧 Generating local production configuration...\n');

  const env = validateProdConfig();

  // Build configuration
  const config = {
    name: 'freertc-local-prod',
    description: 'FreeRTC Local Production Relay',
    domain: env.PROD_DOMAIN,
    relayPeerId: env.RELAY_PEER_ID || 'local-prod-relay',
    relayName: env.RELAY_NAME || 'Local Production Relay',
    relayUrl: env.RELAY_URL || generateRelayUrl(env.PROD_DOMAIN),
    globalRelayUrl: env.GLOBAL_RELAY_URL || null,
    host: env.HOST || '0.0.0.0',
    port: parseInt(env.PORT || '8443', 10),
    tlsCertPath: env.TLS_CERT_PATH || './certs/server.crt',
    tlsKeyPath: env.TLS_KEY_PATH || './certs/server.key',
    dbPath: env.DB_PATH || './data/freertc.db',
    nodeEnv: env.NODE_ENV || 'production',
    logLevel: env.LOG_LEVEL || 'info'
  };

  console.log('📋 Configuration:');
  console.log(`  Domain:      ${config.domain}`);
  console.log(`  Relay URL:   ${config.relayUrl}`);
  console.log(`  Peer ID:     ${config.relayPeerId}`);
  console.log(`  Relay Name:  ${config.relayName}`);
  console.log(`  Host:        ${config.host}`);
  console.log(`  Port:        ${config.port}`);
  console.log(`  TLS Cert:    ${config.tlsCertPath}`);
  console.log(`  TLS Key:     ${config.tlsKeyPath}`);
  console.log(`  DB Path:     ${config.dbPath}`);
  console.log(`  Global Relay: ${config.globalRelayUrl || 'disabled'}\n`);

  // Write configuration file
  const configPath = path.join(ROOT, 'config.local-prod.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`✓ Configuration saved to: ${configPath}`);

  // Create directories if needed
  const certDir = path.join(ROOT, path.dirname(config.tlsCertPath));
  const dbDir = path.join(ROOT, path.dirname(config.dbPath));

  if (!fs.existsSync(certDir)) {
    fs.mkdirSync(certDir, { recursive: true });
    console.log(`✓ Created directory: ${path.dirname(config.tlsCertPath)}`);
  }

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
    console.log(`✓ Created directory: ${path.dirname(config.dbPath)}`);
  }

  // Check TLS certificates
  const certPath = path.join(ROOT, config.tlsCertPath);
  const keyPath = path.join(ROOT, config.tlsKeyPath);

  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    const domain = config.domain.split(':')[0];
    console.log(`\n⚠️  TLS certificates not found. Generate them with:`);
    console.log(`  openssl req -x509 -newkey rsa:4096 \\`);
    console.log(`    -keyout ${config.tlsKeyPath} \\`);
    console.log(`    -out ${config.tlsCertPath} \\`);
    console.log(`    -days 365 -nodes \\`);
    console.log(`    -subj "/CN=${domain}"`);
  } else {
    console.log('✓ TLS certificates found');
  }

  console.log('\n✅ Local production configuration ready!');
  console.log(`\nStart server with: npm run dev:prod`);

  return config;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  generateConfig();
}

export { generateConfig };
