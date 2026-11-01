// Find direct relays with one DNS-over-HTTPS lookup. The answer comes from a
// public resolver (Cloudflare's by default), not from any relay, so looking up
// relays costs the relays nothing, and resolvers cache it.

import { decodeDirectoryTxt, rankDirectoryRecords, verifyDirectoryRecord } from './record.js';

export const DEFAULT_DIRECTORY_NAME = '_relays.peer.ooo';
export const DEFAULT_DOH_URLS = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'];
const LOOKUP_TIMEOUT_MS = 3_000;
const CACHE_MS = 60_000;

const cache = new Map(); // name -> { at, records }

async function queryTxt(dohUrl, name, fetchImpl) {
  const url = `${dohUrl}?name=${encodeURIComponent(name)}&type=TXT`;
  const response = await fetchImpl(url, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`DNS-over-HTTPS answered ${response.status}`);
  const body = await response.json();
  return (body?.Answer || []).filter((answer) => answer?.type === 16).map((answer) => String(answer.data));
}

/**
 * The verified, unexpired directory records published under `name`, closest
 * to the room first (when network and room are given). Asks every resolver at
 * once and merges what they return; an empty list when none answers.
 */
export async function lookupDirectRelays({
  name = DEFAULT_DIRECTORY_NAME,
  network,
  room,
  dohUrls = DEFAULT_DOH_URLS,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  useCache = true,
} = {}) {
  let records = null;
  const cached = useCache ? cache.get(name) : null;
  if (cached && now - cached.at < CACHE_MS) {
    records = cached.records;
  } else {
    // Every resolver at once, and their answers merged: one resolver can hold
    // an old answer (an empty one cached while no relay was listed, for as
    // long as the zone's negative-cache time) and would hide a relay that
    // another already returns.
    const answers = await Promise.allSettled(dohUrls.map((dohUrl) => queryTxt(dohUrl, name, fetchImpl)));
    const byNode = new Map();
    let answered = false;
    for (const answer of answers) {
      if (answer.status !== 'fulfilled') continue;
      answered = true;
      for (const value of answer.value) {
        const record = decodeDirectoryTxt(value);
        if (!record || !await verifyDirectoryRecord(record, { now })) continue;
        const known = byNode.get(record.node_id);
        if (!known || Number(record.issued_at_ms) > Number(known.issued_at_ms)) byNode.set(record.node_id, record);
      }
    }
    if (answered) {
      records = [...byNode.values()];
      cache.set(name, { at: now, records });
    }
  }
  if (!records) return [];
  // Newest first: an older entry is likelier to be a relay that went away.
  const live = records.filter((record) => Number(record.expires_at_ms) > now)
    .sort((a, b) => Number(b.issued_at_ms) - Number(a.issued_at_ms));
  return network !== undefined && room !== undefined ? rankDirectoryRecords(live, network, room) : live;
}

export function clearDirectRelayCache() {
  cache.clear();
}
