// Who runs this relay, for the PeerPigeon console (console.peerpigeon.io).
//
// An owner is the signing key of a PigeonIdP account. Whoever controls the
// relay names it: `npx freertc claim <key>` writes it to the relay's data
// folder (<data dir>/owner.json), and a Worker takes it from its RELAY_OWNER
// secret. Anyone can then ask the relay who owns it:
//
//   GET /api/v1/owner?nonce=<16-64 characters>
//   -> { ok, node_id, relay_pub, owner, nonce, signature }
//
// The relay signs [ 'freertc-owner', 1, node_id, owner, nonce ] with its own
// signing key, so the answer proves the relay with that node id names that
// owner now: a stale answer cannot be replayed (the asker picks the nonce), and
// nobody but the relay's operator can change the owner. The relay keeps no
// account, password or anything else about the owner: just the key it was told.
import { signMessage, verifyMessage } from 'unsea';
import { canonicalJson, relayNodeId } from './kademlia.js';
import { createRelayIdentity, decodeRelayIdentitySecret } from './relay-identity.js';

const NONCE_RE = /^[\w-]{16,64}$/;
// An unsea public key: base64url halves joined by a dot (P-256 x.y).
const OWNER_RE = /^[\w-]{20,100}\.[\w-]{20,100}$/;

export const isOwnerKey = (value) => typeof value === 'string' && OWNER_RE.test(value);
export const ownerText = (nodeId, owner, nonce) => canonicalJson(['freertc-owner', 1, nodeId, owner, nonce]);

const identities = new WeakMap();

async function identityOf(env) {
  const secret = env?.RELAY_IDENTITY_SECRET || env?.OWNER_IDENTITY_SECRET;
  const keys = secret
    ? decodeRelayIdentitySecret(secret)
    : env?.RELAY_SIGNING_PUBLIC_KEY && env?.RELAY_SIGNING_PRIVATE_KEY
      ? { publicKey: env.RELAY_SIGNING_PUBLIC_KEY, privateKey: env.RELAY_SIGNING_PRIVATE_KEY }
      : null;
  if (!keys) return null;
  if (!identities.has(env)) identities.set(env, createRelayIdentity(keys.publicKey, keys.privateKey));
  return identities.get(env);
}

/** This relay's node id, as its owner answers give it (with federation off too), or null. */
export async function ownNodeId(env) {
  try { return (await identityOf(env))?.nodeId ?? null; } catch { return null; }
}

/** The owner this relay was told, or null. RELAY_OWNER is a key, or (a Node relay) a function reading one. */
export async function configuredOwner(env) {
  const value = typeof env?.RELAY_OWNER === 'function' ? await env.RELAY_OWNER() : env?.RELAY_OWNER;
  const owner = typeof value === 'string' ? value.trim() : '';
  return isOwnerKey(owner) ? owner : null;
}

/** The answer to GET /api/v1/owner. */
export async function ownerProof(env, nonce) {
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return { status: 400, body: { ok: false, error: 'nonce: 16 to 64 letters, digits, - or _' } };
  let identity = null;
  try { identity = await identityOf(env); } catch { identity = null; }
  if (!identity) return { status: 200, body: { ok: false, error: 'no identity' } };
  const owner = await configuredOwner(env);
  if (!owner) return { status: 200, body: { ok: true, node_id: identity.nodeId, owner: null } };
  const signature = await signMessage(ownerText(identity.nodeId, owner, nonce), identity.privateKey);
  return { status: 200, body: { ok: true, node_id: identity.nodeId, relay_pub: identity.publicKey, owner, nonce, signature } };
}

/**
 * Whether an answer proves that the relay with `nodeId` names `owner`, for the nonce the asker sent.
 * Used by the console; here so both sides share one definition.
 */
export async function verifyOwnerProof(proof, { nonce, nodeId, owner }) {
  if (!proof?.ok || proof.nonce !== nonce || proof.owner !== owner || !isOwnerKey(owner)) return false;
  if (typeof proof.relay_pub !== 'string' || typeof proof.signature !== 'string') return false;
  if (await relayNodeId(proof.relay_pub) !== proof.node_id) return false;
  if (nodeId && proof.node_id !== nodeId) return false;
  try { return await verifyMessage(ownerText(proof.node_id, owner, nonce), proof.signature, proof.relay_pub); } catch { return false; }
}

/**
 * What an owner signs to read the relay's numbers from elsewhere (GET /api/v1/stats?at=<ms>&sig=<sig>, a
 * Node relay): good for this relay only, for five minutes.
 */
export const ownerStatsText = (nodeId, at) => canonicalJson(['freertc-owner-stats', 1, nodeId, at]);
const OWNER_ASK_SKEW_MS = 5 * 60_000;

