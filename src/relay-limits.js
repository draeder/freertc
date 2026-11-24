// What one address may ask of a relay, and the owner's load-test pass that lifts it.
//
// A relay only introduces peers: once they are linked, they talk to each other, not
// through it. So nothing caps a room, a mesh or the peers a relay serves. What one
// address may do is rate-limited, generously, since a carrier or a school can put
// thousands of people behind one address:
//
//   new connections from one address a minute      RELAY_NEW_CONNECTIONS_PER_MINUTE (600)
//   messages from one address a second             RELAY_MESSAGES_PER_SECOND (500; bursts to twice that)
//
// And only when the relay is busy does it hold anyone back by how much they hold:
//
//   busy at this many connections                  RELAY_BUSY_CONNECTIONS (2,000)
//   then, an address with this many already       RELAY_BUSY_PER_ADDRESS (32)
//     opens no more until the relay is less busy
//   none at all past                               RELAY_MAX_CONNECTIONS (none)
//
// (0 turns one off.) A new connection over a limit is refused (429); a message over
// the rate is dropped, and the sender told (at most once a second).
//
// A relay's owner may test it with more: a load-test pass, signed with the owner's key
// (console.peerpigeon.io makes it), names the relay's node id and when it runs out.
//
//   pass text:  [ 'freertc-load-test', 1, <node id>, <until ms> ]
//   on the socket:  /ws?load_test=<until>.<signature>
//
// A socket with a pass is not counted or limited, and stays on this relay: its peers
// are not published to the federation, not listed to other relays, and what they send
// is never forwarded to another relay. A load test is the owner's own relay's cost,
// nobody else's.
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

const DEFAULTS = {
  RELAY_NEW_CONNECTIONS_PER_MINUTE: 600,
  RELAY_MESSAGES_PER_SECOND: 500,
  RELAY_BUSY_CONNECTIONS: 2000,
  RELAY_BUSY_PER_ADDRESS: 32,
  RELAY_MAX_CONNECTIONS: 0,
};

function limitOf(env, name) {
  const raw = env?.[name];
  if (raw === undefined || raw === null || raw === '') return DEFAULTS[name];
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULTS[name];
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
  let total = 0; // counted sockets open
  const sockets = new Map(); // address -> open sockets
  const opened = new Map(); // address -> times of sockets opened in the last minute
  const buckets = new Map(); // address -> { tokens, at } for messages

  const bump = (address, by) => {
    total = Math.max(0, total + by);
    if (!address) return;
    const n = (sockets.get(address) ?? 0) + by;
    if (n > 0) sockets.set(address, n); else sockets.delete(address);
  };
  const capped = (map) => { if (map.size > 100_000) map.delete(map.keys().next().value); };
  const say = (text) => `${text} A relay's owner can load-test it with a pass from console.peerpigeon.io.`;

  return {
    /** A socket from `address` may open now: { ok } or { ok: false, error }. Counts it when ok. */
    admit(env, address, now = Date.now()) {
      const most = limitOf(env, 'RELAY_MAX_CONNECTIONS');
      if (most && total >= most) return { ok: false, error: say('This relay is full: try another.') };
      if (address) {
        const perMinute = limitOf(env, 'RELAY_NEW_CONNECTIONS_PER_MINUTE');
        const recent = (opened.get(address) ?? []).filter((at) => now - at < 60_000);
        if (perMinute && recent.length >= perMinute) {
          opened.set(address, recent);
          return { ok: false, error: say(`More than ${perMinute} new connections a minute from one address: wait a minute.`) };
        }
        const busy = limitOf(env, 'RELAY_BUSY_CONNECTIONS');
        const perAddress = limitOf(env, 'RELAY_BUSY_PER_ADDRESS');
        if (busy && perAddress && total >= busy && (sockets.get(address) ?? 0) >= perAddress) {
          return { ok: false, error: say(`This relay is busy, and ${perAddress} connections from one address are all it takes now: try again later, or another relay.`) };
        }
        recent.push(now);
        opened.set(address, recent);
        capped(opened);
      }
      bump(address, 1);
      return { ok: true };
    },
    /** A socket admit() counted has closed. */
    release(address) { bump(address, -1); },
    /** A socket that was open before the object hibernated: counted again, no questions. */
    restore(address) { bump(address, 1); },
    /** Forget every count (before restore() rebuilds them). */
    clear() { total = 0; sockets.clear(); },
    /** One message from `address` may pass now (a bucket per address: the rate, bursting to twice it). */
    message(env, address, now = Date.now()) {
      if (!address) return true;
      const rate = limitOf(env, 'RELAY_MESSAGES_PER_SECOND');
      if (!rate) return true;
      const burst = rate * 2;
      const bucket = buckets.get(address) ?? { tokens: burst, at: now };
      bucket.tokens = Math.min(burst, bucket.tokens + ((now - bucket.at) / 1000) * rate);
      bucket.at = now;
      buckets.set(address, bucket);
      capped(buckets);
      if (bucket.tokens < 1) return false;
      bucket.tokens -= 1;
      return true;
    },
    /** For tests and /debug: the counts now. */
    counts() { return { total, sockets: Object.fromEntries(sockets) }; },
  };
}
