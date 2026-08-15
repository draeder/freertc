#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { generateRandomPair } from 'unsea';
import { encodeRelayIdentitySecret } from '../src/relay-identity.js';
import { resolveProjectRoot, resolveWranglerCommand } from './project-bootstrap.mjs';

const ROOT = resolveProjectRoot(process.cwd());
const RELAY_IDENTITY_SECRET = 'RELAY_IDENTITY_SECRET';
const LEGACY_RELAY_IDENTITY_SECRET = 'RELAY_SIGNING_PRIVATE_KEY';

export function firstWorkersDevUrlFromText(text) {
  if (!text) return null;
  const match = text.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i);
  return match ? match[0] : null;
}

export function relayUrlFromWorkersDevUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.workers.dev')) return null;
    return `wss://${parsed.host}/ws`;
  } catch {
    return null;
  }
}

export function scopedWranglerArgs(args, { includeName = false } = {}) {
  const valueFlags = new Set([
    '--config', '-c', '--cwd', '--env', '-e', '--env-file', '--profile',
    ...(includeName ? ['--name'] : []),
  ]);
  const longFlags = [...valueFlags].filter((flag) => flag.startsWith('--'));
  const scoped = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (valueFlags.has(arg) && index + 1 < args.length) {
      scoped.push(arg, args[index + 1]);
      index += 1;
      continue;
    }
    if (longFlags.some((flag) => arg.startsWith(`${flag}=`))) scoped.push(arg);
  }
  return scoped;
}

export function relaySecretNames(text) {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((secret) => secret?.name).filter((name) => typeof name === 'string');
  } catch {
    return [];
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestHealth(deploymentUrl) {
  const healthUrl = new URL('/health', deploymentUrl).toString();
  let lastError = null;

  for (const delayMs of [0, 1000, 2000, 4000, 8000]) {
    if (delayMs) await wait(delayMs);
    try {
      const response = await fetch(healthUrl, {
        headers: { 'User-Agent': 'freertc-deploy-registration/1.0' }
      });
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}`);
        continue;
      }
      const health = await response.json();
      return { healthUrl, health };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Health request failed');
}

function printResult(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function runWrangler(wrangler, args, options = {}) {
  return spawnSync(wrangler.command, [...wrangler.baseArgs, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
    stdio: 'pipe',
    ...options,
  });
}

function failed(result, label) {
  if (result.error) console.error(`[freertc] Could not start ${label}: ${result.error.message}`);
  if (result.status === 0) return false;
  process.exitCode = result.status || 1;
  return true;
}

async function ensureRelayIdentitySecret(wrangler, deployArgs) {
  const secretArgs = scopedWranglerArgs(deployArgs, { includeName: true });
  const listed = runWrangler(wrangler, ['secret', 'list', '--format', 'json', ...secretArgs]);
  if (failed(listed, 'Wrangler secret listing')) {
    printResult(listed);
    return false;
  }

  const names = relaySecretNames(listed.stdout || '');
  if (names.includes(RELAY_IDENTITY_SECRET) || names.includes(LEGACY_RELAY_IDENTITY_SECRET)) {
    console.log('[freertc] Existing relay identity secret preserved.');
    return true;
  }

  const pair = await generateRandomPair();
  const secretInput = JSON.stringify({
    [RELAY_IDENTITY_SECRET]: encodeRelayIdentitySecret(pair.pub, pair.priv),
  });
  const uploaded = runWrangler(
    wrangler,
    ['secret', 'bulk', ...secretArgs],
    { input: secretInput },
  );
  printResult(uploaded);
  if (failed(uploaded, 'Wrangler secret upload')) return false;

  console.log('[freertc] Generated and installed a private relay identity secret.');
  return true;
}

export async function main(args = process.argv.slice(2)) {
  const wrangler = resolveWranglerCommand(ROOT);
  const skipHealthCheck = args.includes('--skip-health-check');
  const deployArgs = args.filter((arg) => arg !== '--' && arg !== '--skip-health-check');
  const dryRun = deployArgs.includes('--dry-run');

  if (!dryRun) {
    console.log('[freertc] Applying remote D1 migrations...');
    const migrationArgs = scopedWranglerArgs(deployArgs);
    const migration = runWrangler(wrangler, [
      'd1', 'migrations', 'apply', 'DB', '--remote', ...migrationArgs,
    ]);
    printResult(migration);
    if (failed(migration, 'Wrangler D1 migration')) return;
  }

  const deploy = runWrangler(wrangler, ['deploy', ...deployArgs]);
  printResult(deploy);
  if (failed(deploy, 'Wrangler deployment')) return;

  if (dryRun) return;
  if (!await ensureRelayIdentitySecret(wrangler, deployArgs)) return;
  if (skipHealthCheck) return;

  const deploymentUrl = firstWorkersDevUrlFromText(`${deploy.stdout || ''}\n${deploy.stderr || ''}`);
  const expectedRelayUrl = relayUrlFromWorkersDevUrl(deploymentUrl);
  if (!deploymentUrl || !expectedRelayUrl) {
    console.warn('[freertc] Deployment and private relay identity setup succeeded, but no workers.dev URL was found.');
    return;
  }

  try {
    const { healthUrl, health } = await requestHealth(deploymentUrl);
    if (health?.relay_url !== expectedRelayUrl) {
      throw new Error(`expected relay_url ${expectedRelayUrl}, received ${health?.relay_url || '(missing)'}`);
    }
    if (health?.kademlia_enabled !== true) {
      throw new Error('the deployed Worker did not report Kademlia as enabled');
    }
    console.log(`[freertc] Kademlia relay initialized through ${healthUrl}`);
    console.log(`[freertc] Relay URL: ${expectedRelayUrl}`);
  } catch (error) {
    console.warn(`[freertc] Worker deployed, but the health check did not complete: ${error.message}`);
    console.warn(`[freertc] Open ${deploymentUrl} once to retry overlay registration.`);
  }
}

const entrypointUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (import.meta.url === entrypointUrl) {
  await main();
}
