// A relay's entry in the DNS relay directory (see directory.js and lookup.js):
// a signed record saying where browsers can reach it directly. It is its own
// record kind, separate from the Kademlia node record, so relays on older code
// that federate node records never see it.
//
//   {
//     version: 1, kind: 'relay-directory',
//     node_id, public_key, name,
//     direct: 'webrtc-direct://<ip>:<port>/sha256/<fingerprint>',
//     tunnel: 'wss://<home>/t/<node id>/ws' | null,   the way in when direct fails
//     capacity, issued_at_ms, expires_at_ms, signature
//   }
//
// In DNS it is one TXT record, the record's canonical JSON in base64url, in
// strings of at most 255 characters, prefixed "frtc1:".

import { signMessage, verifyMessage } from 'unsea';
import { canonicalJson, isNodeId, relayNodeId, scopeRoutingKey, xorDistanceHex } from '../kademlia.js';
import { parseDirectRelayUrl } from './common.js';

export const DIRECTORY_RECORD_KIND = 'relay-directory';
export const DIRECTORY_WITHDRAW_KIND = 'relay-directory-withdraw';
const RECORD_VERSION = 1;
const MAX_CLOCK_SKEW_MS = 60_000;
export const MAX_DIRECTORY_TTL_MS = 26 * 60 * 60_000;
const TXT_PREFIX = 'frtc1:';

function unsigned(record) {
  const { signature: _signature, ...payload } = record;
  return payload;
}

function tunnelUrlOk(value, nodeId) {
  if (value === null) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'wss:' && url.pathname === `/t/${nodeId}/ws` && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export async function createSignedDirectoryRecord(identity, { direct, tunnel = null, name = null, capacity = 10_000, ttlMs = 24 * 60 * 60_000, now = Date.now() }) {
  if (!parseDirectRelayUrl(direct)) throw new TypeError('direct must be a webrtc-direct URL');
  if (!tunnelUrlOk(tunnel, identity.nodeId)) throw new TypeError('tunnel must be this relay\'s own tunnel URL');
  const payload = {
    version: RECORD_VERSION,
    kind: DIRECTORY_RECORD_KIND,
    node_id: identity.nodeId,
    public_key: identity.publicKey,
    name: typeof name === 'string' && name ? name.slice(0, 64) : null,
    direct,
    tunnel,
    capacity: Math.max(1, Math.floor(Number(capacity) || 1)),
    issued_at_ms: now,
    expires_at_ms: now + Math.min(MAX_DIRECTORY_TTL_MS, Math.max(60_000, ttlMs)),
  };
  return { ...payload, signature: await signMessage(canonicalJson(payload), identity.privateKey) };
}

export async function verifyDirectoryRecord(record, { now = Date.now() } = {}) {
  try {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
    if (record.version !== RECORD_VERSION || record.kind !== DIRECTORY_RECORD_KIND) return false;
    if (!isNodeId(record.node_id) || typeof record.public_key !== 'string' || typeof record.signature !== 'string') return false;
    if (await relayNodeId(record.public_key) !== record.node_id) return false;
    if (!parseDirectRelayUrl(record.direct) || !tunnelUrlOk(record.tunnel, record.node_id)) return false;
    if (record.name !== null && (typeof record.name !== 'string' || record.name.length > 64)) return false;
    if (!Number.isInteger(record.capacity) || record.capacity < 1) return false;
    const issued = Number(record.issued_at_ms);
    const expires = Number(record.expires_at_ms);
    if (!Number.isFinite(issued) || !Number.isFinite(expires)) return false;
    if (issued > now + MAX_CLOCK_SKEW_MS || expires <= now || expires - issued > MAX_DIRECTORY_TTL_MS) return false;
    const keys = Object.keys(record).sort().join(',');
    if (keys !== 'capacity,direct,expires_at_ms,issued_at_ms,kind,name,node_id,public_key,signature,tunnel,version') return false;
    return await verifyMessage(canonicalJson(unsigned(record)), record.signature, record.public_key);
  } catch {
    return false;
  }
}

/** A signed request to remove this relay's directory entry. */
export async function createSignedWithdrawal(identity, { now = Date.now() } = {}) {
  const payload = {
    version: RECORD_VERSION,
    kind: DIRECTORY_WITHDRAW_KIND,
    node_id: identity.nodeId,
    public_key: identity.publicKey,
    issued_at_ms: now,
  };
  return { ...payload, signature: await signMessage(canonicalJson(payload), identity.privateKey) };
}

export async function verifyWithdrawal(withdrawal, { now = Date.now() } = {}) {
  try {
    if (!withdrawal || withdrawal.version !== RECORD_VERSION || withdrawal.kind !== DIRECTORY_WITHDRAW_KIND) return false;
    if (!isNodeId(withdrawal.node_id) || await relayNodeId(withdrawal.public_key) !== withdrawal.node_id) return false;
    if (Math.abs(now - Number(withdrawal.issued_at_ms)) > 5 * 60_000) return false;
    return await verifyMessage(canonicalJson(unsigned(withdrawal)), withdrawal.signature, withdrawal.public_key);
  } catch {
    return false;
  }
}

function base64urlEncode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** TXT record content for a record: quoted strings of at most 255 characters. */
export function encodeDirectoryTxt(record) {
  const text = TXT_PREFIX + base64urlEncode(canonicalJson(record));
  return text.match(/.{1,255}/g).map((chunk) => `"${chunk}"`).join(' ');
}

/** The record in a TXT value (quoted strings, as DNS-over-HTTPS returns it), or null. */
export function decodeDirectoryTxt(value) {
  try {
    const parts = String(value).match(/"([^"]*)"/g);
    const text = parts ? parts.map((part) => part.slice(1, -1)).join('') : String(value);
    if (!text.startsWith(TXT_PREFIX)) return null;
    const record = JSON.parse(base64urlDecode(text.slice(TXT_PREFIX.length)));
    return record && typeof record === 'object' ? record : null;
  } catch {
    return null;
  }
}

/**
 * Order verified records for a room: closest relay (by XOR distance from the
 * room's routing key to the relay's node ID) first, so every peer of a room
 * reaches for the same relays.
 */
export async function rankDirectoryRecords(records, network, room) {
  const key = await scopeRoutingKey(network, room);
  return [...records].sort((a, b) => {
    const da = xorDistanceHex(key, a.node_id);
    const db = xorDistanceHex(key, b.node_id);
    return da < db ? -1 : da > db ? 1 : 0;
  });
}
