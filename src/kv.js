// src/kv.js — MongoDB-backed storage for peer advertisement and signaling relay.
//
// All signaling messages (offer, answer, ice_candidate, etc.) are routed through
// MongoDB and delivered on the target peer's next ping. This ensures the
// Cloudflare Worker remains stateless and horizontally scalable.
//
// Collections:
//   peers   — advisory peer advertisement records
//   shards  — per-shard index of peerIds for discovery
//   relay   — queued signaling messages for delivery on next ping
//
// Shards reduce the cost of discovery: instead of scanning all peers in a
// network we maintain a small fixed set of index shards (0–f, first hex digit
// of peerId). This is a lightweight approximation, NOT a Kademlia ring.

import { CONFIG } from './config.js';
import { log } from './log.js';
import { MSG } from './protocol.js';
import { MongoClient } from 'mongodb';

const SHARD_COUNT = 16; // 0–f (first hex digit of peerId)
const SHARD_SIZE  = 32; // max peer IDs stored per shard

// Module-level connection state — reused across requests within an isolate.
let _mongoClient = null;
let _kv = null;           // populated once connect() resolves
let _kvPromise = null;    // the in-flight (or already-resolved) connect promise
let _kvStatus = 'idle';   // 'idle' | 'connecting' | 'connected' | 'failed'
let _kvError = null;      // last connection error string
let _lastConnectAttempt = 0; // timestamp of last connection attempt

/** Expose connection diagnostics (read from /debug endpoint). */
export function getKvDiagnostics() {
  return { status: _kvStatus, error: _kvError };
}

/**
 * Start the MongoDB connection eagerly. Idempotent — safe to call on every
 * incoming request. Should be called at the top of the Worker fetch() handler.
 */
export function warmupKv(env) {
  if (!env?.MONGODB_URI) return;
  
  // If connected, we're good
  if (_kvStatus === 'connected') return;
  
  // If already connecting, don't start another attempt
  if (_kvPromise) return;
  
  // If previously failed, only retry after 5 seconds
  if (_kvStatus === 'failed') {
    const now = Date.now();
    if (now - _lastConnectAttempt < 5000) {
      return; // Too soon, don't retry yet
    }
  }
  
  _kvStatus = 'connecting';
  _kvError = null;
  _lastConnectAttempt = Date.now();
  
  const client = new MongoClient(env.MONGODB_URI, {
    serverSelectionTimeoutMS: 5_000,
    connectTimeoutMS: 5_000,
    socketTimeoutMS: 10_000,
    maxPoolSize: 1,
  });
  _mongoClient = client;

  const connectTimeoutMs = 8_000;
  const timedConnect = Promise.race([
    client.connect(),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`MongoDB connect timeout after ${connectTimeoutMs}ms`)), connectTimeoutMs);
    }),
  ]);

  try {
    _kvPromise = Promise.resolve()
      .then(() => {
        log.info('kv.connect_starting', {});
        return timedConnect;
      })
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
        log.warn('kv.connect_failed', { err: _kvError, type: err?.name });
        // Reset so the next request can retry after the cooldown
        _kvPromise = null;
        _mongoClient = null;
        _kv = null;
        return null;
      });
  } catch (err) {
    _kvStatus = 'failed';
    _kvError = String(err);
    log.error('kv.connect_error', { err: _kvError });
    _kvPromise = null;
    return;
  }
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

// Dedupe high-level signaling messages that are frequently retried.
// ICE candidates remain append-only because each candidate can be unique.
const RELAY_DEDUPE_TYPES = new Set([
  MSG.OFFER,
  MSG.ANSWER,
  MSG.RENEGOTIATE,
  MSG.ICE_END,
  MSG.BYE,
]);

/**
 * Store a relay message for a peer that is not reachable on this isolate.
 * The target peer will receive it on their next ping.
 */
