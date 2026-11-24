// How much one address may ask of a relay, and the owner's load-test pass that lifts it.
//
// Many peers from one machine (a load test, a script) could use up a public relay's
// daily limits and slow every app on it. Real people each come from their own address,
// so a relay counts per address, not per room or in total, and a popular app is never
// held back:
//
//   - sockets open at once from one address           RELAY_MAX_SOCKETS_PER_ADDRESS (64)
//   - peers from one address in one room               RELAY_MAX_PEERS_PER_ADDRESS_ROOM (16)
//   - new sockets from one address in a minute         RELAY_MAX_NEW_SOCKETS_PER_MINUTE (60)
//
// (0 turns one off.) Over a limit, the relay refuses: a socket with 429 before it opens,
// a peer joining a room with an error and a close (4008).
//
// A relay's owner may test it with more: a load-test pass, signed with the owner's key
// (console.peerpigeon.io makes it), names the relay's node id and when it runs out.
//
//   pass text:  [ 'freertc-load-test', 1, <node id>, <until ms> ]
//   on the socket:  /ws?load_test=<until>.<signature>
//
// A socket with a pass is not counted, and stays on this relay: its peers are not
// published to the federation, not listed to other relays, and what they send is never
// forwarded to another relay. A load test is the owner's own relay's cost, nobody else's.
import { verifyMessage } from 'unsea';
import { canonicalJson } from './kademlia.js';
import { configuredOwner } from './relay-owner.js';

export const loadTestText = (nodeId, until) => canonicalJson(['freertc-load-test', 1, nodeId, until]);
/** The longest a pass may run, from when the relay sees it. */
export const LOAD_TEST_MAX_MS = 24 * 60 * 60_000;

/** `<until>.<signature>` → { until, sig }, or null. */
export function parseLoadTestPass(value) {
  if (typeof value !== 'string' || value.length > 4200) return null;
  const dot = value.indexOf('.');
  if (dot <= 0) return null;
  const until = Number(value.slice(0, dot));
  const sig = value.slice(dot + 1);
  if (!Number.isSafeInteger(until) || !sig) return null;
  return { until, sig };
}

export const formatLoadTestPass = (until, sig) => `${until}.${sig}`;

/** Whether `pass` is this relay's owner's, for this relay, and running now. */
export async function loadTestHolds(env, nodeId, pass, now = Date.now()) {
  if (!pass || !nodeId) return false;
  if (pass.until <= now || pass.until - now > LOAD_TEST_MAX_MS) return false;
  const owner = await configuredOwner(env);
  if (!owner) return false;
  try { return await verifyMessage(loadTestText(nodeId, pass.until), pass.sig, owner); } catch { return false; }
}

const DEFAULTS = { sockets: 64, room: 16, perMinute: 60 };

function limitOf(env, name, fallback) {
  const raw = env?.[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * The address a socket came from. A Worker has it from Cloudflare (CF-Connecting-IP,
 * which a client cannot set); a Node relay names the header it writes itself
 * (env.CLIENT_ADDRESS_HEADER), after dropping any the client sent. null: not known
 * (a socket that did not come over the network as an upgrade), and not counted.
 */
export function clientAddressOf(request, env) {
  const header = env?.CLIENT_ADDRESS_HEADER || 'cf-connecting-ip';
  const value = request?.headers?.get?.(header);
  return value ? String(value).trim().toLowerCase().replace(/^::ffff:/, '') : null;
}

/** The counts, per relay (one per isolate or process: the one holding the sockets). */
export function createRelayLimits() {
  const sockets = new Map(); // address -> open sockets
  const rooms = new Map(); // address + '\n' + scope -> peers
  const opened = new Map(); // address -> times of sockets opened in the last minute

  const bump = (map, key, by) => {
    const n = (map.get(key) ?? 0) + by;
    if (n > 0) map.set(key, n); else map.delete(key);
  };

  return {
    /** A socket from `address` may open now: { ok } or { ok: false, error }. Counts it when ok. */
    admit(env, address, now = Date.now()) {
      if (!address) return { ok: true };
      const most = limitOf(env, 'RELAY_MAX_SOCKETS_PER_ADDRESS', DEFAULTS.sockets);
      const perMinute = limitOf(env, 'RELAY_MAX_NEW_SOCKETS_PER_MINUTE', DEFAULTS.perMinute);
      const recent = (opened.get(address) ?? []).filter((at) => now - at < 60_000);
      if (perMinute && recent.length >= perMinute) {
        opened.set(address, recent);
        return { ok: false, error: `More than ${perMinute} connections a minute from one address: wait a minute. A relay's owner can load-test it with a pass from console.peerpigeon.io.` };
      }
      if (most && (sockets.get(address) ?? 0) >= most) {
        return { ok: false, error: `More than ${most} connections at once from one address. A relay's owner can load-test it with a pass from console.peerpigeon.io.` };
      }
      recent.push(now);
      opened.set(address, recent);
      if (opened.size > 50_000) opened.delete(opened.keys().next().value);
      bump(sockets, address, 1);
      return { ok: true };
    },
    /** The socket admit() counted has closed. */
    release(address) {
      if (address) bump(sockets, address, -1);
    },
    /** A peer from `address` may join `scope` (its network and room): counts it when ok. */
    join(env, address, scope) {
      if (!address) return { ok: true };
      const most = limitOf(env, 'RELAY_MAX_PEERS_PER_ADDRESS_ROOM', DEFAULTS.room);
      const key = `${address}\n${scope}`;
      if (most && (rooms.get(key) ?? 0) >= most) {
        return { ok: false, error: `More than ${most} peers in one room from one address. A relay's owner can load-test it with a pass from console.peerpigeon.io.` };
      }
      bump(rooms, key, 1);
      return { ok: true };
    },
    leave(address, scope) {
      if (address && scope) bump(rooms, `${address}\n${scope}`, -1);
    },
    /** For tests and /debug: the counts now. */
    counts() {
      return { sockets: Object.fromEntries(sockets), rooms: Object.fromEntries(rooms) };
    },
  };
}
