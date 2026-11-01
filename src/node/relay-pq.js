// A local relay's post-quantum key, and the post-quantum keys of the local
// relays it has linked with (Node only).
//
// The key is an ML-DSA-65 seed kept in <data dir>/relay-pq.json, made on first
// start; with the relay's P-256 keys it signs hybrid (unsea 3), so the relay's
// node id (from its P-256 key) is unchanged. A link answer and a directory
// listing carry the relay's post-quantum public key and a hybrid signature.
//
// Pins: the first post-quantum key a linked relay shows for its node id is
// kept in <data dir>/relay-pins.json, and from then on a link from that node
// id must prove that same key. So someone who could forge the relay's P-256
// signature (a quantum computer) still cannot pose as it: they would need its
// ML-DSA key as well. The link itself is encrypted end to end with keys bound
// to those signatures (link-crypto.js), so passing the handshake along from
// the middle gains nothing either. A relay is protected from the first link
// that pins it, not before.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { upgradePair } from 'unsea';

const KEY_FILE = 'relay-pq.json';
const PINS_FILE = 'relay-pins.json';

function writeAtomic(file, text) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, file);
}

/** { pub, priv, qpub, qpriv } for this relay: its P-256 keys and its post-quantum key. */
export function loadRelayPqIdentity(dataDir, { publicKey, privateKey, nodeId }) {
  const file = path.join(dataDir, KEY_FILE);
  let seeds = null;
  if (existsSync(file)) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      // Kept per node id: a relay given a new P-256 identity gets a new key too.
      if (saved?.v === 1 && saved.node_id === nodeId && typeof saved.qpriv === 'string' && typeof saved.kpriv === 'string') {
        seeds = { qpriv: saved.qpriv, kpriv: saved.kpriv };
      }
    } catch { /* made again below */ }
  }
  const pair = upgradePair({ pub: publicKey, priv: privateKey, ...(seeds || {}) });
  if (!seeds) writeAtomic(file, JSON.stringify({ v: 1, node_id: nodeId, qpriv: pair.qpriv, kpriv: pair.kpriv }));
  return { pub: pair.pub, priv: pair.priv, qpub: pair.qpub, qpriv: pair.qpriv };
}

/** The post-quantum keys seen for other relays' node ids, kept across restarts. */
export function loadRelayPins(dataDir) {
  const file = path.join(dataDir, PINS_FILE);
  const pins = new Map();
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    for (const [nodeId, qpub] of Object.entries(saved?.pins || {})) {
      if (typeof qpub === 'string') pins.set(nodeId, qpub);
    }
  } catch { /* none yet */ }
  return {
    get: (nodeId) => pins.get(nodeId) ?? null,
    set: (nodeId, qpub) => {
      if (pins.get(nodeId) === qpub) return;
      pins.set(nodeId, qpub);
      writeAtomic(file, JSON.stringify({ v: 1, pins: Object.fromEntries(pins) }));
    },
    size: () => pins.size,
  };
}
