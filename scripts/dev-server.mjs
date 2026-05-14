#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const CARGO_BIN = path.join(os.homedir(), '.cargo', 'bin');
const PATH_WITH_CARGO = `${CARGO_BIN}${path.delimiter}${process.env.PATH || ''}`;
const WASM_TARGET = 'wasm32-unknown-unknown';

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
      args: ['wrangler', 'dev'],
      configPath: localConfig
    };
  }
  if (fs.existsSync(workersDevConfig)) {
    return {
      args: ['wrangler', 'dev', '--config', 'wrangler.workers-dev.jsonc'],
      configPath: workersDevConfig
    };
  }

  fail('No Wrangler config found. Create wrangler.jsonc or keep wrangler.workers-dev.jsonc.');
}

function configUsesWorkerBuild(configPath) {
  try {
    const text = fs.readFileSync(configPath, 'utf8');
    return /worker-build/.test(text);
  } catch {
    return false;
  }
}

const resolved = resolveWranglerArgs();

if (configUsesWorkerBuild(resolved.configPath)) {
  ensureWorkerBuild();
  ensureWasmTarget();
}

const started = run('npx', resolved.args);
process.exit(started.status ?? 1);
