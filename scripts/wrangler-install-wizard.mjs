#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { PACKAGE_ROOT, ensureProjectFiles, resolveProjectRoot, resolveWranglerCommand } from './project-bootstrap.mjs';

const CARGO_BIN = path.join(os.homedir(), '.cargo', 'bin');
const PATH_WITH_CARGO = `${CARGO_BIN}${path.delimiter}${process.env.PATH || ''}`;
const WASM_TARGET = 'wasm32-unknown-unknown';
const ROOT = resolveProjectRoot(process.cwd());
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
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    cwd: ROOT,
    env: { ...process.env, PATH: PATH_WITH_CARGO }
  });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
  return result.status === 0;
}

function runCapture(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    stdio: 'pipe',
    encoding: 'utf8',
    cwd: ROOT,
    env: { ...process.env, PATH: PATH_WITH_CARGO }
  });
  if (result.status !== 0 && !allowFailure) {
    const stderr = (result.stderr || '').trim();
    throw new Error(`Command failed: ${command} ${args.join(' ')}${stderr ? `\n${stderr}` : ''}`);
  }
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}

function commandExists(command, args = ['--version']) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, PATH: PATH_WITH_CARGO }
  });
  return result.status === 0;
}

function hasWasmTargetInstalled() {
  const sysroot = runCapture('rustc', ['--print', 'sysroot'], { allowFailure: true });
  if (!sysroot.ok) return false;
  const sysrootPath = (sysroot.stdout || '').trim();
  if (!sysrootPath) return false;

  const targetDir = path.join(sysrootPath, 'lib', 'rustlib', WASM_TARGET);
  return fs.existsSync(targetDir);
}

function ensureWorkerBuild() {
  if (commandExists('worker-build')) return;

  if (!commandExists('cargo')) {
    throw new Error(
      'Rust build required by wrangler config but Cargo is missing. Install Rust from https://rustup.rs or switch wrangler main/build to JS (src/index.js).'
    );
  }

  console.log('Installing worker-build via Cargo...');
  run('cargo', ['install', 'worker-build']);
}

function ensureWasmTarget() {
  if (!commandExists('rustc')) {
    throw new Error('Rust build required by wrangler config but rustc is missing. Install Rust from https://rustup.rs.');
  }
  if (hasWasmTargetInstalled()) return;

  if (!commandExists('rustup')) {
    throw new Error(`Missing ${WASM_TARGET} target and rustup is not available. Install rustup then run: rustup target add ${WASM_TARGET}`);
  }

  console.log(`Installing ${WASM_TARGET} Rust target...`);
  run('rustup', ['target', 'add', WASM_TARGET]);
}

function wranglerConfigUsesWorkerBuild(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const text = fs.readFileSync(filePath, 'utf8');
  return /worker-build/.test(text);
}

function ensureBuildPrereqsForConfig(filePath) {
  if (!wranglerConfigUsesWorkerBuild(filePath)) return;

  console.log('\nDetected Rust worker build command in Wrangler config.');
  console.log('Ensuring worker-build and WebAssembly target are available...');
  ensureWorkerBuild();
  ensureWasmTarget();
}

function getWranglerCommand() {
  return resolveWranglerCommand(ROOT);
}

// Resolved lazily after npm install — do not call before resolveWrangler().
let WRANGLER = null;

function resolveWrangler() {
  WRANGLER = getWranglerCommand();
}

function runWrangler(args, options = {}) {
  return run(WRANGLER.command, [...WRANGLER.baseArgs, ...args], options);
}

function runWranglerCapture(args, options = {}) {
  return runCapture(WRANGLER.command, [...WRANGLER.baseArgs, ...args], options);
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

function parseFirstDatabaseId(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const jsonc = fs.readFileSync(filePath, 'utf8');
  const match = jsonc.match(/"database_id"\s*:\s*"([^"]+)"/);
  return match ? match[1] : null;
}

function isValidUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function patchDbId(text, newDbId) {
  return text.replace(
    /("database_id"\s*:\s*)"[^"]*"/g,
    `$1"${newDbId}"`
  );
}

function firstUuidFromText(text) {
  if (!text) return null;
  const match = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  return match ? match[0] : null;
}

