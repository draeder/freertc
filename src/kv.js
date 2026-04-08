// src/kv.js — MongoDB-backed advisory helpers for peer advertisement and bootstrap discovery.
//
// MongoDB replaces Cloudflare KV as the advisory hint store for bootstrap discovery.
// Data here is eventually consistent and may be stale. Peers MUST verify
// candidates independently; this data is not authoritative in any way.
//
// Collections:
//   peers   — advisory peer advertisement records
//   shards  — per-shard index of peerIds for discovery
//
// Shards reduce the cost of discovery: instead of scanning all peers in a
// network we maintain a small fixed set of index shards (0–f, first hex digit
// of peerId). This is a lightweight approximation, NOT a Kademlia ring.

import { CONFIG } from './config.js';
import { log } from './log.js';
import { MongoClient } from 'mongodb';

const SHARD_COUNT = 16; // 0–f (first hex digit of peerId)
const SHARD_SIZE  = 32; // max peer IDs stored per shard

// Module-level connection state — reused across requests within an isolate.
let _mongoClient = null;
let _kv = null;           // populated once connect() resolves
let _kvPromise = null;    // the in-flight (or already-resolved) connect promise
let _kvStatus = 'idle';   // 'idle' | 'connecting' | 'connected' | 'failed'
let _kvError = null;      // last connection error string

/** Expose connection diagnostics (read from /debug endpoint). */
export function getKvDiagnostics() {
  return { status: _kvStatus, error: _kvError };
}

/**
 * Start the MongoDB connection eagerly. Idempotent — safe to call on every
 * incoming request. Should be called at the top of the Worker fetch() handler.
 */
export function warmupKv(env) {
  if (!env?.MONGODB_URI || _kvPromise) return;
  _kvStatus = 'connecting';
  _kvError = null;
  const client = new MongoClient(env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
    socketTimeoutMS: 30_000,
  });
  _mongoClient = client;
  _kvPromise = client.connect()
    .then(() => {
      const db = client.db('signal');
      _kv = {
        peers:  db.collection('peers'),
        shards: db.collection('shards'),
        relay:  db.collection('relay'),
      };
      _kvStatus = 'connected';
      log.info('kv.connected', {});
      return _kv;
    })
    .catch((err) => {
      _kvStatus = 'failed';
      _kvError = String(err);
      log.warn('kv.connect_failed', { err: _kvError });
      // Reset so the next request can retry.
      _kvPromise = null;
      _mongoClient = null;
      _kv = null;
      return null;
    });
}

/**
 * Returns the kv object synchronously if MongoDB is already connected,
 * or null if still connecting. Call warmupKv(env) first.
 */
function getKvSync(env) {
  warmupKv(env);
  return _kv;
}

/**
 * Returns a promise that resolves to the kv object once connected.
 * Use this when you can fire-and-forget but need the write to actually land.
 */
export function getKvAsync(env) {
  warmupKv(env);
  return _kvPromise ?? Promise.resolve(null);
}

/**
 * Create and return a MongoDB-backed KV object synchronously.
 * Returns null if not yet connected (cold start). The caller should use
 * getKvAsync(env) for writes that must land even on cold start.
 *
 * @param {object} env  Cloudflare Worker env (must have env.MONGODB_URI)
 * @returns {object|null}
 */
export function createKv(env) {
  return getKvSync(env);
}

const RELAY_TTL_MS = 30_000; // 30 seconds — enough for full WebRTC handshake

/**
 * Store a relay message for a peer that is not reachable on this isolate.
 * The target peer will receive it on their next ping.
 */
export async function enqueueRelayMessage(kv, toPeerId, networkId, message) {
  if (!kv) return false;
  const now = Date.now();
  const id  = `relay:${toPeerId}:${now}:${Math.random().toString(36).slice(2)}`;
  try {
    await kv.relay.insertOne({
      _id:       id,
      toPeerId,
      networkId,
      message,
      expiresAt: new Date(now + RELAY_TTL_MS),
    });
    return true;
  } catch (err) {
    log.warn('kv.relay_enqueue_failed', { toPeerId, err: String(err) });
    return false;
  }
}

/**
 * Fetch and delete all pending relay messages for a peer.
 * Called on each ping so messages are delivered within ~3 seconds.
 */
export async function dequeueRelayMessages(kv, toPeerId, networkId) {
  if (!kv) return [];
  const now = Date.now();
  try {
    const docs = await kv.relay
      .find({ toPeerId, networkId, expiresAt: { $gt: new Date(now) } })
      .sort({ _id: 1 })
      .limit(64)
      .toArray();
    if (docs.length === 0) return [];
    const ids = docs.map((d) => d._id);
    await kv.relay.deleteMany({ _id: { $in: ids } });
    return docs.map((d) => d.message);
  } catch (err) {
    log.warn('kv.relay_dequeue_failed', { toPeerId, err: String(err) });
    return [];
  }
}

/**
 * Derive the shard key suffix for a given peerId.
 * Uses the first hex digit so distribution mirrors the ID space.
 */
function shardFor(peerId) {
  return peerId[0]; // '0'–'f'
}

// ── Public exported helpers ───────────────────────────────────────────────────

/**
 * Write (or refresh) an advisory peer advertisement.
 *
 * @param {object} kv        Object returned by createKv()
 * @param {string} networkId
 * @param {string} peerId
 * @param {object|null} capabilities
 * @param {string|null} regionHint
 */
