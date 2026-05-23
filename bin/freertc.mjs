#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ensureProjectFiles, resolveProjectRoot, resolveWranglerCommand } from '../scripts/project-bootstrap.mjs';

const __filename = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = path.resolve(path.dirname(__filename), '..');
const PROJECT_ROOT = resolveProjectRoot(process.cwd());

function printHelp() {
  console.log(`freertc CLI

Usage:
  freertc
  freertc wizard
  freertc setup
  freertc init
  freertc install
  freertc deploy [-- <deploy-args>]
  freertc dev [-- <dev-args>]
  freertc dev:cf [-- <dev-args>]

Examples:
  npx freertc
  npx freertc wizard
  npx freertc setup
  freertc
  npx freertc deploy
`);
}

function runInProject(command, args, { bootstrap = false } = {}) {
  if (bootstrap) {
    ensureProjectFiles(PROJECT_ROOT);
  }

  const result = spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      FREERTC_PACKAGE_ROOT: PACKAGE_ROOT
    }
  });

  if (typeof result.status === 'number') {
    process.exit(result.status);
  }

  process.exit(1);
}

function requireWranglerConfig() {
  const configPath = path.join(PROJECT_ROOT, 'wrangler.jsonc');
  if (fs.existsSync(configPath)) {
    return;
  }

  console.error(`Missing ${configPath}. Run "npx freertc" or "npx freertc wizard" from this project directory first.`);
  process.exit(1);
}

const [, , subcommand, ...rest] = process.argv;

if (!subcommand) {
  runInProject(process.execPath, [path.join(PACKAGE_ROOT, 'scripts', 'wrangler-install-wizard.mjs'), '--mode', 'both'], { bootstrap: true });
}

if (subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
  printHelp();
  process.exit(0);
}

if (subcommand === 'wizard') {
  runInProject(process.execPath, [path.join(PACKAGE_ROOT, 'scripts', 'wrangler-install-wizard.mjs'), ...rest], { bootstrap: true });
}

if (subcommand === 'setup') {
  runInProject(process.execPath, [path.join(PACKAGE_ROOT, 'scripts', 'wrangler-install-wizard.mjs'), '--mode', 'both', ...rest], { bootstrap: true });
}

if (subcommand === 'init' || subcommand === 'install') {
  runInProject(process.execPath, [path.join(PACKAGE_ROOT, 'scripts', 'wrangler-install-wizard.mjs'), '--mode', 'both', ...rest], { bootstrap: true });
}

if (subcommand === 'deploy') {
  ensureProjectFiles(PROJECT_ROOT);
  requireWranglerConfig();
  const wrangler = resolveWranglerCommand(PROJECT_ROOT);
  runInProject(wrangler.command, [...wrangler.baseArgs, 'deploy', '--env', 'production', ...rest]);
}

if (subcommand === 'dev') {
  runInProject(process.execPath, [path.join(PACKAGE_ROOT, 'scripts', 'non-cloudflare-server.mjs'), ...rest], { bootstrap: true });
}

if (subcommand === 'dev:cf' || subcommand === 'dev-cf') {
  runInProject(process.execPath, [path.join(PACKAGE_ROOT, 'scripts', 'dev-server.mjs'), ...rest], { bootstrap: true });
}

console.error(`Unknown command: ${subcommand}\n`);
printHelp();
process.exit(1);
