import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

export const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, '..');
export const PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')
).version;

export const DEPLOY_LAYOUT_DIRECTORIES = ['public', 'src', 'migrations'];
export const DEPLOY_LAYOUT_FALLBACK_DIRECTORY = 'freertc-deploy';
export const DEPLOY_LAYOUT_MARKER = '.freertc-deploy-layout.json';

const DEPLOY_LAYOUT_MARKER_BASE = {
  managedBy: 'freertc-postinstall',
  directories: DEPLOY_LAYOUT_DIRECTORIES
};

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

function copyDeployTree(sourceRoot, targetRoot, relativeDirectory, result, overwrite) {
  const sourceDirectory = path.join(sourceRoot, relativeDirectory);
  if (!fs.existsSync(sourceDirectory)) {
    return;
  }

  for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
    const relativePath = path.join(relativeDirectory, entry.name);
    const sourcePath = path.join(sourceRoot, relativePath);
    const targetPath = path.join(targetRoot, relativePath);

    if (entry.isDirectory()) {
      if (fs.existsSync(targetPath)) {
        const targetStats = fs.lstatSync(targetPath);
        if (targetStats.isSymbolicLink() || !targetStats.isDirectory()) {
          continue;
        }
      }
      fs.mkdirSync(targetPath, { recursive: true });
      copyDeployTree(sourceRoot, targetRoot, relativePath, result, overwrite);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const portableRelativePath = relativePath.split(path.sep).join('/');
    result.files.push(portableRelativePath);

    if (fs.existsSync(targetPath)) {
      if (!overwrite) {
        continue;
      }
      const targetStats = fs.lstatSync(targetPath);
      if (targetStats.isDirectory()) {
        continue;
      }
      if (targetStats.isSymbolicLink()) {
        fs.unlinkSync(targetPath);
      }
      fs.copyFileSync(sourcePath, targetPath);
      result.updated.push(portableRelativePath);
      continue;
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
    result.copied.push(portableRelativePath);
  }
}

function directoryContainsFiles(directory) {
  if (!fs.existsSync(directory)) {
    return false;
  }
  const stats = fs.lstatSync(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    return true;
  }

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile() || entry.isSymbolicLink()) {
      return true;
    }
    if (entry.isDirectory() && directoryContainsFiles(path.join(directory, entry.name))) {
      return true;
    }
  }
  return false;
}

function deployPathsAreOccupied(targetRoot) {
  return DEPLOY_LAYOUT_DIRECTORIES.some((directory) =>
    directoryContainsFiles(path.join(targetRoot, directory))
  );
}

function readDeployLayoutMarker(targetRoot) {
  const markerPath = path.join(targetRoot, DEPLOY_LAYOUT_MARKER);
  if (!fs.existsSync(markerPath)) {
    return null;
  }

  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    return marker?.managedBy === DEPLOY_LAYOUT_MARKER_BASE.managedBy
      ? marker
      : null;
  } catch {
    return null;
  }
}

function isManagedDeployLayout(targetRoot) {
  return readDeployLayoutMarker(targetRoot) !== null;
}

function isSafeManagedFile(relativePath) {
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath)) {
    return false;
  }
  const normalized = relativePath.replaceAll('\\', '/');
  if (normalized.includes('../') || normalized === '..') {
    return false;
  }
  return DEPLOY_LAYOUT_DIRECTORIES.some((directory) =>
    normalized.startsWith(`${directory}/`)
  );
}

function removeStaleManagedFiles(targetRoot, previousFiles, currentFiles, removed) {
  if (!Array.isArray(previousFiles)) {
    return;
  }

  const current = new Set(currentFiles);
  for (const relativePath of previousFiles) {
    if (!isSafeManagedFile(relativePath) || current.has(relativePath)) {
      continue;
    }
    const targetPath = path.join(targetRoot, ...relativePath.split('/'));
    if (!fs.existsSync(targetPath)) {
      continue;
    }
    const stats = fs.lstatSync(targetPath);
    if (stats.isFile() || stats.isSymbolicLink()) {
      fs.unlinkSync(targetPath);
      removed.push(relativePath);
    }
  }
}

function fallbackDirectoryIsAvailable(targetRoot) {
  if (!fs.existsSync(targetRoot)) {
    return true;
  }
  const stats = fs.lstatSync(targetRoot);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    return false;
  }
  return fs.readdirSync(targetRoot).length === 0 || isManagedDeployLayout(targetRoot);
}

export function resolveDeployLayoutRoot(projectRoot) {
  const targetRoot = path.resolve(projectRoot);
  if (isManagedDeployLayout(targetRoot) || !deployPathsAreOccupied(targetRoot)) {
    return targetRoot;
  }

  let suffix = 1;
  while (true) {
    const directoryName = suffix === 1
      ? DEPLOY_LAYOUT_FALLBACK_DIRECTORY
      : `${DEPLOY_LAYOUT_FALLBACK_DIRECTORY}-${suffix}`;
    const candidate = path.join(targetRoot, directoryName);
    if (fallbackDirectoryIsAvailable(candidate)) {
      return candidate;
    }
    suffix += 1;
  }
}

export function materializeDeployLayout(projectRoot) {
  const requestedRoot = path.resolve(projectRoot);
  if (requestedRoot === PACKAGE_ROOT) {
    return {
      targetRoot: requestedRoot,
      packageVersion: PACKAGE_VERSION,
      upgradedFrom: null,
      copied: [],
      updated: [],
      removed: []
    };
  }

  const targetRoot = resolveDeployLayoutRoot(requestedRoot);
  const previousMarker = readDeployLayoutMarker(targetRoot);
  const isVersionChange = Boolean(
    previousMarker && previousMarker.packageVersion !== PACKAGE_VERSION
  );
  const result = { files: [], copied: [], updated: [], removed: [] };
  for (const directory of DEPLOY_LAYOUT_DIRECTORIES) {
    copyDeployTree(PACKAGE_ROOT, targetRoot, directory, result, isVersionChange);
  }
  removeStaleManagedFiles(
    targetRoot,
    previousMarker?.files,
    result.files,
    result.removed
  );

  const markerPath = path.join(targetRoot, DEPLOY_LAYOUT_MARKER);
  const nextMarker = {
    ...DEPLOY_LAYOUT_MARKER_BASE,
    packageVersion: PACKAGE_VERSION,
    files: result.files.sort()
  };
  fs.writeFileSync(markerPath, `${JSON.stringify(nextMarker, null, 2)}\n`);

  return {
    targetRoot,
    packageVersion: PACKAGE_VERSION,
    upgradedFrom: isVersionChange
      ? previousMarker.packageVersion || 'unknown'
      : null,
    copied: result.copied,
    updated: result.updated,
    removed: result.removed
  };
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
