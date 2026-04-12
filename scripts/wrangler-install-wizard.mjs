#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function looksLikeProjectRoot(dir) {
  const hasPackage = fs.existsSync(path.join(dir, 'package.json'));
  const hasWranglerConfig = fs.existsSync(path.join(dir, 'wrangler.jsonc'));
  const hasWranglerTemplate = fs.existsSync(path.join(dir, 'wrangler.template.jsonc'));
  return (
    hasPackage && (hasWranglerConfig || hasWranglerTemplate)
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

function findNearestPackageRoot(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

// Prefer an explicit wrangler-config root found by walking up from either the
// script file location or cwd. Only fall back to "nearest package.json" when
// neither walk finds a wrangler config, to avoid accidentally binding to an
// outer project that has this package installed as a dependency.
const ROOT =
  findProjectRoot(SCRIPT_DIR) ||
  findProjectRoot(process.cwd()) ||
  findNearestPackageRoot(SCRIPT_DIR) ||
  findNearestPackageRoot(process.cwd()) ||
  process.cwd();
const WRANGLER_CONFIG = path.join(ROOT, 'wrangler.jsonc');
const WRANGLER_TEMPLATE = path.join(ROOT, 'wrangler.template.jsonc');
const D1_SCHEMA_FILE = path.join(ROOT, 'scripts', 'd1-schema.sql');

function readProjectName(dir) {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) return 'worker-app';
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return (pkg?.name && String(pkg.name).trim()) || 'worker-app';
  } catch {
    return 'worker-app';
  }
}

const PROJECT_NAME = readProjectName(ROOT);

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: ROOT });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
  return result.status === 0;
}

function getWranglerCommand() {
  const globalCheck = spawnSync('wrangler', ['--version'], {
    stdio: 'pipe',
    encoding: 'utf8',
    cwd: ROOT
  });
  if (globalCheck.status === 0) {
    return { command: 'wrangler', baseArgs: [], source: 'global' };
  }
  return { command: 'npx', baseArgs: ['wrangler'], source: 'npx' };
}

// Resolved lazily after npm install — do not call before resolveWrangler().
let WRANGLER = null;

function resolveWrangler() {
  WRANGLER = getWranglerCommand();
}

function runWrangler(args, options = {}) {
  return run(WRANGLER.command, [...WRANGLER.baseArgs, ...args], options);
}

