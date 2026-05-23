#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = path.resolve(path.dirname(__filename), '..');

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

Examples:
  npx freertc
  npx freertc wizard
  npx freertc setup
  freertc
  npx freertc deploy
`);
}

function runInPackage(command, args) {
  const result = spawnSync(command, args, {
    cwd: PACKAGE_ROOT,
    stdio: 'inherit'
  });

  if (typeof result.status === 'number') {
    process.exit(result.status);
  }

  process.exit(1);
}

const [, , subcommand, ...rest] = process.argv;

if (!subcommand) {
  runInPackage('node', ['scripts/wrangler-install-wizard.mjs', '--mode', 'both']);
}

if (subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
  printHelp();
  process.exit(0);
}

if (subcommand === 'wizard') {
  runInPackage('node', ['scripts/wrangler-install-wizard.mjs', ...rest]);
}

if (subcommand === 'setup') {
  runInPackage('node', ['scripts/wrangler-install-wizard.mjs', '--mode', 'both', ...rest]);
}

if (subcommand === 'init' || subcommand === 'install') {
  runInPackage('node', ['scripts/wrangler-install-wizard.mjs', '--mode', 'both', ...rest]);
}

if (subcommand === 'deploy') {
  const npmArgs = ['run', 'deploy'];
  if (rest.length > 0) {
    npmArgs.push('--', ...rest);
  }
  runInPackage('npm', npmArgs);
}

if (subcommand === 'dev') {
  const npmArgs = ['run', 'dev'];
  if (rest.length > 0) {
    npmArgs.push('--', ...rest);
  }
  runInPackage('npm', npmArgs);
}

console.error(`Unknown command: ${subcommand}\n`);
printHelp();
process.exit(1);
