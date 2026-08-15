#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { generateRandomPair } from 'unsea';
import { encodeRelayIdentitySecret } from '../src/relay-identity.js';
import { resolveWranglerCommand } from './project-bootstrap.mjs';

const ROOT = process.cwd();
const CARGO_BIN = path.join(os.homedir(), '.cargo', 'bin');
const PATH_WITH_CARGO = `${CARGO_BIN}${path.delimiter}${process.env.PATH || ''}`;
const WASM_TARGET = 'wasm32-unknown-unknown';
const LOCAL_SECRETS_FILE = path.join(ROOT, '.dev.vars');

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, PATH: PATH_WITH_CARGO },
    ...options
  });
}

function runCapture(command, args) {
  return spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'pipe',
    encoding: 'utf8',
    env: { ...process.env, PATH: PATH_WITH_CARGO }
  });
}

function commandExists(command, args = ['--version']) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, PATH: PATH_WITH_CARGO }
  });
  return result.status === 0;
}

function fail(message) {
  console.error(`\n[dev-setup] ${message}`);
  process.exit(1);
}

function hasWasmTargetInstalled() {
  const sysroot = runCapture('rustc', ['--print', 'sysroot']);
  if (sysroot.status !== 0) return false;
  const sysrootPath = (sysroot.stdout || '').trim();
  if (!sysrootPath) return false;

  const targetDir = path.join(sysrootPath, 'lib', 'rustlib', WASM_TARGET);
  return fs.existsSync(targetDir);
}

function ensureWorkerBuild() {
  if (commandExists('worker-build')) return;

  if (!commandExists('cargo')) {
    fail('Missing Cargo. Install Rust toolchain first: https://rustup.rs');
  }

  console.log('[dev-setup] Installing worker-build via Cargo...');
  const installed = run('cargo', ['install', 'worker-build']);
  if (installed.status !== 0) {
    fail('Failed to install worker-build.');
  }
}

function ensureWasmTarget() {
  if (!commandExists('rustc')) {
    fail('Missing Rust compiler. Install Rust toolchain first: https://rustup.rs');
  }

  if (hasWasmTargetInstalled()) return;

  if (!commandExists('rustup')) {
    fail(
      'Missing WebAssembly Rust target, and rustup is not available to auto-install it.\n' +
      'Install rustup, then run: rustup target add wasm32-unknown-unknown'
    );
  }

  console.log('[dev-setup] Installing WebAssembly Rust target...');
  const installed = run('rustup', ['target', 'add', WASM_TARGET]);
  if (installed.status !== 0 || !hasWasmTargetInstalled()) {
    fail('Failed to install WebAssembly Rust target.');
  }
}

function resolveWranglerArgs() {
  const localConfig = path.join(ROOT, 'wrangler.jsonc');
  const workersDevConfig = path.join(ROOT, 'wrangler.workers-dev.jsonc');

  if (fs.existsSync(localConfig)) {
    return {
      args: ['dev'],
      configArgs: [],
      configPath: localConfig
    };
  }
  if (fs.existsSync(workersDevConfig)) {
    return {
      args: ['dev', '--config', 'wrangler.workers-dev.jsonc'],
      configArgs: ['--config', 'wrangler.workers-dev.jsonc'],
      configPath: workersDevConfig
    };
  }

  fail('No Wrangler config found. Create wrangler.jsonc or keep wrangler.workers-dev.jsonc.');
}

export async function ensureLocalRelayIdentity(filePath = LOCAL_SECRETS_FILE) {
  const ignorePath = path.join(path.dirname(filePath), '.gitignore');
  const ignoreEntry = path.basename(filePath);
  const ignoreText = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, 'utf8') : '';
  if (!ignoreText.split(/\r?\n/).includes(ignoreEntry)) {
    const separator = ignoreText && !ignoreText.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(ignorePath, `${separator}${ignoreEntry}\n`, 'utf8');
  }

  const current = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf8')
    : '';
  if (/^\s*(RELAY_IDENTITY_SECRET|RELAY_SIGNING_PRIVATE_KEY)\s*=/m.test(current)) return;

  const pair = await generateRandomPair();
  const secret = encodeRelayIdentitySecret(pair.pub, pair.priv);
  const separator = current && !current.endsWith('\n') ? '\n' : '';
  const line = `${separator}RELAY_IDENTITY_SECRET='${secret}'\n`;
  if (fs.existsSync(filePath)) {
    fs.appendFileSync(filePath, line, 'utf8');
  } else {
    fs.writeFileSync(filePath, line, { encoding: 'utf8', mode: 0o600 });
  }
  console.log('[dev-setup] Generated a private relay identity in the ignored .dev.vars file.');
}

function configUsesWorkerBuild(configPath) {
  try {
    const text = fs.readFileSync(configPath, 'utf8');
    return /worker-build/.test(text);
  } catch {
    return false;
  }
}

async function main() {
  const resolved = resolveWranglerArgs();
  const wrangler = resolveWranglerCommand(ROOT);

  if (configUsesWorkerBuild(resolved.configPath)) {
    ensureWorkerBuild();
    ensureWasmTarget();
  }

  await ensureLocalRelayIdentity();
  console.log('[dev-setup] Applying local D1 migrations...');
  const migrated = run(wrangler.command, [
    ...wrangler.baseArgs,
    'd1', 'migrations', 'apply', 'DB', '--local', ...resolved.configArgs,
  ]);
  if (migrated.status !== 0) fail('Failed to apply local D1 migrations.');

  const started = run(wrangler.command, [...wrangler.baseArgs, ...resolved.args]);
  process.exit(started.status ?? 1);
}

const entrypointUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (import.meta.url === entrypointUrl) {
  await main();
}
