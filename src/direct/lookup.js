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
 * to the room first (when network and room are given). Tries each resolver in
 * turn; an empty list when none answers.
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
    for (const dohUrl of dohUrls) {
      try {
        const values = await queryTxt(dohUrl, name, fetchImpl);
        const decoded = values.map(decodeDirectoryTxt).filter(Boolean);
        const verified = [];
        for (const record of decoded) {
          if (await verifyDirectoryRecord(record, { now })) verified.push(record);
        }
        records = verified;
        cache.set(name, { at: now, records });
        break;
      } catch {
        // try the next resolver
      }
    }
  }
  if (!records) return [];
  const live = records.filter((record) => Number(record.expires_at_ms) > now);
  return network !== undefined && room !== undefined ? rankDirectoryRecords(live, network, room) : live;
}

export function clearDirectRelayCache() {
  cache.clear();
}