function resolveRemoteDbId(dbName) {
  // Try create first. If DB already exists, wrangler typically returns non-zero
  // and we fall back to list lookup.
  const createResult = runWranglerCapture(['d1', 'create', dbName], { allowFailure: true });
  const createOutput = `${createResult.stdout}\n${createResult.stderr}`;
  const createdId = firstUuidFromText(createOutput);
  if (createdId) {
    return createdId;
  }

  const listJson = runWranglerCapture(['d1', 'list', '--json'], { allowFailure: true });
  if (listJson.ok) {
    try {
      const parsed = JSON.parse(listJson.stdout);
      if (Array.isArray(parsed)) {
        const found = parsed.find((entry) => entry?.name === dbName || entry?.database_name === dbName);
        const id = found?.uuid || found?.id || found?.database_id;
        if (isValidUuid(id)) return id;
      }
    } catch {
      // fall through to text parsing below
    }
  }

  const listText = runWranglerCapture(['d1', 'list'], { allowFailure: true });
  const line = `${listText.stdout}\n${listText.stderr}`
    .split('\n')
    .find((l) => l.includes(dbName));
  const listedId = firstUuidFromText(line || `${listText.stdout}\n${listText.stderr}`);
  return listedId;
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

function normalizeHost(value) {
  if (!value || typeof value !== 'string') return null;
  let host = value.trim().toLowerCase();
  if (!host) return null;
  host = host.replace(/^https?:\/\//, '');
  host = host.replace(/\/.*$/, '');
  host = host.replace(/:\d+$/, '');
  return host || null;
}

function firstRouteHostFromWranglerConfig(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const jsonc = fs.readFileSync(filePath, 'utf8');
  const routePatternMatch = jsonc.match(/"pattern"\s*:\s*"([^"]+)"/);
  if (!routePatternMatch) return null;
  const pattern = routePatternMatch[1];
  const host = pattern.split('/')[0];
  return normalizeHost(host);
}

function dbNameForDomain(domain) {
  const sanitized = sanitizeDomain(domain);
  return sanitized ? `freertc-signal-${sanitized}` : 'freertc-signal';
}

function workerNameForDomain(domain) {
  const sanitized = sanitizeDomain(domain);
  if (!sanitized) return PROJECT_NAME;
  return `${PROJECT_NAME}-${sanitized}`;
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

function patchVar(text, varName, value) {
  // Replace existing quoted value for the var in any vars block
  const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`("${escaped}"\\s*:\\s*)"[^"]*"`, 'g');
  if (re.test(text)) {
    return text.replace(re, `$1"${value}"`);
  }
  // If not found, inject after RELAY_PEER_ID line (best-effort)
  return text.replace(
    /("RELAY_PEER_ID"\s*:\s*"[^"]*")/g,
    `$1,\n    "${varName}": "${value}"`
  );
}

function removeVar(text, varName) {
  const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Remove the line (and trailing comma or leading comma)
  return text
    .replace(new RegExp(`\\s*"${escaped}"\\s*:\\s*"[^"]*",?`, 'g'), '')
    .replace(/,(\s*})/g, '$1'); // clean up trailing commas before closing braces
}

function randomSuffix(length = 6) {
  return Math.random().toString(36).slice(2, 2 + length).padEnd(length, '0');
}

function patchWorkerName(text, newName) {
  // Patch every "name": "..." line (top-level and env.production)
  return text.replace(/^(\s*"name"\s*:\s*)"[^"]*"/gm, `$1"${newName}"`);
}

function parseFirstWorkerName(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const jsonc = fs.readFileSync(filePath, 'utf8');
  const match = jsonc.match(/"name"\s*:\s*"([^"]+)"/);
  return match ? match[1] : null;
}

function modeFromAnswer(answer) {
  const normalized = (answer || '').trim().toLowerCase();
  if (normalized === '1' || normalized === 'dev') return 'dev';
  if (normalized === '2' || normalized === 'deploy') return 'deploy';
  if (normalized === '3' || normalized === 'both') return 'both';
  return null;
}

