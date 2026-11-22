#!/usr/bin/env node
// npx freertc claim <account key>              this machine's relay is yours
// npx freertc claim <account key> --worker <n> your FreeRTC Worker <n> is yours (a Worker secret)
// npx freertc claim --remove [--worker <n>]    nobody's
//
// The key is your PigeonIdP account's signing key, shown on console.peerpigeon.io
// under Relays → Add. The relay then answers GET /api/v1/owner with it, signed
// by the relay (src/relay-owner.js), and the console lists the relay as yours.
// A running Node relay picks it up at once; a Worker takes it with its next request.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from '../src/node/data-dir.js';
import { removeOwnerFile, writeOwnerFile } from '../src/node/owner-file.js';
import { createRelayIdentity, decodeRelayIdentitySecret } from '../src/relay-identity.js';
import { isOwnerKey } from '../src/relay-owner.js';

const say = (line) => console.log(`[freertc claim] ${line}`);
const args = process.argv.slice(2);
const remove = args.includes('--remove');
const workerAt = args.indexOf('--worker');
const worker = workerAt >= 0 ? args[workerAt + 1] : null;
const key = args.find((a, i) => !a.startsWith('--') && (workerAt < 0 || i !== workerAt + 1));

if (workerAt >= 0 && !worker) {
  say('--worker needs the Worker\'s name (as in its wrangler.jsonc).');
  process.exit(1);
}
if (!remove && !isOwnerKey(key)) {
  say('Give the account key the console shows (Relays → Add): npx freertc claim <key>');
  process.exit(1);
}

if (worker) {
  const wrangler = (secretArgs, input) => spawnSync('npx', ['wrangler', 'secret', ...secretArgs, '--name', worker], { input, stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'] });
  const result = remove ? wrangler(['delete', 'RELAY_OWNER']) : wrangler(['put', 'RELAY_OWNER'], `${key}\n`);
  if (result.status !== 0) {
    say(`wrangler could not ${remove ? 'remove' : 'set'} the Worker's RELAY_OWNER secret.`);
    process.exit(result.status ?? 1);
  }
  say(remove ? `${worker} has no owner now.` : `${worker} is yours. Back in the console, press Check.`);
  process.exit(0);
}

const dataDir = resolveDataDir({ log: say });
if (remove) {
  say(removeOwnerFile(dataDir) ? 'This relay has no owner now.' : 'This relay had no owner.');
  process.exit(0);
}
mkdirSync(dataDir, { recursive: true });
writeOwnerFile(dataDir, key);
let nodeId = null;
try {
  const file = path.join(dataDir, 'relay-identity.json');
  if (existsSync(file)) {
    const { publicKey, privateKey } = decodeRelayIdentitySecret(readFileSync(file, 'utf8').trim());
    ({ nodeId } = await createRelayIdentity(publicKey, privateKey));
  }
} catch { /* shown without it */ }
say(`This relay${nodeId ? ` (${nodeId.slice(0, 16)}…)` : ''} is yours (${path.join(dataDir, 'owner.json')}).`);
say(nodeId ? 'Back in the console, press Check.' : 'Start it (npx freertc dev), then press Check in the console.');
