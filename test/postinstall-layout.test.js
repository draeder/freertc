import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('postinstall isolates the deploy layout when project paths are occupied', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freertc-postinstall-'));
  const existingIndex = '<h1>installer-owned page</h1>\n';

  try {
    fs.mkdirSync(path.join(projectRoot, 'public'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'public/index.html'), existingIndex);

    const install = spawnSync(
      process.execPath,
      [path.join(ROOT, 'scripts/postinstall-message.mjs')],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          INIT_CWD: projectRoot,
          npm_config_global: 'false'
        },
        encoding: 'utf8'
      }
    );

    assert.equal(install.status, 0, install.stderr);
    assert.match(install.stdout, /Materialized deploy layout/);
    assert.match(install.stdout, /freertc-deploy/);
    assert.equal(
      fs.readFileSync(path.join(projectRoot, 'public/index.html'), 'utf8'),
      existingIndex,
      'postinstall must preserve installer-owned files'
    );
    assert.equal(fs.existsSync(path.join(projectRoot, 'public/app.js')), false);

    const deployRoot = path.join(projectRoot, 'freertc-deploy');
    assert.equal(fs.existsSync(path.join(deployRoot, 'public/app.js')), true);
    assert.equal(fs.existsSync(path.join(deployRoot, 'src/index.js')), true);
    assert.equal(fs.existsSync(path.join(deployRoot, 'src/relay-overlay.js')), true);
    assert.equal(fs.existsSync(path.join(deployRoot, 'migrations/0001_initial.sql')), true);
    assert.equal(fs.existsSync(path.join(projectRoot, 'wrangler.jsonc')), false);
    assert.equal(fs.existsSync(path.join(projectRoot, 'wrangler.workers-dev.jsonc')), false);
    assert.equal(fs.existsSync(path.join(deployRoot, 'wrangler.jsonc')), false);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('postinstall uses an unoccupied project root and reuses its managed layout', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freertc-postinstall-clean-'));
  const runInstall = () => spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts/postinstall-message.mjs')],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        INIT_CWD: projectRoot,
        npm_config_global: 'false'
      },
      encoding: 'utf8'
    }
  );

  try {
    const firstInstall = runInstall();
    assert.equal(firstInstall.status, 0, firstInstall.stderr);
    assert.equal(fs.existsSync(path.join(projectRoot, 'public/app.js')), true);
    assert.equal(fs.existsSync(path.join(projectRoot, 'src/index.js')), true);
    assert.equal(fs.existsSync(path.join(projectRoot, 'migrations/0001_initial.sql')), true);

    const secondInstall = runInstall();
    assert.equal(secondInstall.status, 0, secondInstall.stderr);
    assert.equal(fs.existsSync(path.join(projectRoot, 'freertc-deploy')), false);

    const markerPath = path.join(projectRoot, '.freertc-deploy-layout.json');
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(marker.packageVersion, packageJson.version);

    const managedFile = path.join(projectRoot, 'src/index.js');
    const staleManagedFile = path.join(projectRoot, 'src/removed-from-new-version.js');
    const userFile = path.join(projectRoot, 'src/installer-owned.js');
    fs.writeFileSync(managedFile, '// old FreeRTC source\n');
    fs.writeFileSync(staleManagedFile, '// stale managed source\n');
    fs.writeFileSync(userFile, '// installer-owned source\n');
    fs.writeFileSync(markerPath, `${JSON.stringify({
      ...marker,
      packageVersion: '0.1.0',
      files: [...marker.files, 'src/removed-from-new-version.js']
    }, null, 2)}\n`);

    const upgradeInstall = runInstall();
    assert.equal(upgradeInstall.status, 0, upgradeInstall.stderr);
    assert.match(upgradeInstall.stdout, /from FreeRTC 0\.1\.0/);
    assert.equal(
      fs.readFileSync(managedFile, 'utf8'),
      fs.readFileSync(path.join(ROOT, 'src/index.js'), 'utf8')
    );
    assert.equal(fs.existsSync(staleManagedFile), false);
    assert.equal(fs.readFileSync(userFile, 'utf8'), '// installer-owned source\n');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
