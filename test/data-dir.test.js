import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveDataDir } from '../src/node/data-dir.js';

function relay(dir, { named = false, id = 'id' } = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'relay-identity.json'), JSON.stringify({ id }));
  if (named) writeFileSync(path.join(dir, 'names.json'), JSON.stringify({ worker: 'https://w' }));
}

test('a relay keeps one folder at home, whatever folder it starts from', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dd-'));
  const home = path.join(root, 'home');
  mkdirSync(home);
  const dir = resolveDataDir({ env: {}, cwd: path.join(root, 'clone'), home, volumes: path.join(root, 'Volumes') });
  assert.equal(dir, path.join(home, '.freertc-relay'));
});

test('the first time, it takes the identity it had before, preferring one with a name', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dd-'));
  const home = path.join(root, 'home');
  relay(path.join(home, 'GitPigeon', 'freertc', '.freertc-relay'), { named: true, id: 'named' });
  const clone = path.join(root, 'Volumes', 'Ext', 'GitPigeon', 'freertc');
  relay(path.join(clone, '.freertc-relay'), { id: 'fresh' });
  const lines = [];
  const dir = resolveDataDir({ env: {}, cwd: clone, home, volumes: path.join(root, 'Volumes'), log: (l) => lines.push(l) });
  assert.equal(dir, path.join(home, '.freertc-relay'));
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'relay-identity.json'), 'utf8')).id, 'named');
  assert.ok(existsSync(path.join(dir, 'names.json')));
  assert.match(lines[0], /identity and name/);
  // Next time: home already has it.
  assert.equal(resolveDataDir({ env: {}, cwd: clone, home, volumes: path.join(root, 'Volumes') }), dir);
});

test('FREERTC_DATA_DIR still wins', () => {
  assert.equal(resolveDataDir({ env: { FREERTC_DATA_DIR: '/x/y' } }), '/x/y');
});