function modeFromArgs(argv) {
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--mode' && i + 1 < args.length) {
      return modeFromAnswer(args[i + 1]);
    }
    if (arg.startsWith('--mode=')) {
      return modeFromAnswer(arg.split('=')[1]);
    }
  }
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
  const forcedMode = modeFromArgs(process.argv);

  try {
    const copiedFiles = ensureProjectFiles(ROOT);

    console.log(`\n${PROJECT_NAME} Wrangler Install Wizard\n`);
    console.log(`Using project root: ${ROOT}`);
    console.log(`Wrangler config path: ${WRANGLER_CONFIG}`);
    console.log(`Wrangler template path: ${WRANGLER_TEMPLATE}`);
    console.log(`Package assets path: ${PACKAGE_ROOT}\n`);

    if (path.resolve(process.cwd()) !== ROOT) {
      console.log(`Detected project root: ${ROOT}`);
      console.log(`Running commands from project root instead of current directory: ${process.cwd()}\n`);
    }

    if (copiedFiles.length > 0) {
      console.log('Copied package files into this project:');
      for (const file of copiedFiles) {
        console.log(`  - ${file}`);
      }
      console.log('');
    }

    let mode = forcedMode;
    if (!mode) {
      console.log('Choose setup mode:');
      console.log('  1) dev     (local wrangler dev + local D1 schema)');
      console.log('  2) deploy  (Cloudflare login + remote D1 schema + deploy)');
      console.log('  3) both    (dev + deploy setup)\n');

      const modeAnswer = await rl.question('Mode [1/2/3]: ');
      mode = modeFromAnswer(modeAnswer);
    } else {
      console.log(`Using setup mode from args: ${mode}`);
    }

    if (!mode) {
      throw new Error('Invalid mode. Please run the wizard again and choose 1, 2, or 3.');
    }

    const needsDev = mode === 'dev' || mode === 'both';
    const needsDeploy = mode === 'deploy' || mode === 'both';

    console.log('\nStep 1: Ensure project files are present');
    if (copiedFiles.length === 0) {
      console.log('Required worker files already exist in this project.');
    } else {
      console.log('Project bootstrapped from the published freertc package.');
    }

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

    ensureBuildPrereqsForConfig(WRANGLER_CONFIG);

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    // Derive D1 database name from domain or existing config.
    console.log('\nStep 3: Configure D1 database name');
    let preferredHealthHost = null;
    const isFirstRun = wranglerInit.created;
    try {
      const existingDbName = parseFirstDatabaseName(WRANGLER_CONFIG);
      const existingDomain = domainFromDbName(existingDbName);
      
      let derivedDbName;
      
      if (isFirstRun) {
        console.log('Enter your custom domain, or press Enter to use a free workers.dev subdomain.');
        const domainInput = (await rl.question('Domain (example: example.com) [Enter to skip]: ')).trim();
        if (!domainInput) {
          const suffix = randomSuffix();
          const workerName = `${PROJECT_NAME}-${suffix}`;
          derivedDbName = `freertc-signal-${suffix}`;
          console.log(`✓ No domain — using free workers.dev subdomain.`);
          console.log(`  Worker name : ${workerName}`);
          console.log(`  Database    : ${derivedDbName}`);
          let wText = fs.readFileSync(WRANGLER_CONFIG, 'utf8');
          wText = patchWorkerName(wText, workerName);
          fs.writeFileSync(WRANGLER_CONFIG, wText, 'utf8');
        } else {
          derivedDbName = dbNameForDomain(domainInput);
          const workerName = workerNameForDomain(domainInput);
          preferredHealthHost = normalizeHost(domainInput);
          console.log(`✓ Domain-specific database name: ${derivedDbName}`);
          console.log(`✓ Domain-specific worker name: ${workerName}`);
          const customDbName = (await rl.question(`Database name [press Enter for ${derivedDbName}]: `)).trim();
          derivedDbName = customDbName || derivedDbName;
          console.log(`Using database name: ${derivedDbName}`);
          let wText = fs.readFileSync(WRANGLER_CONFIG, 'utf8');
          wText = patchWorkerName(wText, workerName);
          fs.writeFileSync(WRANGLER_CONFIG, wText, 'utf8');
        }
      } else if (existingDomain) {
        // Offer the existing domain-derived name as default
        const dbNamePrompt = `Database name [press Enter for ${existingDbName}]: `;
        const customDbName = (await rl.question(dbNamePrompt)).trim();
        derivedDbName = customDbName || existingDbName;
        console.log(`Using database name: ${derivedDbName}`);
        const workerName = workerNameForDomain(existingDomain);
        let wText = fs.readFileSync(WRANGLER_CONFIG, 'utf8');
        wText = patchWorkerName(wText, workerName);
        fs.writeFileSync(WRANGLER_CONFIG, wText, 'utf8');
        console.log(`✓ Domain-specific worker name: ${workerName}`);
      } else {
        // Existing DB is placeholder or missing domain flavor — always offer to upgrade
        if (existingDbName === 'freertc-signal') {
          console.log(`Current database: ${existingDbName} (placeholder, no domain)`);
        }
        console.log('Database names should follow: freertc-signal-<your-domain>');
        const domainInput = (await rl.question('Domain (example: example.com) [Enter to use free workers.dev]: ')).trim();
        if (!domainInput) {
          const suffix = randomSuffix();
          const workerName = `${PROJECT_NAME}-${suffix}`;
          derivedDbName = `freertc-signal-${suffix}`;
          console.log(`✓ No domain — using free workers.dev subdomain.`);
          console.log(`  Worker name : ${workerName}`);
          console.log(`  Database    : ${derivedDbName}`);
          let wText = fs.readFileSync(WRANGLER_CONFIG, 'utf8');
          wText = patchWorkerName(wText, workerName);
          fs.writeFileSync(WRANGLER_CONFIG, wText, 'utf8');
        } else {
          derivedDbName = dbNameForDomain(domainInput);
          const workerName = workerNameForDomain(domainInput);
          preferredHealthHost = normalizeHost(domainInput);
          console.log(`✓ Domain-specific database name: ${derivedDbName}`);
          console.log(`✓ Domain-specific worker name: ${workerName}`);
          const customDbName = (await rl.question(`Confirm [press Enter for ${derivedDbName}]: `)).trim();
          derivedDbName = customDbName || derivedDbName;
          let wText = fs.readFileSync(WRANGLER_CONFIG, 'utf8');
          wText = patchWorkerName(wText, workerName);
          fs.writeFileSync(WRANGLER_CONFIG, wText, 'utf8');
        }
      }

      // Patch DB name and auto-set RELAY_URL from domain.
      const host = preferredHealthHost || normalizeHost(derivedDbName.replace(/^freertc-signal-/, ''));
      const relayWsUrl = host ? `wss://${host}/ws` : null;

      let wranglerText = fs.readFileSync(WRANGLER_CONFIG, 'utf8');
      wranglerText = patchDbName(wranglerText, derivedDbName);
      if (relayWsUrl) {
        wranglerText = patchVar(wranglerText, 'RELAY_URL', relayWsUrl);
        console.log(`✓ Set RELAY_URL: ${relayWsUrl}`);
      }
      fs.writeFileSync(WRANGLER_CONFIG, wranglerText, 'utf8');
      console.log(`✓ Updated wrangler.jsonc with database name: ${derivedDbName}`);

      // Federation opt-in
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('\nGlobal peer network: contribute your relay to peer.ooo federation?');
      console.log('When enabled, peers across all federated relays can discover each other.');
      const joinGlobal = await rl.question('Join global network at peer.ooo? [Y/n]: ');
      let updatedText = fs.readFileSync(WRANGLER_CONFIG, 'utf8');
      if (yes(joinGlobal, true)) {
        const relayNameAnswer = (await rl.question('Relay display name [press Enter to skip]: ')).trim();
        updatedText = patchVar(updatedText, 'GLOBAL_RELAY_URL', 'wss://peer.ooo/ws');
        if (relayNameAnswer) {
          updatedText = patchVar(updatedText, 'RELAY_NAME', relayNameAnswer);
        }
        console.log('✓ GLOBAL_RELAY_URL set to wss://peer.ooo/ws');
      } else {
        updatedText = removeVar(updatedText, 'GLOBAL_RELAY_URL');
        updatedText = removeVar(updatedText, 'RELAY_NAME');
        console.log('✓ Skipped global network — relay will operate standalone.');
      }
      fs.writeFileSync(WRANGLER_CONFIG, updatedText, 'utf8');

      // Safety pass: when DB name is domain-based and worker name is still default,
      // normalize to freertc-<domain> before any deploy action.
      const currentWorkerName = parseFirstWorkerName(WRANGLER_CONFIG);
      const domainFromDb = domainFromDbName(derivedDbName);
      if (domainFromDb && currentWorkerName === PROJECT_NAME) {
        const normalizedWorkerName = workerNameForDomain(domainFromDb);
        let normalizeText = fs.readFileSync(WRANGLER_CONFIG, 'utf8');
        normalizeText = patchWorkerName(normalizeText, normalizedWorkerName);
        fs.writeFileSync(WRANGLER_CONFIG, normalizeText, 'utf8');
        console.log(`✓ Normalized worker name from ${PROJECT_NAME} to ${normalizedWorkerName}`);
      }
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

    // For remote operations, database_id must be a real UUID (not placeholder).
    if (needsDeploy) {
      let dbId = parseFirstDatabaseId(WRANGLER_CONFIG);
      if (!isValidUuid(dbId)) {
        console.log('\nStep 4: Configure D1 database ID');
        console.log(`Current database_id is invalid or placeholder: ${dbId || '(missing)'}`);
        console.log(`Creating or resolving remote D1 database: ${dbName}`);
        const resolvedDbId = resolveRemoteDbId(dbName);
        if (!isValidUuid(resolvedDbId)) {
          throw new Error(`Could not resolve database_id for ${dbName}. Run: ${WRANGLER.command} ${[...WRANGLER.baseArgs, 'd1', 'create', dbName].join(' ')} and update wrangler.jsonc.`);
        }
        const current = fs.readFileSync(WRANGLER_CONFIG, 'utf8');
        fs.writeFileSync(WRANGLER_CONFIG, patchDbId(current, resolvedDbId), 'utf8');
        dbId = resolvedDbId;
        console.log(`✓ Updated wrangler.jsonc with database_id: ${dbId}`);
      }
    }

    if (!fs.existsSync(D1_SCHEMA_FILE)) {
      throw new Error('Missing scripts/d1-schema.sql');
    }

    if (needsDeploy) {
      console.log('\nStep 5: Cloudflare authentication');
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
      console.log('\nStep 6: Initialize local D1 schema');
      runWrangler(['d1', 'execute', dbName, '--local', '--file', 'scripts/d1-schema.sql']);

      const startDevDefaultYes = !needsDeploy;
      const startDevPrompt = startDevDefaultYes
        ? 'Start local Wrangler dev server now (freertc dev:cf)? [Y/n]: '
        : 'Start local Wrangler dev server now (freertc dev:cf)? [y/N]: ';
      const startDev = await rl.question(startDevPrompt);
      if (yes(startDev, startDevDefaultYes)) {
        run(process.execPath, [path.join(PACKAGE_ROOT, 'scripts', 'dev-server.mjs')]);
      }
    }

    if (needsDeploy) {
      console.log('\nStep 7: Initialize remote D1 schema');
      runWrangler(['d1', 'execute', dbName, '--remote', '--file', 'scripts/d1-schema.sql']);

      const doDeploy = await rl.question('Deploy now (freertc deploy)? [Y/n]: ');
      if (yes(doDeploy, true)) {
        runWrangler(['deploy', '--env', 'production']);

        console.log('\nStep 8: Verify deployment endpoint (recommended)');
        console.log('Auto-checking /health on detected domain(s)...');

        const routeHost = firstRouteHostFromWranglerConfig(WRANGLER_CONFIG);
        const hosts = [preferredHealthHost, routeHost].filter(Boolean);
        const uniqueHosts = [...new Set(hosts)];

        if (uniqueHosts.length === 0) {
          console.log('No custom domain detected in wizard input or wrangler routes.');
          console.log('Set routes in wrangler.jsonc or run manual check: curl -fsS https://<your-domain>/health');
        }

        for (const host of uniqueHosts) {
          const healthUrl = `https://${host}/health`;
          console.log(`\nChecking ${healthUrl}`);
          const health = checkHealthUrl(healthUrl);
          if (health.ok) {
            console.log('/health response:');
            console.log(health.output.trim() || '(empty body)');
          } else {
            console.log('Health check failed. Raw output:');
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
        }
      }
    }

    console.log('\nWizard completed successfully.');
    console.log('\nQuick commands:');
    console.log(`  ${WRANGLER.command} ${[...WRANGLER.baseArgs, 'd1', 'execute', dbName, '--local', '--file', 'scripts/d1-schema.sql'].join(' ')}`);
    console.log(`  ${WRANGLER.command} ${[...WRANGLER.baseArgs, 'd1', 'execute', dbName, '--remote', '--file', 'scripts/d1-schema.sql'].join(' ')}`);
    console.log('  npx freertc dev');
    console.log('  npx freertc dev:cf');
    console.log('  npx freertc deploy');
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(`\nWizard failed: ${error.message}`);
  process.exit(1);
});
