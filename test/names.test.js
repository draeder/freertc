import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateRandomPair } from 'unsea';
import { createRelayIdentity } from '../src/relay-identity.js';
import { openSqliteD1 } from '../src/node/d1-sqlite.js';
import { OWNERS_TABLE, createNameRequest, handleNameRequest, relayHostname } from '../src/direct/names.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A fake Cloudflare DNS API for one zone. */
function fakeDns() {
  const store = [];
  let next = 1;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    const ok = (result) => new Response(JSON.stringify({ success: true, result }), { status: 200 });
    const id = u.pathname.split('/dns_records/')[1];
    if (method === 'GET') return ok(store.filter((r) => r.type === u.searchParams.get('type') && r.name === u.searchParams.get('name')));
    if (method === 'POST') { const r = { ...body, id: String(next++) }; store.push(r); return ok(r); }
    if (method === 'PUT') { const i = store.findIndex((r) => r.id === id); store[i] = { ...body, id }; return ok(store[i]); }
    if (method === 'DELETE') { const i = store.findIndex((r) => r.id === id); if (i >= 0) store.splice(i, 1); return ok({ id }); }
    return new Response('{}', { status: 400 });
  };
  return { store, fetchImpl };
}

async function identity() {
  const pair = await generateRandomPair();
  return createRelayIdentity(pair.pub, pair.priv);
}

const call = (body, env, fetchImpl, ip = '203.0.113.7') => handleNameRequest(new Request('https://w.example/api/v1/name', {
  method: 'POST', headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}), env, { fetchImpl }).then((r) => r.json().then((j) => ({ status: r.status, ...j })));

test('names: only registered relays get a name, pointing at the address they call from', async () => {
  const DB = await openSqliteD1({ filename: ':memory:', migrationsDir: path.join(ROOT, 'migrations') });
  const env = { NAMES_DNS_TOKEN: 't', NAMES_ZONE_ID: 'z', NAMES_DOMAIN: 'decentralize.ooo', DB };
  const dns = fakeDns();
  const me = await identity();
  const name = relayHostname(me.nodeId, 'decentralize.ooo');
  assert.equal(name.split(".")[0].length, 16);

  // Not registered yet.
  let r = await call(await createNameRequest(me, { action: 'claim' }), env, dns.fetchImpl);
  assert.equal(r.status, 403);
  assert.equal(dns.store.length, 0);

  // Registered (what `freertc name` does with the owner's login).
  await DB.prepare(`INSERT INTO ${OWNERS_TABLE} (node_id, added_at_ms) VALUES (?1, ?2)`).bind(me.nodeId, Date.now()).run();
  r = await call(await createNameRequest(me, { action: 'claim' }), env, dns.fetchImpl);
  assert.equal(r.ok, true);
  assert.equal(r.name, name);
  assert.deepEqual(dns.store.map((x) => [x.type, x.name, x.content, x.proxied]), [['A', name, '203.0.113.7', false]]);

  // Same address: nothing written. A new address: the record follows it.
  r = await call(await createNameRequest(me, { action: 'claim' }), env, dns.fetchImpl);
  assert.equal(r.changed, false);
  r = await call(await createNameRequest(me, { action: 'claim' }), env, dns.fetchImpl, '198.51.100.9');
  assert.deepEqual(dns.store.map((x) => [x.type, x.content]), [['A', '198.51.100.9']]);
  // Over IPv6: an AAAA record, and the old A goes.
  r = await call(await createNameRequest(me, { action: 'claim' }), env, dns.fetchImpl, '2001:db8::5');
  assert.deepEqual(dns.store.map((x) => [x.type, x.content]), [['AAAA', '2001:db8::5']]);

  // The Let's Encrypt challenge: set, then cleared.
  const token = 'x'.repeat(43);
  r = await call(await createNameRequest(me, { action: 'acme-set', value: token }), env, dns.fetchImpl);
  assert.equal(r.ok, true);
  const txt = dns.store.find((x) => x.type === 'TXT');
  assert.equal(txt.name, `_acme-challenge.${name}`);
  assert.equal(txt.content, `"${token}"`);
  r = await call(await createNameRequest(me, { action: 'acme-clear' }), env, dns.fetchImpl);
  assert.equal(dns.store.filter((x) => x.type === 'TXT').length, 0);

  // Someone else's signature, or an old request, is refused.
  const other = await identity();
  const forged = { ...(await createNameRequest(other, { action: 'claim' })), node_id: me.nodeId };
  assert.equal((await call(forged, env, dns.fetchImpl)).status, 400);
  const old = await createNameRequest(me, { action: 'claim', now: Date.now() - 10 * 60_000 });
  assert.equal((await call(old, env, dns.fetchImpl)).status, 400);
});

test('names: an open naming service answers any relay; without a token there are no names', async () => {
  const dns = fakeDns();
  const me = await identity();
  const open = { NAMES_DNS_TOKEN: 't', NAMES_ZONE_ID: 'z', NAMES_DOMAIN: 'relays.peer.ooo', NAMES_OPEN: '1' };
  const r = await call(await createNameRequest(me, { action: 'claim' }), open, dns.fetchImpl);
  assert.equal(r.name, relayHostname(me.nodeId, 'relays.peer.ooo'));
  const off = await call(await createNameRequest(me, { action: 'claim' }), { NAMES_DOMAIN: 'x.y' }, dns.fetchImpl);
  assert.equal(off.status, 404);
});