export async function enqueueRelayMessage(kv, toPeerId, networkId, message) {
  if (!kv) return false;
  const now = Date.now();
  const type = message?.type ?? 'unknown';
  const fromPeerId = message?.from ?? 'unknown';

  try {
    if (RELAY_DEDUPE_TYPES.has(type)) {
      // One slot per (type, from→to) pair — newest always wins.
      // Intentionally excludes session_id so a fresh page-load's offer
      // overwrites the stale offer from the previous session, preventing
      // B from receiving two different-SDP offers at once.
      const dedupeId = `relay:${type}:${toPeerId}:${networkId}:${fromPeerId}`;
      await kv.relay.replaceOne(
        { _id: dedupeId },
        {
          _id: dedupeId,
          toPeerId,
          networkId,
          message,
          createdAt: new Date(now),
          expiresAt: new Date(now + RELAY_TTL_MS),
        },
        { upsert: true },
      );
      return true;
    }

    // Append-only for candidate-like traffic.
    const id = `relay:${toPeerId}:${now}:${Math.random().toString(36).slice(2)}`;
    await kv.relay.insertOne({
      _id: id,
      toPeerId,
      networkId,
      message,
      createdAt: new Date(now),
      expiresAt: new Date(now + RELAY_TTL_MS),
    });
    return true;
  } catch (err) {
    log.warn('kv.relay_enqueue_failed', { toPeerId, type, err: String(err) });
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
      .sort({ createdAt: 1, _id: 1 })
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
    advertisedAt: new Date(now),
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
    await kv.peers.deleteOne({ _id: id });
    await removeShardEntry(kv, networkId, peerId);
  } catch (err) {
    log.warn('kv.expire_failed', { networkId, peerId, err: String(err) });
  }
}

/**
 * Fetch bootstrap candidates from all 16 shards.
 * Reads all shards to avoid false negatives in small/skewed networks.
 */
export async function getBootstrapCandidates(kv, networkId, excludePeerId, limit, excludeSet) {
  if (!kv) return [];

  const maxAge = CONFIG.BOOTSTRAP_STALE_MS;
  const cutoff = Date.now() - maxAge;

  try {
    // Read all 16 shard indices
    const shards = [];
    for (let i = 0; i < SHARD_COUNT; i++) {
      const hex = i.toString(16);
      const shardKey = `net:${networkId}:shard:${hex}`;
      const doc = await kv.shards.findOne({ _id: shardKey });
      if (doc?.peers && Array.isArray(doc.peers)) {
        shards.push(...doc.peers);
      }
    }

    // Deduplicate
    const uniquePeerIds = Array.from(new Set(shards));

    // Exclude self and provided exclusions
    const candidateIds = uniquePeerIds.filter(
      (id) => id !== excludePeerId && (!excludeSet || !excludeSet.has(id))
    );

    // Fetch advertisements in parallel
    const adverts = await Promise.all(
      candidateIds.map((peerId) => {
        const id = `net:${networkId}:peer:${peerId}`;
        return kv.peers.findOne({ _id: id });
      })
    );

    // Filter out nulls, stale, and map
    const fresh = adverts
      .filter((doc) => doc && doc.ts > cutoff)
      .map((doc) => ({
        peerId:     doc.peerId,
        capabilities: doc.capabilities,
        advertisedAt: doc.ts,
      }));

    // Apply limit if specified
    return limit ? fresh.slice(0, limit) : fresh;
  } catch (err) {
    log.warn('kv.bootstrap_failed', { networkId, err: String(err) });
    return [];
  }
}

/**
 * Upsert a peerId into its shard index (limited to SHARD_SIZE entries).
 */
async function upsertShardEntry(kv, networkId, peerId) {
  if (!kv) return;
  const hex = shardFor(peerId);
  const shardKey = `net:${networkId}:shard:${hex}`;
  try {
    // Atomic upsert: add peerId if not present, trim to SHARD_SIZE
    await kv.shards.updateOne(
      { _id: shardKey },
      [
        { $set: {
            _id: shardKey,
            networkId,
            shard: hex,
            peers: {
              $cond: [
                { $in: [peerId, { $ifNull: ['$peers', []] }] },
                { $ifNull: ['$peers', []] },
                { $slice: [{ $concatArrays: [[peerId], { $ifNull: ['$peers', []] }] }, SHARD_SIZE] },
              ],
            },
          },
        },
      ],
      { upsert: true }
    );
  } catch (err) {
    log.warn('kv.shard_upsert_failed', { networkId, peerId, err: String(err) });
  }
}

/**
 * Remove a peerId from its shard index.
 */
async function removeShardEntry(kv, networkId, peerId) {
  if (!kv) return;
  const hex = shardFor(peerId);
  const shardKey = `net:${networkId}:shard:${hex}`;
  try {
    await kv.shards.updateOne(
      { _id: shardKey },
      [{ $set: { peers: { $filter: { input: { $ifNull: ['$peers', []] }, as: 'p', cond: { $ne: ['$$p', peerId] } } } } }]
    );
  } catch (err) {
    log.warn('kv.shard_remove_failed', { networkId, peerId, err: String(err) });
  }
}
