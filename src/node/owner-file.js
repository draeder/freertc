// A Node relay's owner (src/relay-owner.js), kept in <data dir>/owner.json:
// { "v": 1, "owner": "<account signing key>", "at": <ms> }.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isOwnerKey } from '../relay-owner.js';

const FILE = 'owner.json';

export function readOwnerFile(dataDir) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dataDir, FILE), 'utf8'));
    return isOwnerKey(parsed?.owner) ? parsed.owner : null;
  } catch {
    return null;
  }
}

export function writeOwnerFile(dataDir, owner, now = Date.now()) {
  if (!isOwnerKey(owner)) throw new TypeError('not an account key');
  writeFileSync(path.join(dataDir, FILE), `${JSON.stringify({ v: 1, owner, at: now }, null, 2)}\n`, { mode: 0o600 });
}

export function removeOwnerFile(dataDir) {
  const file = path.join(dataDir, FILE);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}
