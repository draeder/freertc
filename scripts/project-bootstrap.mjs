import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

export const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, '..');

const PROJECT_FILE_MAPPINGS = [
  ['src/index.js', 'src/index.js'],
  ['src/kademlia.js', 'src/kademlia.js'],
  ['src/relay-identity.js', 'src/relay-identity.js'],
  ['src/relay-overlay.js', 'src/relay-overlay.js'],
  ['public/index.html', 'public/index.html'],
  ['public/app.js', 'public/app.js'],
  ['migrations/0001_initial.sql', 'migrations/0001_initial.sql'],
  ['migrations/0002_kademlia_overlay.sql', 'migrations/0002_kademlia_overlay.sql'],
  ['scripts/d1-schema.sql', 'scripts/d1-schema.sql'],
  ['scripts/deploy-cloudflare.mjs', 'scripts/deploy-cloudflare.mjs'],
  ['scripts/project-bootstrap.mjs', 'scripts/project-bootstrap.mjs'],
  ['wrangler.template.jsonc', 'wrangler.template.jsonc'],
  ['wrangler.workers-dev.jsonc', 'wrangler.workers-dev.jsonc']
];

function looksLikeProjectRoot(dir) {
  const hasPackage = fs.existsSync(path.join(dir, 'package.json'));
  const hasWranglerConfig = fs.existsSync(path.join(dir, 'wrangler.jsonc'));
  const hasWranglerTemplate = fs.existsSync(path.join(dir, 'wrangler.template.jsonc'));
  return hasPackage && (hasWranglerConfig || hasWranglerTemplate);
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

export function resolveProjectRoot(startDir = process.cwd()) {
  return (
    findProjectRoot(startDir) ||
    findNearestPackageRoot(startDir) ||
    path.resolve(startDir)
  );
}

export function ensureProjectFiles(projectRoot) {
  const targetRoot = path.resolve(projectRoot);
  if (targetRoot === PACKAGE_ROOT) {
    return [];
  }

  const copied = [];

  for (const [sourceRelativePath, targetRelativePath] of PROJECT_FILE_MAPPINGS) {
    const sourcePath = path.join(PACKAGE_ROOT, sourceRelativePath);
    const targetPath = path.join(targetRoot, targetRelativePath);

    if (fs.existsSync(targetPath) || !fs.existsSync(sourcePath)) {
      continue;
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
    copied.push(targetRelativePath);
  }

  return copied;
}

export function resolveWranglerCommand(cwd = process.cwd()) {
  const packageBinary = path.join(
    PACKAGE_ROOT,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler'
  );

  if (fs.existsSync(packageBinary)) {
    const packageCheck = spawnSync(packageBinary, ['--version'], {
      cwd,
      stdio: 'ignore'
    });
    if (packageCheck.status === 0) {
      return { command: packageBinary, baseArgs: [], source: 'package' };
    }
  }

  const globalCheck = spawnSync('wrangler', ['--version'], {
    cwd,
    stdio: 'ignore'
  });
  if (globalCheck.status === 0) {
    return { command: 'wrangler', baseArgs: [], source: 'global' };
  }

  return { command: 'npx', baseArgs: ['wrangler'], source: 'npx' };
}