function isWranglerAuthenticated() {
  const result = spawnSync(WRANGLER.command, [...WRANGLER.baseArgs, 'whoami'], {
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
    return { created: false, source: 'existing' };
  }
  if (!fs.existsSync(WRANGLER_TEMPLATE)) {
    const fallback = `{
  "name": "${PROJECT_NAME}",
  "main": "src/index.js",
  "compatibility_date": "2024-09-23"
}\n`;
    fs.writeFileSync(WRANGLER_CONFIG, fallback, 'utf8');
    return { created: true, source: 'fallback' };
  }
  fs.copyFileSync(WRANGLER_TEMPLATE, WRANGLER_CONFIG);
  return { created: true, source: 'template' };
}

function sanitizeDomain(domain) {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function dbNameForDomain(domain) {
  const sanitized = sanitizeDomain(domain);
  return sanitized ? `freertc-signal-${sanitized}` : 'freertc-signal';
}

// Extract the domain slug from an existing freertc-signal-<domain> DB name.
// Returns null for placeholder values or plain 'freertc-signal'.
function domainFromDbName(dbName) {
  if (!dbName) return null;
  const PLACEHOLDERS = ['freertc-signal', 'freertc-signal-your-domain', 'freertc-signal-your_domain'];
  if (PLACEHOLDERS.includes(dbName.toLowerCase())) return null;
  const match = dbName.match(/^freertc-signal-(.+)$/);
  return match ? match[1] : null;
}

// Replace all occurrences of a database_name value in wrangler.jsonc text.
function patchDbName(text, newDbName) {
  return text.replace(
    /("database_name"\s*:\s*)"[^"]*"/g,
    `$1"${newDbName}"`
  );
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
    if (!fs.existsSync(path.join(ROOT, 'package.json'))) {
      throw new Error(`Could not find a project with package.json from ${process.cwd()}`);
    }

    console.log(`\n${PROJECT_NAME} Wrangler Install Wizard\n`);
    console.log(`Using project root: ${ROOT}`);
    console.log(`Wrangler config path: ${WRANGLER_CONFIG}`);
    console.log(`Wrangler template path: ${WRANGLER_TEMPLATE}\n`);

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

    // Detect wrangler after npm install so local node_modules/.bin is available.
    resolveWrangler();

    console.log('\nStep 2: Verify Wrangler CLI is available');
    runWrangler(['--version']);
    console.log(`Using ${WRANGLER.source} wrangler.`);

    // Create wrangler.jsonc first so we can read existing DB name from it.
    const wranglerInit = copyTemplateIfNeeded();
    if (wranglerInit.created && wranglerInit.source === 'template') {
      console.log('\nCreated wrangler.jsonc from wrangler.template.jsonc.');
      console.log('Edit wrangler.jsonc and replace YOUR_D1_DATABASE_ID before production deploy.');
    }
    if (wranglerInit.created && wranglerInit.source === 'fallback') {
      console.log('\nCreated wrangler.jsonc from fallback defaults (template not found).');
      console.log('Update name/main/compatibility_date and add bindings before deploy.');
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    // Derive D1 database name from domain or existing config.
    console.log('\nStep 3: Configure D1 database name');
    try {
      const existingDbName = parseFirstDatabaseName(WRANGLER_CONFIG);
      const existingDomain = domainFromDbName(existingDbName);
      
      let derivedDbName;
      
      if (existingDomain) {
        // Offer the existing domain-derived name as default
        const dbNamePrompt = `Database name [press Enter for ${existingDbName}]: `;
        const customDbName = (await rl.question(dbNamePrompt)).trim();
        derivedDbName = customDbName || existingDbName;
        console.log(`Using database name: ${derivedDbName}`);
      } else {
        // Existing DB is placeholder or missing domain flavor — always offer to upgrade
        if (existingDbName === 'freertc-signal') {
          console.log(`Current database: ${existingDbName} (placeholder, no domain)`);
        }
        console.log('Database names should follow: freertc-signal-<your-domain>');
        const domainInput = (await rl.question('Enter your domain (example: example.com): ')).trim();
        if (!domainInput) {
          console.log('No domain entered. Please run the wizard again.');
          return;
        }
        derivedDbName = dbNameForDomain(domainInput);
        console.log(`✓ Domain-specific database name: ${derivedDbName}`);
        const customDbName = (await rl.question(`Confirm [press Enter for ${derivedDbName}]: `)).trim();
        derivedDbName = customDbName || derivedDbName;
      }

      // Always patch the DB name into wrangler.jsonc.
      const wranglerText = fs.readFileSync(WRANGLER_CONFIG, 'utf8');
      fs.writeFileSync(WRANGLER_CONFIG, patchDbName(wranglerText, derivedDbName), 'utf8');
      console.log(`✓ Updated wrangler.jsonc with database name: ${derivedDbName}`);
    } catch (err) {
      console.error('Step 3 error:', err.message);
      throw err;
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
      console.log('\nStep 4: Cloudflare authentication');
      if (isWranglerAuthenticated()) {
        console.log('Wrangler is already authenticated. Skipping login.');
      } else {
        const doLogin = await rl.question('Not logged in. Run "wrangler login" now? [Y/n]: ');
        if (yes(doLogin, true)) {
          runWrangler(['login']);
        } else {
          console.log('Skipping login. Deploy steps may fail until you authenticate.');
        }
      }
    }

    if (needsDev) {
      console.log('\nStep 5: Initialize local D1 schema');
      runWrangler(['d1', 'execute', dbName, '--local', '--file', 'scripts/d1-schema.sql']);

      const startDev = await rl.question('Start local dev server now (npm run dev)? [Y/n]: ');
      if (yes(startDev, true)) {
        run('npm', ['run', 'dev']);
      }
    }

    if (needsDeploy) {
      console.log('\nStep 6: Initialize remote D1 schema');
      runWrangler(['d1', 'execute', dbName, '--remote', '--file', 'scripts/d1-schema.sql']);

      const doDeploy = await rl.question('Deploy now (npm run deploy)? [Y/n]: ');
      if (yes(doDeploy, true)) {
        run('npm', ['run', 'deploy']);

        console.log('\nStep 7: Verify deployment endpoint (recommended)');
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
