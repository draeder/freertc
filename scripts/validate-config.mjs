#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadEnv(envFile) {
  if (!fs.existsSync(envFile)) {
    return {};
  }

  const content = fs.readFileSync(envFile, 'utf-8');
  const env = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const [key, ...valueParts] = trimmed.split('=');
    if (key && valueParts.length > 0) {
      env[key.trim()] = valueParts.join('=').trim();
    }
  }

  return env;
}

function validateProdConfig() {
  const envFile = path.join(ROOT, '.env.local.prod');

  if (!fs.existsSync(envFile)) {
    console.error('❌ ERROR: .env.local.prod not found');
    console.error('\nTo create a production-ready local deployment:');
    console.error(`  cp .env.local.prod.example .env.local.prod`);
    console.error(`  # Edit .env.local.prod and set PROD_DOMAIN to your domain/IP`);
    process.exit(1);
  }

  const env = loadEnv(envFile);

  // Validate PROD_DOMAIN is set
  if (!env.PROD_DOMAIN || !env.PROD_DOMAIN.trim()) {
    console.error('❌ ERROR: PROD_DOMAIN not set in .env.local.prod');
    console.error('\nREQUIRED for production deployment:');
    console.error('  PROD_DOMAIN=localhost:8443');
    console.error('  PROD_DOMAIN=192.168.1.100:8443');
    console.error('  PROD_DOMAIN=example.local:8443');
    process.exit(1);
  }

  // Validate TLS certificates exist for non-localhost
  const domain = env.PROD_DOMAIN.split(':')[0].toLowerCase();
  if (domain !== 'localhost' && domain !== '127.0.0.1') {
    const certPath = env.TLS_CERT_PATH || './certs/server.crt';
    const keyPath = env.TLS_KEY_PATH || './certs/server.key';
    const certFull = path.join(ROOT, certPath);
    const keyFull = path.join(ROOT, keyPath);

    if (!fs.existsSync(certFull) || !fs.existsSync(keyFull)) {
      console.error('❌ ERROR: TLS certificates not found for domain:', domain);
      console.error('\nGenerate self-signed certificates:');
      console.error(`  mkdir -p certs`);
      console.error(
        `  openssl req -x509 -newkey rsa:4096 -keyout certs/server.key -out certs/server.crt \\`
      );
      console.error(`    -days 365 -nodes -subj "/CN=${domain}"`);
      process.exit(1);
    }
  }

  console.log('✓ Configuration valid');
  console.log(`  Domain: ${env.PROD_DOMAIN}`);
  console.log(`  Relay: ${env.RELAY_NAME || 'Local Production Relay'}`);

  return env;
}

export { loadEnv, validateProdConfig };

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  validateProdConfig();
}
