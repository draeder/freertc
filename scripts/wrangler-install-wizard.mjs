#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const ROOT = process.cwd();
const WRANGLER_CONFIG = path.join(ROOT, 'wrangler.jsonc');
const WRANGLER_TEMPLATE = path.join(ROOT, 'wrangler.template.jsonc');
const D1_SCHEMA_FILE = path.join(ROOT, 'scripts', 'd1-schema.sql');

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
  return result.status === 0;
}

function parseFirstDatabaseName(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const jsonc = fs.readFileSync(filePath, 'utf8');
  const match = jsonc.match(/"database_name"\s*:\s*"([^"]+)"/);
  return match ? match[1] : null;
}

function copyTemplateIfNeeded() {
  if (fs.existsSync(WRANGLER_CONFIG)) {
    return false;
  }
  if (!fs.existsSync(WRANGLER_TEMPLATE)) {
    throw new Error('Missing wrangler.template.jsonc; cannot bootstrap wrangler.jsonc');
  }
  fs.copyFileSync(WRANGLER_TEMPLATE, WRANGLER_CONFIG);
  return true;
}

function modeFromAnswer(answer) {
  const normalized = (answer || '').trim().toLowerCase();
  if (normalized === '1' || normalized === 'dev') return 'dev';
  if (normalized === '2' || normalized === 'deploy') return 'deploy';
  if (normalized === '3' || normalized === 'both') return 'both';
  return null;
}

function yes(answer, defaultYes = true) {
  const normalized = (answer || '').trim().toLowerCase();
  if (!normalized) return defaultYes;
  return normalized === 'y' || normalized === 'yes';
}

async function main() {
  const rl = createInterface({ input, output });

  try {
    console.log('\nfreertc Wrangler Install Wizard\n');

    console.log('Choose setup mode:');
    console.log('  1) dev     (local wrangler dev + local D1 schema)');
    console.log('  2) deploy  (Cloudflare login + remote D1 schema + deploy)');
    console.log('  3) both    (dev + deploy setup)\n');

    const modeAnswer = await rl.question('Mode [1/2/3]: ');
    const mode = modeFromAnswer(modeAnswer);
    if (!mode) {
      throw new Error('Invalid mode. Please run the wizard again and choose 1, 2, or 3.');
    }

    const needsDev = mode === 'dev' || mode === 'both';
    const needsDeploy = mode === 'deploy' || mode === 'both';

    console.log('\nStep 1: Ensure dependencies are installed');
    run('npm', ['install']);

    console.log('\nStep 2: Verify Wrangler CLI is available');
    run('npx', ['wrangler', '--version']);

    const createdFromTemplate = copyTemplateIfNeeded();
    if (createdFromTemplate) {
      console.log('\nCreated wrangler.jsonc from wrangler.template.jsonc.');
      console.log('Edit wrangler.jsonc and replace placeholder values before production deploy.');
    }

    const dbName = parseFirstDatabaseName(WRANGLER_CONFIG);
    if (!dbName) {
      console.log('\nNo D1 database_name found in wrangler.jsonc.');
      console.log('Please set d1_databases[0].database_name, then rerun this wizard.');
      return;
    }

    if (!fs.existsSync(D1_SCHEMA_FILE)) {
      throw new Error('Missing scripts/d1-schema.sql');
    }

    if (needsDeploy) {
      console.log('\nStep 3: Cloudflare authentication');
      const doLogin = await rl.question('Run "wrangler login" now? [Y/n]: ');
      if (yes(doLogin, true)) {
        run('npx', ['wrangler', 'login']);
      } else {
        console.log('Skipping login. Ensure you are already authenticated before deploy.');
      }
    }

    if (needsDev) {
      console.log('\nStep 4: Initialize local D1 schema');
      run('npx', ['wrangler', 'd1', 'execute', dbName, '--local', '--file', 'scripts/d1-schema.sql']);

      const startDev = await rl.question('Start local dev server now (npm run dev)? [Y/n]: ');
      if (yes(startDev, true)) {
        run('npm', ['run', 'dev']);
      }
    }

    if (needsDeploy) {
      console.log('\nStep 5: Initialize remote D1 schema');
      run('npx', ['wrangler', 'd1', 'execute', dbName, '--remote', '--file', 'scripts/d1-schema.sql']);

      const doDeploy = await rl.question('Deploy now (npm run deploy)? [Y/n]: ');
      if (yes(doDeploy, true)) {
        run('npm', ['run', 'deploy']);
      }
    }

    console.log('\nWizard completed successfully.');
    console.log('\nQuick commands:');
    console.log('  npm run d1:init:local');
    console.log('  npm run d1:init:remote');
    console.log('  npm run dev');
    console.log('  npm run deploy');
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(`\nWizard failed: ${error.message}`);
  process.exit(1);
});