/**
 * A pass the owner gives someone on their team (console.peerpigeon.io): `member` may read the numbers the
 * owner may. `until` is 0 for a pass that lasts until the owner takes it back (below), else a time (ms).
 * The owner signs it; the member then signs each ask with their own key.
 */
export const grantText = (owner, member, until) => canonicalJson(['pp-console-grant', 1, owner, member, until]);

/**
 * Taking a pass back: the owner signs [ 'freertc-owner-revoke', 1, node id, member, at, restore ] and posts
 * it to POST /api/v1/owner/revoke. The relay keeps the member's key on a list for that owner (its database,
 * table relay_owner_revoked: owner, member, when) and no longer answers that member's asks. restore: true
 * takes the key off the list (someone let back in).
 */
export const revokeText = (nodeId, member, at, restore) => canonicalJson(['freertc-owner-revoke', 1, nodeId, member, at, Boolean(restore)]);
const REVOKED_TABLE = 'relay_owner_revoked';

async function revokedTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS ${REVOKED_TABLE} (owner TEXT NOT NULL, member TEXT NOT NULL, at_ms INTEGER NOT NULL, PRIMARY KEY (owner, member))`).bind().run();
}

async function isRevoked(env, owner, member) {
  if (!env?.DB) return false;
  try {
    await revokedTable(env.DB);
    return Boolean(await env.DB.prepare(`SELECT 1 AS x FROM ${REVOKED_TABLE} WHERE owner = ?1 AND member = ?2`).bind(owner, member).first());
  } catch {
    return false;
  }
}

/** The answer to POST /api/v1/owner/revoke ({ member, at, sig, restore? }). */
export async function ownerRevoke(env, body, now = Date.now()) {
  const at = Number(body?.at);
  const member = body?.member;
  const restore = Boolean(body?.restore);
  if (!isOwnerKey(member) || !Number.isFinite(at) || Math.abs(now - at) > OWNER_ASK_SKEW_MS || typeof body?.sig !== 'string' || body.sig.length > 4096) {
    return { status: 400, body: { ok: false, error: 'member, at (ms, now) and sig are required' } };
  }
  const owner = await configuredOwner(env);
  let identity = null;
  try { identity = await identityOf(env); } catch { identity = null; }
  if (!owner || !identity) return { status: 200, body: { ok: false, error: 'no owner' } };
  let ok = false;
  try { ok = await verifyMessage(revokeText(identity.nodeId, member, at, restore), body.sig, owner); } catch { ok = false; }
  if (!ok) return { status: 403, body: { ok: false, error: 'not signed by the owner' } };
  if (!env?.DB) return { status: 200, body: { ok: false, error: 'no database' } };
  await revokedTable(env.DB);
  if (restore) await env.DB.prepare(`DELETE FROM ${REVOKED_TABLE} WHERE owner = ?1 AND member = ?2`).bind(owner, member).run();
  else await env.DB.prepare(`INSERT OR REPLACE INTO ${REVOKED_TABLE} (owner, member, at_ms) VALUES (?1, ?2, ?3)`).bind(owner, member, at).run();
  return { status: 200, body: { ok: true, member, revoked: !restore } };
}

/**
 * Whether `sig` is this relay's owner asking at `at` (ms), recently; or, with `pass`
 * ({ by, until, gsig }), someone the owner's signed pass names, signing the ask themselves, and not taken back.
 */
/** Whether a pass a stream was opened with still holds: the owner hasn't taken it back, nor has it run out. */
export async function passHolds(env, pass, now = Date.now()) {
  if (!pass || !pass.by) return true;
  const owner = await configuredOwner(env);
  const until = Number(pass.until);
  if (!owner || (until !== 0 && until < now)) return false;
  return !(await isRevoked(env, owner, pass.by));
}

export async function ownerAsked(env, at, sig, pass = null, now = Date.now()) {
  const when = Number(at);
  if (!Number.isFinite(when) || Math.abs(now - when) > OWNER_ASK_SKEW_MS || typeof sig !== 'string' || sig.length > 4096) return false;
  const owner = await configuredOwner(env);
  let identity = null;
  try { identity = await identityOf(env); } catch { identity = null; }
  if (!owner || !identity) return false;
  let signer = owner;
  if (pass && pass.by) {
    const until = Number(pass.until);
    if (!isOwnerKey(pass.by) || !Number.isFinite(until) || (until !== 0 && until < now) || typeof pass.gsig !== 'string' || pass.gsig.length > 4096) return false;
    try { if (!await verifyMessage(grantText(owner, pass.by, until), pass.gsig, owner)) return false; } catch { return false; }
    if (await isRevoked(env, owner, pass.by)) return false;
    signer = pass.by;
  }
  try { return await verifyMessage(ownerStatsText(identity.nodeId, when), sig, signer); } catch { return false; }
}
