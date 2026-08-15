import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ensureLocalRelayIdentity } from '../scripts/dev-server.mjs';
import { createRelayIdentity, decodeRelayIdentitySecret } from '../src/relay-identity.js';

test('local setup creates one ignored-style identity and preserves it on later starts', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'freertc-local-identity-'));
  const secretsFile = path.join(directory, '.dev.vars');

  try {
    await writeFile(secretsFile, 'EXISTING_VALUE=preserved\n', 'utf8');
    await ensureLocalRelayIdentity(secretsFile);
    const first = await readFile(secretsFile, 'utf8');
    await ensureLocalRelayIdentity(secretsFile);
    const second = await readFile(secretsFile, 'utf8');
    const gitignore = await readFile(path.join(directory, '.gitignore'), 'utf8');

    assert.equal(second, first);
    assert.equal(gitignore, '.dev.vars\n');
    assert.match(first, /^EXISTING_VALUE=preserved$/m);
    const match = first.match(/^RELAY_IDENTITY_SECRET='(.+)'$/m);
    assert.ok(match);

    const identity = decodeRelayIdentitySecret(match[1]);
    const verified = await createRelayIdentity(identity.publicKey, identity.privateKey);
    assert.match(verified.nodeId, /^[0-9a-f]{64}$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
