// Relay names: a DNS name and a Let's Encrypt certificate for a local relay,
// kept by its owner's own Worker on the owner's own domain.
//
//   POST /api/v1/name   body: a request signed with the relay's identity
//     action 'claim'       point <label>.<NAMES_DOMAIN> at the address this request came from
//     action 'acme-set'    put `value` in the TXT record _acme-challenge.<name> (DNS-01)
//     action 'acme-clear'  remove that TXT record
//
// <label> is the relay's node id, cut to its first LABEL_CHARS hex digits (a
// DNS label holds 63 characters, a node id 64).
//
// Only the Worker holds the DNS token (env.NAMES_DNS_TOKEN, limited to
// editing DNS on one zone, env.NAMES_ZONE_ID, whose domain is
// env.NAMES_DOMAIN). It answers only relays its owner registered: their node
// ids are in the D1 table freertc_name_owners, put there by `freertc name` on
// the relay's machine (with the owner's Cloudflare login). With
// env.NAMES_OPEN = '1' it answers any relay (a public naming service, such as
// relays.peer.ooo).
//
// The address is always the one the request came from, so a relay can name
// only its own machine. Off unless the token, zone and domain are set.

import { signMessage, verifyMessage } from 'unsea';
import { canonicalJson, isNodeId, relayNodeId } from '../kademlia.js';

export const NAMES_PATH = '/api/v1/name';
export const NAME_REQUEST_KIND = 'relay-name';
export const OWNERS_TABLE = 'freertc_name_owners';
export const LABEL_CHARS = 16;
const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const MAX_SKEW_MS = 5 * 60_000;
const NAME_TTL_SECONDS = 120;
const ACME_TTL_SECONDS = 60;
const ACTIONS = new Set(['claim', 'acme-set', 'acme-clear']);

export function namesEnabled(env) {
  return Boolean(env?.NAMES_DNS_TOKEN && env?.NAMES_ZONE_ID && env?.NAMES_DOMAIN);
}

/** The DNS name a relay gets on `domain`. */
export function relayHostname(nodeId, domain) {
  return `${String(nodeId).slice(0, LABEL_CHARS).toLowerCase()}.${String(domain).toLowerCase().replace(/\.$/, '')}`;
}

/** A relay's signed naming request. */
export async function createNameRequest(identity, { action, value = null, now = Date.now() }) {
  const payload = {
    kind: NAME_REQUEST_KIND,
    version: 1,
    action,
    node_id: identity.nodeId,
    public_key: identity.publicKey,
    issued_at_ms: now,
    ...(value === null ? {} : { value: String(value) }),
  };
  return { ...payload, signature: await signMessage(canonicalJson(payload), identity.privateKey) };
}

export async function verifyNameRequest(request, { now = Date.now() } = {}) {
  try {
    if (!request || request.kind !== NAME_REQUEST_KIND || request.version !== 1 || !ACTIONS.has(request.action)) return false;
    if (!isNodeId(request.node_id) || typeof request.public_key !== 'string' || typeof request.signature !== 'string') return false;
    if (Math.abs(now - Number(request.issued_at_ms)) > MAX_SKEW_MS) return false;
    if (request.action === 'acme-set' && (typeof request.value !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(request.value))) return false;
    if (await relayNodeId(request.public_key) !== request.node_id) return false;
    const { signature, ...payload } = request;
    return await verifyMessage(canonicalJson(payload), signature, request.public_key);
  } catch {
    return false;
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function cloudflare(env, method, path, body, fetchImpl) {
  const response = await fetchImpl(`${CLOUDFLARE_API}/zones/${env.NAMES_ZONE_ID}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.NAMES_DNS_TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.success === false) {
    const why = data?.errors?.map((error) => error.message).join('; ') || `status ${response.status}`;
    throw new Error(`DNS API: ${why}`);
  }
  return data?.result;
}

async function records(env, fetchImpl, type, name) {
  return (await cloudflare(env, 'GET', `/dns_records?type=${type}&name=${encodeURIComponent(name)}&per_page=100`, undefined, fetchImpl)) || [];
}

/** Is this relay one its owner registered (or is this an open naming service)? */
export async function isRegistered(env, nodeId) {
  if (env.NAMES_OPEN === '1' || env.NAMES_OPEN === true) return true;
  const db = env.DB;
  if (!db) return false;
  await db.prepare(`CREATE TABLE IF NOT EXISTS ${OWNERS_TABLE} (node_id TEXT PRIMARY KEY, added_at_ms INTEGER NOT NULL)`).run();
  return Boolean(await db.prepare(`SELECT node_id FROM ${OWNERS_TABLE} WHERE node_id = ?1`).bind(nodeId).first());
}

export async function handleNameRequest(request, env, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  if (!namesEnabled(env)) return json({ ok: false, error: 'this Worker gives no names' }, 404);
  if (request.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);
  const text = await request.text();
  if (text.length > 4 * 1024) return json({ ok: false, error: 'too large' }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return json({ ok: false, error: 'bad JSON' }, 400); }
  if (!await verifyNameRequest(body, { now })) return json({ ok: false, error: 'bad request signature' }, 400);
  if (!await isRegistered(env, body.node_id)) {
    return json({ ok: false, error: 'this relay is not registered with this Worker; run `npx freertc name` on its machine' }, 403);
  }
  const name = relayHostname(body.node_id, env.NAMES_DOMAIN);
  const comment = `freertc-name:${body.node_id}`;
  try {
    if (body.action === 'claim') {
      const ip = String(request.headers.get('CF-Connecting-IP') || '').replace(/^::ffff:/, '');
      if (!ip) return json({ ok: false, error: 'no address seen' }, 400);
      const type = ip.includes(':') ? 'AAAA' : 'A';
      const other = type === 'A' ? 'AAAA' : 'A';
      const mine = (await records(env, fetchImpl, type, name));
      const entry = { type, name, content: ip, ttl: NAME_TTL_SECONDS, proxied: false, comment };
      let changed = true;
      if (mine[0] && mine[0].content === ip) changed = false;
      else if (mine[0]) await cloudflare(env, 'PUT', `/dns_records/${mine[0].id}`, entry, fetchImpl);
      else await cloudflare(env, 'POST', '/dns_records', entry, fetchImpl);
      for (const extra of mine.slice(1)) await cloudflare(env, 'DELETE', `/dns_records/${extra.id}`, undefined, fetchImpl).catch(() => {});
      // An address of the other family left from before would send clients elsewhere.
      for (const stale of await records(env, fetchImpl, other, name)) await cloudflare(env, 'DELETE', `/dns_records/${stale.id}`, undefined, fetchImpl).catch(() => {});
      return json({ ok: true, name, ip, changed });
    }
    const acmeName = `_acme-challenge.${name}`;
    const existing = await records(env, fetchImpl, 'TXT', acmeName);
    if (body.action === 'acme-set') {
      const content = `"${body.value}"`;
      if (!existing.some((entry) => String(entry.content).replace(/"/g, '') === body.value)) {
        await cloudflare(env, 'POST', '/dns_records', { type: 'TXT', name: acmeName, content, ttl: ACME_TTL_SECONDS, comment: `freertc-acme:${body.node_id}` }, fetchImpl);
      }
      return json({ ok: true, name: acmeName });
    }
    for (const entry of existing) await cloudflare(env, 'DELETE', `/dns_records/${entry.id}`, undefined, fetchImpl).catch(() => {});
    return json({ ok: true, removed: existing.length });
  } catch (error) {
    return json({ ok: false, error: String(error?.message || error).slice(0, 200) }, 502);
  }
}