export async function writePeerAdvertisement(kv, networkId, peerId, capabilities, regionHint) {
  if (!kv) return;
  const id  = `net:${networkId}:peer:${peerId}`;
  const now = Date.now();
  const doc = {
    _id:          id,
    peerId,
    networkId,
    capabilities: capabilities ?? {},
    regionHint:   regionHint ?? null,
    ts:           now,
    offline:      false,
    expiresAt:    new Date(now + CONFIG.KV_PEER_TTL_SECONDS * 1000),
  };
  try {
    await kv.peers.replaceOne({ _id: id }, doc, { upsert: true });
    await upsertShardEntry(kv, networkId, peerId);
  } catch (err) {
    log.warn('kv.write_failed', { networkId, peerId, err: String(err) });
  }
}

/**
 * Mark a peer advertisement as stale and delete it from the store.
 * Removes the peer from the shard index so bootstrap readers stop finding it.
 *
 * @param {object} kv
 * @param {string} networkId
 * @param {string} peerId
 */
export async function expirePeerAdvertisement(kv, networkId, peerId) {
  if (!kv) return;
  const id = `net:${networkId}:peer:${peerId}`;
  try {
    await removeShardEntry(kv, networkId, peerId);
    await kv.peers.deleteOne({ _id: id });
  } catch (err) {
    log.warn('kv.expire_failed', { networkId, peerId, err: String(err) });
  }
}

/**
 * Fetch advisory bootstrap candidates for a networkId.
 * Reads all index shards in one query, then loads peer records, filtering
 * stale entries. Returns freshest records first (may be empty / stale).
 *
 * @param {object}  kv
 * @param {string}  networkId
 * @param {string}  requestingPeerId  Always excluded from results.
 * @param {number}  [maxCount]
 * @param {Set}     [excludePeerIds]
 * @returns {Promise<object[]>}
 */
export async function getBootstrapCandidates(
  kv,
  networkId,
  requestingPeerId,
  maxCount = CONFIG.BOOTSTRAP_MAX_CANDIDATES,
  excludePeerIds = new Set(),
) {
  if (!kv) return [];

  const staleThreshold  = Date.now() - CONFIG.BOOTSTRAP_STALE_MS;
  const activeThreshold = Date.now() - CONFIG.BOOTSTRAP_ACTIVE_MS;

  if (!(excludePeerIds instanceof Set)) {
    excludePeerIds = new Set(excludePeerIds || []);
  }
  excludePeerIds.add(requestingPeerId);

  // Bulk-read all shard documents in one round-trip.
  const shards   = Array.from({ length: SHARD_COUNT }, (_, i) => i.toString(16));
  const shardIds = shards.map((s) => `net:${networkId}:idx:${s}`);
  const peerIds  = new Set();

  try {
    const shardDocs = await kv.shards.find({ _id: { $in: shardIds } }).toArray();
    for (const doc of shardDocs) {
      if (Array.isArray(doc.ids)) {
        for (const id of doc.ids) {
          if (typeof id === 'string') peerIds.add(id);
        }
      }
    }
  } catch (err) {
    log.warn('kv.shard_read_failed', { networkId, err: String(err) });
    return [];
  }

  const fetchIds = [...peerIds]
    .filter((id) => !excludePeerIds.has(id))
    .slice(0, Math.max(maxCount * 8, 64));

  if (fetchIds.length === 0) return [];

  const peerDocIds = fetchIds.map((id) => `net:${networkId}:peer:${id}`);
  let records;
  try {
    records = await kv.peers.find({ _id: { $in: peerDocIds } }).toArray();
  } catch (err) {
    log.warn('kv.peer_fetch_failed', { networkId, err: String(err) });
    return [];
  }

  const collected = [];
  for (const rec of records) {
    if (typeof rec.ts === 'number' && rec.ts < staleThreshold)  continue;
    if (typeof rec.ts !== 'number' || rec.ts < activeThreshold) continue;
    if (rec.offline === true) continue;
    collected.push({
      peerId:       rec.peerId,
      networkId:    rec.networkId,
      capabilities: rec.capabilities ?? {},
      regionHint:   rec.regionHint ?? null,
      advertisedAt: rec.ts,
      advisory:     true,
    });
  }

  collected.sort((a, b) => (b.advertisedAt ?? 0) - (a.advertisedAt ?? 0));
  return collected.slice(0, maxCount);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function upsertShardEntry(kv, networkId, peerId) {
  const shard = shardFor(peerId);
  const id    = `net:${networkId}:idx:${shard}`;
  try {
    const doc  = await kv.shards.findOne({ _id: id });
    const ids  = Array.isArray(doc?.ids) ? [...doc.ids] : [];
    const set  = new Set(ids);
    set.add(peerId);
    const updated = [...set].slice(-SHARD_SIZE);
    await kv.shards.replaceOne({ _id: id }, { _id: id, ids: updated }, { upsert: true });
  } catch (err) {
    log.warn('kv.shard_upsert_failed', { networkId, peerId, shard, err: String(err) });
  }
}

async function removeShardEntry(kv, networkId, peerId) {
  const shard = shardFor(peerId);
  const id    = `net:${networkId}:idx:${shard}`;
  try {
    const doc = await kv.shards.findOne({ _id: id });
    if (!doc || !Array.isArray(doc.ids)) return;
    const updated = doc.ids.filter((x) => x !== peerId);
    await kv.shards.replaceOne({ _id: id }, { _id: id, ids: updated }, { upsert: true });
  } catch (err) {
    log.warn('kv.shard_remove_failed', { networkId, peerId, shard, err: String(err) });
  }
}

