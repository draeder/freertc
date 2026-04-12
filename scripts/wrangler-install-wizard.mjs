#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function looksLikeProjectRoot(dir) {
  return (
    fs.existsSync(path.join(dir, 'package.json')) &&
    fs.existsSync(path.join(dir, 'wrangler.template.jsonc')) &&
    fs.existsSync(path.join(dir, 'scripts', 'wrangler-install-wizard.mjs'))
  );
}

function findProjectRoot(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    if (looksLikeProjectRoot(dir)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

const ROOT = findProjectRoot(process.cwd()) || findProjectRoot(SCRIPT_DIR) || process.cwd();
const WRANGLER_CONFIG = path.join(ROOT, 'wrangler.jsonc');
const WRANGLER_TEMPLATE = path.join(ROOT, 'wrangler.template.jsonc');
const D1_SCHEMA_FILE = path.join(ROOT, 'scripts', 'd1-schema.sql');

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: ROOT });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
  return result.status === 0;
}

function isWranglerAuthenticated() {
  const result = spawnSync('npx', ['wrangler', 'whoami'], {
    stdio: 'pipe',
    encoding: 'utf8',
    cwd: ROOT
  });
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

function checkHealthUrl(url) {
  const result = spawnSync('curl', ['-fsS', url], {
    stdio: 'pipe',
    encoding: 'utf8'
  });

  if (result.status === 0) {
    return { ok: true, output: result.stdout || '' };
  }

  const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
  return { ok: false, output };
}

function includesApiKeyMissing(text) {
  if (!text) return false;
  return /api key is missing/i.test(text);
}

async function main() {
  const rl = createInterface({ input, output });

  try {
    if (!looksLikeProjectRoot(ROOT)) {
      throw new Error(`Could not find project root from ${process.cwd()}`);
    }

    console.log('\nfreertc Wrangler Install Wizard\n');
    if (path.resolve(process.cwd()) !== ROOT) {
      console.log(`Detected project root: ${ROOT}`);
      console.log(`Running commands from project root instead of current directory: ${process.cwd()}\n`);
    }

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
      if (isWranglerAuthenticated()) {
        console.log('Wrangler is already authenticated. Skipping login.');
      } else {
        const doLogin = await rl.question('Not logged in. Run "wrangler login" now? [Y/n]: ');
        if (yes(doLogin, true)) {
          run('npx', ['wrangler', 'login']);
        } else {
          console.log('Skipping login. Deploy steps may fail until you authenticate.');
        }
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

        console.log('\nStep 6: Verify deployment endpoint (recommended)');
        console.log('Tip: test /health on your workers.dev URL or custom domain.');
        console.log('Expected response includes JSON with { "ok": true, ... }');

        const doHealthCheck = await rl.question('Run a /health check URL now? [Y/n]: ');
        if (yes(doHealthCheck, true)) {
          const healthUrl = (await rl.question('Enter full health URL (example: https://your-domain/health): ')).trim();
          if (healthUrl) {
            const health = checkHealthUrl(healthUrl);
            if (health.ok) {
              console.log('\n/health response:');
              console.log(health.output.trim() || '(empty body)');
            } else {
              console.log('\nHealth check failed. Raw output:');
              console.log(health.output || '(no output)');
            }

            if (includesApiKeyMissing(health.output)) {
              console.log('\nDetected "API key is missing" in response.');
              console.log('This Worker does not require an API key for /health or /ws.');
              console.log('Most likely causes:');
              console.log('  1) The domain route points to a different service/worker.');
              console.log('  2) Cloudflare Access/API Shield/WAF on that hostname requires auth headers.');
              console.log('  3) You deployed a different environment than expected.');
              console.log('Next checks:');
              console.log('  - Confirm route/custom domain is attached to this Worker.');
              console.log('  - Compare workers.dev /health vs custom-domain /health responses.');
              console.log('  - If using --env production, ensure that env is the one attached to routes.');
            }
          } else {
            console.log('Skipped /health check (no URL entered).');
          }
        }
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
