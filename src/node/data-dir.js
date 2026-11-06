// Where a Node relay keeps its identity, name, certificate and database: one
// folder per user (~/.freertc-relay), wherever the relay is started from, so a
// relay keeps its id and its https name across clones, folders and drives.
//
// FREERTC_DATA_DIR still chooses another folder. The first time the home
// folder has no identity, the relay looks for one it had before (a
// .freertc-relay folder next to a freertc clone, in the home folder or on an
// attached drive), prefers one with a name (names.json), and copies it home.
import { cpSync, existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FOLDER = '.freertc-relay';
const SKIP = new Set(['node_modules', 'Library', '.Trash', '.git', '.npm', '.cache', '.nvm', '.cargo', '.rustup', 'Applications']);

function relayFolders(root, depth, out) {
  if (depth < 0) return;
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    if (entry.name === FOLDER) {
      if (existsSync(path.join(full, 'relay-identity.json'))) out.push(full);
      continue;
    }
    if (SKIP.has(entry.name) || (entry.name.startsWith('.') && entry.name !== FOLDER)) continue;
    relayFolders(full, depth - 1, out);
  }
}

function mtime(file) {
  try { return statSync(file).mtimeMs; } catch { return 0; }
}

/**
 * The relay's data folder. `log` hears where an earlier identity was found.
 */
export function resolveDataDir({ env = process.env, cwd = process.cwd(), home = os.homedir(), volumes = '/Volumes', log = () => {} } = {}) {
  if (env.FREERTC_DATA_DIR) return path.resolve(env.FREERTC_DATA_DIR);
  const dir = path.join(home, FOLDER);
  if (existsSync(path.join(dir, 'relay-identity.json'))) return dir;

  // None at home yet: the one this relay had before, if any.
  const found = [];
  if (existsSync(path.join(cwd, FOLDER, 'relay-identity.json'))) found.push(path.join(cwd, FOLDER));
  relayFolders(home, 4, found);
  let drives = [];
  try { drives = readdirSync(volumes).map((name) => path.join(volumes, name)); } catch { /* not a Mac */ }
  for (const drive of drives) relayFolders(drive, 4, found);
  const unique = [...new Set(found)].filter((f) => f !== dir);
  unique.sort((a, b) => {
    const named = Number(existsSync(path.join(b, 'names.json'))) - Number(existsSync(path.join(a, 'names.json')));
    return named || mtime(path.join(b, 'relay-identity.json')) - mtime(path.join(a, 'relay-identity.json'));
  });
  if (unique[0]) {
    try {
      cpSync(unique[0], dir, { recursive: true, errorOnExist: false, force: false });
      log(`kept this relay's identity${existsSync(path.join(dir, 'names.json')) ? ' and name' : ''} from ${unique[0]} in ${dir}`);
    } catch (error) {
      log(`could not copy ${unique[0]} (${error?.message || error}); using it where it is`);
      return unique[0];
    }
  }
  return dir;
}
