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
import { parseDirectRelayUrl } from './common.js';

export const DIRECTORY_PATH = '/api/v1/directory';
const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const MIN_PUBLISH_INTERVAL_MS = 60_000;
const REFRESH_BEFORE_EXPIRY_MS = 12 * 60 * 60_000;
const DNS_TTL_SECONDS = 300;
const MAX_CLEANUP_PER_CALL = 5;

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

// Drop entries whose record has expired or no longer verifies (a relay that
// went away without withdrawing). Bounded per call.
async function cleanup(env, fetchImpl, entries, now) {
  let removed = 0;
  for (const entry of entries) {
    if (removed >= MAX_CLEANUP_PER_CALL) break;
    if (!String(entry.comment || '').startsWith('freertc:')) continue;
    const record = decodeDirectoryTxt(entry.content);
    if (record && await verifyDirectoryRecord(record, { now })) continue;
    await cloudflare(env, 'DELETE', `/dns_records/${entry.id}`, undefined, fetchImpl).catch(() => {});
    removed += 1;
  }
  return removed;
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

    const all = await listDirectory(env, fetchImpl);
    const mine = all.filter((entry) => entry.comment === commentFor(body.node_id));
    const current = mine[0] ? decodeDirectoryTxt(mine[0].content) : null;
    const changed = !current || current.direct !== body.direct || current.tunnel !== body.tunnel || current.name !== body.name;
    // An unchanged entry is rewritten only as it nears expiry, so a relay that
    // republishes on a timer costs no DNS writes.
    if (!changed && Number(current.expires_at_ms) - now > REFRESH_BEFORE_EXPIRY_MS) {
      return json({ ok: true, published: false, reason: 'unchanged' });
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
    const removed = await cleanup(env, fetchImpl, all.filter((entry) => entry.comment !== commentFor(body.node_id)), now);
    return json({ ok: true, published: true, cleaned: removed });
  } catch (error) {
    return json({ ok: false, error: String(error?.message || error).slice(0, 200) }, 502);
  }
}
