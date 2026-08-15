#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();

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

export async function main() {
  const deploy = spawnSync('wrangler', ['deploy'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
    stdio: 'pipe'
  });

  if (deploy.stdout) process.stdout.write(deploy.stdout);
  if (deploy.stderr) process.stderr.write(deploy.stderr);

  if (deploy.error) {
    console.error(`[freertc] Could not start Wrangler: ${deploy.error.message}`);
  }
  if (deploy.status !== 0) {
    process.exitCode = deploy.status || 1;
    return;
  }

  const deploymentUrl = firstWorkersDevUrlFromText(`${deploy.stdout || ''}\n${deploy.stderr || ''}`);
  const expectedRelayUrl = relayUrlFromWorkersDevUrl(deploymentUrl);
  if (!deploymentUrl || !expectedRelayUrl) {
    console.warn('[freertc] Deployment succeeded, but no workers.dev URL was found in Wrangler output.');
    console.warn('[freertc] Open the deployed Worker once to trigger federation registration.');
    return;
  }

  try {
    const { healthUrl, health } = await requestHealth(deploymentUrl);
    if (health?.relay_url !== expectedRelayUrl) {
      throw new Error(`expected relay_url ${expectedRelayUrl}, received ${health?.relay_url || '(missing)'}`);
    }
    console.log(`[freertc] Federation registration triggered through ${healthUrl}`);
    console.log(`[freertc] Relay URL: ${expectedRelayUrl}`);
  } catch (error) {
    console.warn(`[freertc] Worker deployed, but the registration health check did not complete: ${error.message}`);
    console.warn(`[freertc] Open ${deploymentUrl} once to retry federation registration.`);
  }
}

const entrypointUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (import.meta.url === entrypointUrl) {
  await main();
}
