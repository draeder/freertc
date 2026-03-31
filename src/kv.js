// src/kv.js — Advisory KV helpers for peer advertisement and bootstrap discovery.
//
// KV is used ONLY as an advisory hint store for bootstrap discovery.
// Data here is eventually consistent and may be stale. Peers MUST verify
// candidates independently; this data is not authoritative in any way.
//
// Key layout:
//   net:{networkId}:peer:{peerId}   → advertisement record (JSON)
//   net:{networkId}:idx:{shard}     → index shard (JSON array of peerIds)
//
// Shards reduce the cost of discovery: instead of listing all peers in a
// network (KV has no efficient list-all), we maintain a small fixed set of
// index shards (0–9) that each record up to SHARD_SIZE peer IDs. A peer
// is added to the shard derived from the first character of its ID.
// This is a lightweight approximation, NOT a Kademlia ring.

import { CONFIG } from './config.js';
import { log } from './log.js';

const SHARD_COUNT = 16; // 0–f (first hex digit of peerId)
const SHARD_SIZE  = 32; // max peer IDs stored per shard

/**
 * Derive the shard key suffix for a given peerId.
 * Uses the first hex digit so distribution mirrors the ID space.
 */
function shardFor(peerId) {
  return peerId[0]; // '0'–'f'
}

/**
 * Write (or refresh) an advisory peer advertisement to KV.
 *
 * @param {KVNamespace} kv
 * @param {string} networkId
 * @param {string} peerId
 * @param {object|null} capabilities
 * @param {string|null} regionHint
 */
export async function writePeerAdvertisement(kv, networkId, peerId, capabilities, regionHint) {
  const peerKey = `net:${networkId}:peer:${peerId}`;
  const record = {
    peerId,
    networkId,
    capabilities: capabilities ?? {},
    regionHint: regionHint ?? null,
    ts: Date.now(),
  };

  try {
    // Write the full advertisement with a TTL for automatic expiry.
    await kv.put(peerKey, JSON.stringify(record), {
      expirationTtl: CONFIG.KV_PEER_TTL_SECONDS,
    });

    // Update the index shard — best-effort; ignore failures.
    await upsertShardEntry(kv, networkId, peerId);
  } catch (err) {
    log.warn('kv.write_failed', { networkId, peerId, err: String(err) });
  }
}

/**
 * Mark a peer advertisement as stale by shortening its TTL to 60 s.
 * This is advisory only — KV is eventually consistent.
 *
 * @param {KVNamespace} kv
 * @param {string} networkId
 * @param {string} peerId
 */
export async function expirePeerAdvertisement(kv, networkId, peerId) {
  const peerKey = `net:${networkId}:peer:${peerId}`;
  try {
    const raw = await kv.get(peerKey);
    if (!raw) return;
    // Re-write with a short TTL so KV will clean it up soon.
    await kv.put(peerKey, raw, { expirationTtl: 60 });
  } catch (err) {
    log.warn('kv.expire_failed', { networkId, peerId, err: String(err) });
  }
}

/**
 * Fetch advisory bootstrap candidates for a networkId.
 * Reads a sample of index shards, then loads each advertised peer record,
 * filtering out entries that exceed the freshness threshold.
 *
 * Returns an array of candidate objects (may be empty, may be stale).
 *
 * @param {KVNamespace} kv
 * @param {string} networkId
 * @param {string} requestingPeerId - Excluded from results.
 * @param {number} [maxCount]
 * @returns {Promise<object[]>}
 */
export async function getBootstrapCandidates(kv, networkId, requestingPeerId, maxCount = CONFIG.BOOTSTRAP_MAX_CANDIDATES) {
  const staleThreshold = Date.now() - CONFIG.BOOTSTRAP_STALE_MS;
  const collected = [];

  // Sample a random subset of shards to bound KV reads.
  const shards = randomSample(
    Array.from({ length: SHARD_COUNT }, (_, i) => i.toString(16)),
    Math.min(SHARD_COUNT, 4) // read at most 4 shards per request
  );

  const peerIds = new Set();

  for (const shard of shards) {
    if (collected.length >= maxCount) break;

    const idxKey = `net:${networkId}:idx:${shard}`;
    try {
      const raw = await kv.get(idxKey);
      if (!raw) continue;
      const ids = JSON.parse(raw);
      if (!Array.isArray(ids)) continue;
      for (const id of ids) {
        if (typeof id === 'string') peerIds.add(id);
      }
    } catch {
      // Shard read failure is non-fatal; continue with other shards.
    }
  }

  // Load individual peer records for each discovered ID.
  const fetches = [...peerIds]
    .filter((id) => id !== requestingPeerId)
    .slice(0, maxCount * 2); // over-fetch to account for stale filtering

  const records = await Promise.allSettled(
    fetches.map((id) => kv.get(`net:${networkId}:peer:${id}`))
  );

  for (const result of records) {
    if (collected.length >= maxCount) break;
    if (result.status !== 'fulfilled' || !result.value) continue;
    try {
      const rec = JSON.parse(result.value);
      // Filter stale entries — peers should still expect some stale results.
      if (typeof rec.ts === 'number' && rec.ts < staleThreshold) continue;
      collected.push({
        peerId:       rec.peerId,
        networkId:    rec.networkId,
        capabilities: rec.capabilities ?? {},
        regionHint:   rec.regionHint ?? null,
        advertisedAt: rec.ts,
        // Advisory: this does NOT mean the peer is currently connected.
        advisory: true,
      });
    } catch {
      // Malformed KV record — skip.
    }
  }

  return collected;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Add a peerId to the appropriate shard index, keeping the shard bounded.
 * This is best-effort; failures are logged but do not surface to the caller.
 */
async function upsertShardEntry(kv, networkId, peerId) {
  const shard = shardFor(peerId);
  const idxKey = `net:${networkId}:idx:${shard}`;

  try {
    const raw = await kv.get(idxKey);
    let ids = [];
    if (raw) {
      try { ids = JSON.parse(raw); } catch { ids = []; }
      if (!Array.isArray(ids)) ids = [];
    }

    // Deduplicate and cap size.
    const set = new Set(ids);
    set.add(peerId);
    const updated = [...set].slice(-SHARD_SIZE);

    await kv.put(idxKey, JSON.stringify(updated), {
      expirationTtl: CONFIG.KV_PEER_TTL_SECONDS * 2,
    });
  } catch (err) {
    log.warn('kv.shard_upsert_failed', { networkId, peerId, shard, err: String(err) });
  }
}

/**
 * Return `n` random elements from `arr` without mutation.
 */
function randomSample(arr, n) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}
