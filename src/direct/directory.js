// The relay directory, kept in DNS by a cloud relay that holds a DNS token.
//
//   POST   /api/v1/directory   body: a signed directory record (record.js)
//   DELETE /api/v1/directory   body: a signed withdrawal
//
// Only the Worker holds the token (env.DIRECTORY_DNS_TOKEN, a Cloudflare API
// token limited to editing DNS on one zone, env.DIRECTORY_ZONE_ID). Each relay
// has one TXT record at env.DIRECTORY_RECORD_NAME (for example
// _relays.peer.ooo), found by its comment "freertc:<node id>"; a relay can
// write and remove only its own. The record's direct address must be the
// address the request came from, so nobody can list someone else's machine
// and send browsers' connection attempts to it.
//
// Off unless all three are set.

import { decodeDirectoryTxt, encodeDirectoryTxt, verifyDirectoryRecord, verifyWithdrawal } from './record.js';
import { verifyDirectoryPq } from '../relay-identity.js';
import { parseDirectRelayUrl, recordWssUrl } from './common.js';

export const DIRECTORY_PATH = '/api/v1/directory';
const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const MIN_PUBLISH_INTERVAL_MS = 60_000;
const REFRESH_BEFORE_EXPIRY_MS = 60 * 60_000;
const PROBE_TIMEOUT_MS = 4_000;
const DNS_TTL_SECONDS = 300;
const MAX_CLEANUP_PER_CALL = 5;
const DOH_URL = 'https://cloudflare-dns.com/dns-query';

// A record may carry a TLS name (name = wss://<host>:<port>/ws). It is
// listed only if DNS for <host> points at the address the request came from,
// so a relay cannot send browsers to a name that is not its own.
async function nameIsOurs(record, from, fetchImpl) {
  if (!String(record.name ?? '').startsWith('wss:')) return true;
  const wss = recordWssUrl(record);
  if (!wss) return false;
  const host = new URL(wss).hostname;
  const type = String(from).includes(':') ? 'AAAA' : 'A';
  try {
    const response = await fetchImpl(`${DOH_URL}?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const answer = await response.json();
    return (answer?.Answer || []).some((a) => sameIp(a.data, from));
  } catch {
    return false;
  }
}

export function directoryEnabled(env) {
  return Boolean(env?.DIRECTORY_DNS_TOKEN && env?.DIRECTORY_ZONE_ID && env?.DIRECTORY_RECORD_NAME);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function commentFor(nodeId) {
  return `freertc:${nodeId}`;
}

function sameIp(a, b) {
  const norm = (ip) => String(ip || '').toLowerCase().replace(/^::ffff:/, '');
  return norm(a) !== '' && norm(a) === norm(b);
}

async function cloudflare(env, method, path, body, fetchImpl) {
  const response = await fetchImpl(`${CLOUDFLARE_API}/zones/${env.DIRECTORY_ZONE_ID}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.DIRECTORY_DNS_TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.success === false) {
    const why = data?.errors?.map((error) => error.message).join('; ') || `status ${response.status}`;
    throw new Error(`DNS API: ${why}`);
  }
  return data?.result;
}

async function listDirectory(env, fetchImpl, extra = '') {
  const name = encodeURIComponent(env.DIRECTORY_RECORD_NAME);
  return (await cloudflare(env, 'GET', `/dns_records?type=TXT&name=${name}&per_page=100${extra}`, undefined, fetchImpl)) || [];
}

// Is the relay behind this entry still there? Only entries with an open ws
// port can be checked from here: its /health must answer, and with this
// entry's node id when it reports one. A relay that stopped without
// withdrawing (crash, lost network, the cloud was down when it tried) fails
// this, and so does an old entry whose forwarded port now reaches a
// different relay on the same network.
async function stillThere(record, fetchImpl) {
  if (!record.ws) return true;
  const url = String(record.ws).replace(/^ws:/, 'http:').replace(/\/ws$/, '/health');
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!response.ok) return false;
    const health = await response.json().catch(() => null);
    return !health?.node_id || health.node_id === record.node_id;
  } catch {
    return false;
  }
}

// Drop entries whose record has expired, no longer verifies, or whose relay
// is gone. Bounded per call; the checks run side by side.
async function cleanup(env, fetchImpl, entries, now) {
  const ours = entries.filter((entry) => String(entry.comment || '').startsWith('freertc:')).slice(0, 4 * MAX_CLEANUP_PER_CALL);
  const verdicts = await Promise.all(ours.map(async (entry) => {
    const record = decodeDirectoryTxt(entry.content);
    if (!record || !await verifyDirectoryRecord(record, { now })) return entry;
    return await stillThere(record, fetchImpl) ? null : entry;
  }));
  let removed = 0;
  for (const entry of verdicts.filter(Boolean).slice(0, MAX_CLEANUP_PER_CALL)) {
    await cloudflare(env, 'DELETE', `/dns_records/${entry.id}`, undefined, fetchImpl).catch(() => {});
    removed += 1;
  }
  return removed;
}

// Post-quantum keys (local relays, src/node/relay-pq.js): a relay may send its
// ML-DSA-65 public key and a hybrid signature over its signed record (or
// withdrawal) in two headers. The first key a node id shows is pinned in D1;
// from then on that node id is listed or withdrawn only with that same key, so
// forging the relay's P-256 signature alone (a quantum computer) is no longer
// enough. Pinned on first sight: a relay is protected from the first time it
// lists itself with a key, not before. The TXT record itself is unchanged, so every client reads it as
// before; only this directory writes it.
export const PQ_KEY_HEADER = 'X-Freertc-Pq-Key';
export const PQ_SIGNATURE_HEADER = 'X-Freertc-Pq-Signature';
const PQ_PIN_TABLE = 'psp_directory_pq';
let warnedNoPins = false;

async function sha256Hex(text) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function pinTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS ${PQ_PIN_TABLE} (node_id TEXT PRIMARY KEY, key_sha256 TEXT NOT NULL, pinned_at_ms INTEGER NOT NULL)`).run();
}

/** null when the request may go ahead, or why it may not. */
async function postQuantumCheck(request, env, signed, now) {
  const key = request.headers.get(PQ_KEY_HEADER);
  const signature = request.headers.get(PQ_SIGNATURE_HEADER);
  const db = env.DB || null;
  if (db) await pinTable(db);
  else if (!warnedNoPins) {
    warnedNoPins = true;
    console.warn('[directory] no database (env.DB): relays\' post-quantum keys are checked but not pinned');
  }
  const pinned = db
    ? (await db.prepare(`SELECT key_sha256 FROM ${PQ_PIN_TABLE} WHERE node_id = ?1`).bind(signed.node_id).first())?.key_sha256 ?? null
    : null;
  if (!key && !signature) {
    return pinned ? 'this relay was listed with a post-quantum key: prove it' : null;
  }
  if (!await verifyDirectoryPq(signed, key, signature)) return 'bad post-quantum signature';
  const hash = await sha256Hex(key);
  if (pinned && pinned !== hash) return 'not the post-quantum key this relay was listed with';
  if (!pinned && db) {
    await db.prepare(`INSERT OR IGNORE INTO ${PQ_PIN_TABLE} (node_id, key_sha256, pinned_at_ms) VALUES (?1, ?2, ?3)`).bind(signed.node_id, hash, now).run();
  }
  return null;
}

export async function handleDirectoryRequest(request, env, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  if (!directoryEnabled(env)) return json({ ok: false, error: 'no directory on this relay' }, 404);
  if (request.method !== 'POST' && request.method !== 'DELETE') return json({ ok: false, error: 'method not allowed' }, 405);
  const text = await request.text();
  if (text.length > 8 * 1024) return json({ ok: false, error: 'too large' }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return json({ ok: false, error: 'bad JSON' }, 400); }

  try {
    if (request.method === 'DELETE') {
      if (!await verifyWithdrawal(body, { now })) return json({ ok: false, error: 'bad withdrawal' }, 400);
      const refused = await postQuantumCheck(request, env, body, now);
      if (refused) return json({ ok: false, error: refused }, 403);
      const mine = await listDirectory(env, fetchImpl, `&comment.exact=${encodeURIComponent(commentFor(body.node_id))}`);
      for (const entry of mine) await cloudflare(env, 'DELETE', `/dns_records/${entry.id}`, undefined, fetchImpl);
      return json({ ok: true, removed: mine.length });
    }

    if (!await verifyDirectoryRecord(body, { now })) return json({ ok: false, error: 'bad record' }, 400);
    const direct = parseDirectRelayUrl(body.direct);
    const from = request.headers.get('CF-Connecting-IP');
    if (!sameIp(direct.host, from)) {
      return json({ ok: false, error: 'the direct address must be the address this request came from', seen: from || null }, 400);
    }
    if (!await nameIsOurs(body, from, fetchImpl)) {
      return json({ ok: false, error: 'the record\'s wss name must point at the address this request came from', seen: from || null }, 400);
    }
    const refused = await postQuantumCheck(request, env, body, now);
    if (refused) return json({ ok: false, error: refused }, 403);

    const all = await listDirectory(env, fetchImpl);
    const mine = all.filter((entry) => entry.comment === commentFor(body.node_id));
    const current = mine[0] ? decodeDirectoryTxt(mine[0].content) : null;
    const sameList = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const changed = !current || current.direct !== body.direct || current.tunnel !== body.tunnel || current.name !== body.name
      || !sameList(current.lan, body.lan) || (current.ws ?? null) !== (body.ws ?? null);
    // An unchanged entry is rewritten only as it nears expiry, so a relay that
    // republishes on a timer costs no DNS writes.
    const others = all.filter((entry) => entry.comment !== commentFor(body.node_id));
    if (!changed && Number(current.expires_at_ms) - now > REFRESH_BEFORE_EXPIRY_MS) {
      // Republishes are the directory's heartbeat: each one also clears out
      // relays that went away.
      const removed = await cleanup(env, fetchImpl, others, now);
      return json({ ok: true, published: false, reason: 'unchanged', cleaned: removed });
    }
    if (changed && current && now - Number(current.issued_at_ms) < MIN_PUBLISH_INTERVAL_MS) {
      return json({ ok: false, error: 'changed too recently; try again in a few minutes' }, 429);
    }

    const entry = {
      type: 'TXT',
      name: env.DIRECTORY_RECORD_NAME,
      content: encodeDirectoryTxt(body),
      ttl: DNS_TTL_SECONDS,
      comment: commentFor(body.node_id),
    };
    if (mine[0]) await cloudflare(env, 'PUT', `/dns_records/${mine[0].id}`, entry, fetchImpl);
    else await cloudflare(env, 'POST', '/dns_records', entry, fetchImpl);
    for (const extra of mine.slice(1)) await cloudflare(env, 'DELETE', `/dns_records/${extra.id}`, undefined, fetchImpl).catch(() => {});
    const removed = await cleanup(env, fetchImpl, others, now);
    return json({ ok: true, published: true, cleaned: removed });
  } catch (error) {
    return json({ ok: false, error: String(error?.message || error).slice(0, 200) }, 502);
  }
}
