import assert from 'node:assert/strict';
import test from 'node:test';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateRandomPair } from 'unsea';
import { createRelayIdentity } from '../src/relay-identity.js';
import {
  directAnswerSdp, directRelayUrl, directRelayLan, directoryRecordUrl, isDirectRelayUrl, parseDirectRelayUrl, parseRelayIceCredential, recordWssUrl, relayIceCredentialFor,
} from '../src/direct/common.js';
import {
  createSignedDirectoryRecord, createSignedWithdrawal, decodeDirectoryTxt, encodeDirectoryTxt, verifyDirectoryRecord,
} from '../src/direct/record.js';
import { clearDirectRelayCache, lookupDirectRelays } from '../src/direct/lookup.js';
import { handleDirectoryRequest } from '../src/direct/directory.js';
import { createDirectCertificate, loadOrCreateDirectCertificate } from '../src/direct/cert.js';
import { isNonPublicIPv4 } from '../src/direct/portmap.js';

const FP = 'a'.repeat(64);

async function identity() {
  const pair = await generateRandomPair();
  return createRelayIdentity(pair.pub, pair.priv);
}

test('direct relay URLs round-trip and refuse anything else', () => {
  const v4 = directRelayUrl({ host: '203.0.113.7', port: 9443, fingerprint: FP.toUpperCase() });
  assert.equal(v4, `webrtc-direct://203.0.113.7:9443/sha256/${FP}`);
  assert.deepEqual(parseDirectRelayUrl(v4), { host: '203.0.113.7', port: 9443, fingerprint: FP, family: 4 });
  const v6 = directRelayUrl({ host: '2001:db8::1', port: 9443, fingerprint: FP });
  assert.equal(parseDirectRelayUrl(v6).family, 6);
  for (const bad of ['wss://peer.ooo/ws', 'webrtc-direct://example.com:9443/sha256/' + FP, 'webrtc-direct://1.2.3.4:0/sha256/' + FP,
    'webrtc-direct://1.2.3.999:9443/sha256/' + FP, 'webrtc-direct://1.2.3.4:9443/sha256/abc']) {
    assert.equal(isDirectRelayUrl(bad), false, bad);
  }
});

test('the relay ICE credential carries the browser\'s own credentials', () => {
  const credential = relayIceCredentialFor('aB3d', 'x'.repeat(22) + '+/z');
  assert.deepEqual(parseRelayIceCredential(credential), { ufrag: 'aB3d', pwd: 'x'.repeat(22) + '+/z' });
  assert.equal(parseRelayIceCredential('freertc+direct+v1/ab/short'), null, 'too short for real ICE credentials');
  assert.equal(parseRelayIceCredential('other-prefix/abcd/' + 'x'.repeat(22)), null);
  const sdp = directAnswerSdp(parseDirectRelayUrl(directRelayUrl({ host: '203.0.113.7', port: 9443, fingerprint: FP })), credential);
  assert.match(sdp, /a=fingerprint:sha-256 AA:AA:/);
  assert.match(sdp, /a=setup:passive/);
  assert.match(sdp, /a=candidate:1 1 UDP 2130706431 203\.0\.113\.7 9443 typ host/);
});

test('directory records are signed, bound to their relay, and expire', async () => {
  const id = await identity();
  const direct = directRelayUrl({ host: '203.0.113.7', port: 9443, fingerprint: FP });
  const record = await createSignedDirectoryRecord(id, { direct, tunnel: `wss://peer.ooo/t/${id.nodeId}/ws`, name: 'air' });
  assert.equal(await verifyDirectoryRecord(record), true);
  assert.equal(await verifyDirectoryRecord({ ...record, direct: direct.replace('203.0.113.7', '198.51.100.9') }), false, 'a changed address breaks the signature');
  assert.equal(await verifyDirectoryRecord({ ...record, extra: 1 }), false, 'no unsigned extra fields');
  assert.equal(await verifyDirectoryRecord(record, { now: record.expires_at_ms + 1 }), false, 'expired');
  const other = await identity();
  await assert.rejects(createSignedDirectoryRecord(id, { direct, tunnel: `wss://peer.ooo/t/${other.nodeId}/ws` }), /own tunnel/);
  const stolenKey = { ...record, public_key: other.publicKey };
  assert.equal(await verifyDirectoryRecord(stolenKey), false, 'node id must be the hash of the key');
});

test('a record can carry the relay\'s LAN addresses, and the client tries them too', async () => {
  const id = await identity();
  const direct = directRelayUrl({ host: '203.0.113.7', port: 9443, fingerprint: FP });
  const tunnel = `wss://peer.ooo/t/${id.nodeId}/ws`;
  const record = await createSignedDirectoryRecord(id, { direct, tunnel, lan: ['192.168.50.20:9443', '8.8.8.8:9443', '10.0.0.5:9443'] });
  assert.deepEqual(record.lan, ['192.168.50.20:9443', '10.0.0.5:9443'], 'public addresses are not LAN addresses');
  assert.equal(await verifyDirectoryRecord(record), true);
  assert.equal(await verifyDirectoryRecord({ ...record, lan: ['192.168.50.21:9443', '10.0.0.5:9443'] }), false, 'lan is signed');
  const none = await createSignedDirectoryRecord(id, { direct, tunnel });
  assert.equal('lan' in none, false, 'no lan field when there is none');
  const url = directoryRecordUrl(record);
  assert.deepEqual(directRelayLan(url), ['192.168.50.20:9443', '10.0.0.5:9443']);
  assert.equal(new URLSearchParams(url.split('?')[1]).get('tunnel'), tunnel);
  const sdp = directAnswerSdp(parseDirectRelayUrl(direct), relayIceCredentialFor('aB3d', 'x'.repeat(22)), directRelayLan(url));
  assert.match(sdp, /a=candidate:1 1 UDP 2130706431 203\.0\.113\.7 9443 typ host/);
  assert.match(sdp, /a=candidate:2 1 UDP 2130706430 192\.168\.50\.20 9443 typ host/);
  assert.match(sdp, /a=candidate:3 1 UDP 2130706430 10\.0\.0\.5 9443 typ host/);
});

test('a record can carry the relay\'s open TCP port, at its own address only', async () => {
  const id = await identity();
  const direct = directRelayUrl({ host: '203.0.113.7', port: 9443, fingerprint: FP });
  const record = await createSignedDirectoryRecord(id, { direct, ws: 'ws://203.0.113.7:8788/ws' });
  assert.equal(record.ws, 'ws://203.0.113.7:8788/ws');
  assert.equal(await verifyDirectoryRecord(record), true);
  const elsewhere = await createSignedDirectoryRecord(id, { direct, ws: 'ws://198.51.100.9:8788/ws' });
  assert.equal('ws' in elsewhere, false, 'another address is not this relay\'s port');
  assert.equal(await verifyDirectoryRecord({ ...record, ws: 'ws://198.51.100.9:8788/ws' }), false);
});

test('directory TXT encoding round-trips in 255-character strings', async () => {
  const id = await identity();
  const record = await createSignedDirectoryRecord(id, { direct: directRelayUrl({ host: '203.0.113.7', port: 9443, fingerprint: FP }) });
  const txt = encodeDirectoryTxt(record);
  for (const chunk of txt.match(/"[^"]*"/g)) assert.ok(chunk.length - 2 <= 255);
  assert.ok(txt.length < 2048, 'fits a Cloudflare TXT record');
  assert.deepEqual(decodeDirectoryTxt(txt), record);
  assert.equal(decodeDirectoryTxt('"v=spf1 -all"'), null);
});

function dohResponder(records, { fail = false } = {}) {
  return async (url) => {
    if (fail) throw new Error('resolver down');
    assert.match(url, /name=_relays\.peer\.ooo&type=TXT/);
    return new Response(JSON.stringify({ Status: 0, Answer: records.map((data) => ({ name: '_relays.peer.ooo', type: 16, TTL: 300, data })) }));
  };
}

test('peers find relays with one DNS-over-HTTPS lookup and keep only valid ones', async () => {
  clearDirectRelayCache();
  const a = await identity();
  const b = await identity();
  const good = await createSignedDirectoryRecord(a, { direct: directRelayUrl({ host: '203.0.113.7', port: 9443, fingerprint: FP }) });
  const other = await createSignedDirectoryRecord(b, { direct: directRelayUrl({ host: '203.0.113.8', port: 9443, fingerprint: FP }) });
  const forged = { ...other, direct: directRelayUrl({ host: '192.0.2.66', port: 9443, fingerprint: FP }) };
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls += 1;
    if (url.startsWith('https://first')) throw new Error('down');
    return dohResponder([encodeDirectoryTxt(good), encodeDirectoryTxt(other), encodeDirectoryTxt(forged), '"unrelated"'])(url, options);
  };
  const found = await lookupDirectRelays({ dohUrls: ['https://first/dns-query', 'https://second/dns-query'], fetchImpl, network: 'net', room: 'room' });
  assert.deepEqual(found.map((r) => r.node_id).sort(), [a.nodeId, b.nodeId].sort());
  assert.equal(calls, 2, 'tried the second resolver after the first failed');
  const again = await lookupDirectRelays({ dohUrls: ['https://second/dns-query'], fetchImpl, network: 'net', room: 'room' });
  assert.equal(calls, 2, 'answered from cache');
  assert.deepEqual(again.map((r) => r.node_id), found.map((r) => r.node_id), 'the same order for the same room');
});

function fakeCloudflare(health = {}) {
  const records = new Map();
  let next = 1;
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const u = new URL(url);
    if (u.hostname !== 'api.cloudflare.com') {
      calls.push(`PROBE ${u.host}${u.pathname}`);
      const answer = health[u.host];
      if (!answer) throw new TypeError('fetch failed');
      return new Response(JSON.stringify(answer));
    }
    const method = options.method || 'GET';
    calls.push(`${method} ${u.pathname.replace(/^.*dns_records/, 'dns_records')}`);
    assert.equal(options.headers.Authorization, 'Bearer token-1');
    const ok = (result) => new Response(JSON.stringify({ success: true, result }));
    if (method === 'GET') {
      const comment = u.searchParams.get('comment.exact');
      return ok([...records.values()].filter((r) => r.name === u.searchParams.get('name') && (!comment || r.comment === comment)));
    }
    const id = u.pathname.split('/').pop();
    if (method === 'POST') { const r = { ...JSON.parse(options.body), id: `r${next++}` }; records.set(r.id, r); return ok(r); }
    if (method === 'PUT') { records.set(id, { ...JSON.parse(options.body), id }); return ok(records.get(id)); }
    if (method === 'DELETE') { records.delete(id); return ok({ id }); }
    return new Response('{}', { status: 400 });
  };
  return { records, calls, fetchImpl };
}

const ENV = { DIRECTORY_DNS_TOKEN: 'token-1', DIRECTORY_ZONE_ID: 'zone-1', DIRECTORY_RECORD_NAME: '_relays.peer.ooo' };

function post(body, ip, method = 'POST') {
  return new Request('https://peer.ooo/api/v1/directory', { method, body: JSON.stringify(body), headers: { 'CF-Connecting-IP': ip } });
}

test('the directory lists a relay only at the address it publishes from, and only once', async () => {
  const cf = fakeCloudflare();
  const id = await identity();
  const record = await createSignedDirectoryRecord(id, { direct: directRelayUrl({ host: '203.0.113.7', port: 9443, fingerprint: FP }) });
  const elsewhere = await handleDirectoryRequest(post(record, '198.51.100.1'), ENV, { fetchImpl: cf.fetchImpl });
  assert.equal(elsewhere.status, 400);
  assert.equal((await elsewhere.json()).seen, '198.51.100.1');
  assert.equal(cf.records.size, 0, 'nothing listed for someone else\'s address');

  const first = await (await handleDirectoryRequest(post(record, '203.0.113.7'), ENV, { fetchImpl: cf.fetchImpl })).json();
  assert.equal(first.published, true);
  assert.equal(cf.records.size, 1);
  const entry = [...cf.records.values()][0];
  assert.equal(entry.comment, `freertc:${id.nodeId}`);
  assert.deepEqual(decodeDirectoryTxt(entry.content), record);

  const writes = cf.calls.filter((c) => !c.startsWith('GET')).length;
  const again = await (await handleDirectoryRequest(post(await createSignedDirectoryRecord(id, { direct: record.direct }), '203.0.113.7'), ENV, { fetchImpl: cf.fetchImpl })).json();
  assert.equal(again.published, false, 'unchanged: no DNS write');
  assert.equal(cf.calls.filter((c) => !c.startsWith('GET')).length, writes);

  // A new open port or LAN address is a change, written once the minute is up.
  const later = Date.now() + 2 * 60_000;
  const withPort = await createSignedDirectoryRecord(id, { direct: record.direct, ws: 'ws://203.0.113.7:8788/ws', lan: ['192.168.50.20:9443'], now: Date.now() + 30_000 });
  const soon = await handleDirectoryRequest(post(withPort, '203.0.113.7'), ENV, { fetchImpl: cf.fetchImpl, now: Date.now() + 30_000 });
  assert.equal(soon.status, 429, 'too soon after the last write');
  const written = await (await handleDirectoryRequest(post(withPort, '203.0.113.7'), ENV, { fetchImpl: cf.fetchImpl, now: later })).json();
  assert.equal(written.published, true, 'the open port and LAN address are written');
  assert.equal(decodeDirectoryTxt([...cf.records.values()][0].content).ws, 'ws://203.0.113.7:8788/ws');
});

test('a relay withdraws only its own entry, and dead entries are cleaned up', async () => {
  const cf = fakeCloudflare();
  const a = await identity();
  const b = await identity();
  const now = Date.now();
  const old = await createSignedDirectoryRecord(b, { direct: directRelayUrl({ host: '203.0.113.8', port: 9443, fingerprint: FP }), ttlMs: 60_000, now: now - 10 * 60_000 });
  cf.records.set('dead', { id: 'dead', type: 'TXT', name: '_relays.peer.ooo', content: encodeDirectoryTxt(old), comment: `freertc:${b.nodeId}` });
  cf.records.set('mine-not', { id: 'mine-not', type: 'TXT', name: '_relays.peer.ooo', content: '"someone else"', comment: 'manual' });
  const record = await createSignedDirectoryRecord(a, { direct: directRelayUrl({ host: '203.0.113.7', port: 9443, fingerprint: FP }) });
  const result = await (await handleDirectoryRequest(post(record, '203.0.113.7'), ENV, { fetchImpl: cf.fetchImpl })).json();
  assert.equal(result.cleaned, 1);
  assert.equal(cf.records.has('dead'), false, 'expired entry removed');
  assert.equal(cf.records.has('mine-not'), true, 'records the directory did not write are left alone');

  const forgedWithdrawal = { ...(await createSignedWithdrawal(b)), node_id: a.nodeId };
  assert.equal((await handleDirectoryRequest(post(forgedWithdrawal, '1.1.1.1', 'DELETE'), ENV, { fetchImpl: cf.fetchImpl })).status, 400);
  const withdrawn = await (await handleDirectoryRequest(post(await createSignedWithdrawal(a), '1.1.1.1', 'DELETE'), ENV, { fetchImpl: cf.fetchImpl })).json();
  assert.equal(withdrawn.removed, 1);
  assert.equal([...cf.records.values()].some((r) => r.comment === `freertc:${a.nodeId}`), false);
});

test('republishing clears out listed relays that are gone or answered by another relay', async () => {
  const a = await identity();
  const gone = await identity();
  const replaced = await identity();
  const alive = await identity();
  const cf = fakeCloudflare({
    '203.0.113.9:8788': { ok: true, node_id: a.nodeId }, // the port now reaches relay a
    '203.0.113.10:8788': { ok: true, node_id: null }, // says nothing about who it is
  });
  const listed = async (id, host, ws) => {
    const record = await createSignedDirectoryRecord(id, { direct: directRelayUrl({ host, port: 9443, fingerprint: FP }), ws });
    cf.records.set(id.nodeId, { id: id.nodeId, type: 'TXT', name: '_relays.peer.ooo', content: encodeDirectoryTxt(record), comment: `freertc:${id.nodeId}` });
  };
  await listed(a, '203.0.113.9', 'ws://203.0.113.9:8788/ws');
  await listed(gone, '203.0.113.8', 'ws://203.0.113.8:8788/ws');
  await listed(replaced, '203.0.113.9', 'ws://203.0.113.9:8788/ws');
  await listed(alive, '203.0.113.10', 'ws://203.0.113.10:8788/ws');
  const behindNat = await identity();
  const noPort = await createSignedDirectoryRecord(behindNat, { direct: directRelayUrl({ host: '203.0.113.11', port: 9443, fingerprint: FP }) });
  cf.records.set('nat', { id: 'nat', type: 'TXT', name: '_relays.peer.ooo', content: encodeDirectoryTxt(noPort), comment: `freertc:${behindNat.nodeId}` });

  const again = await createSignedDirectoryRecord(a, { direct: directRelayUrl({ host: '203.0.113.9', port: 9443, fingerprint: FP }), ws: 'ws://203.0.113.9:8788/ws' });
  const result = await (await handleDirectoryRequest(post(again, '203.0.113.9'), ENV, { fetchImpl: cf.fetchImpl })).json();
  assert.equal(result.published, false, 'unchanged');
  assert.equal(result.cleaned, 2);
  assert.equal(cf.records.has(gone.nodeId), false, 'nobody answers: removed');
  assert.equal(cf.records.has(replaced.nodeId), false, 'another relay answers its port: removed');
  assert.equal(cf.records.has(alive.nodeId), true);
  assert.equal(cf.records.has('nat'), true, 'no open port to check: kept');
  assert.equal(cf.records.has(a.nodeId), true);
});

test('the directory lookup puts the newest entry first', async () => {
  const older = await createSignedDirectoryRecord(await identity(), { direct: directRelayUrl({ host: '203.0.113.20', port: 9443, fingerprint: FP }), now: Date.now() - 60 * 60_000 });
  const newer = await createSignedDirectoryRecord(await identity(), { direct: directRelayUrl({ host: '203.0.113.21', port: 9443, fingerprint: FP }) });
  const fetchImpl = async () => new Response(JSON.stringify({ Answer: [older, newer].map((r) => ({ type: 16, data: encodeDirectoryTxt(r) })) }));
  const found = await lookupDirectRelays({ name: '_newest.test', dohUrls: ['https://x/dns-query'], fetchImpl, useCache: false });
  assert.deepEqual(found.map((r) => r.node_id), [newer.node_id, older.node_id]);
});

test('the directory is off without a token', async () => {
  const response = await handleDirectoryRequest(post({}, '1.1.1.1'), {}, { fetchImpl: () => assert.fail('no DNS calls') });
  assert.equal(response.status, 404);
});

test('the direct certificate is self-signed P-256 and kept across restarts', () => {
  const made = createDirectCertificate();
  const cert = new X509Certificate(made.certPem);
  assert.equal(cert.verify(cert.publicKey), true);
  assert.equal(cert.fingerprint256.replace(/:/g, '').toLowerCase(), made.fingerprint);
  const dir = mkdtempSync(path.join(tmpdir(), 'freertc-direct-'));
  const first = loadOrCreateDirectCertificate(dir);
  const second = loadOrCreateDirectCertificate(dir);
  assert.equal(first.fingerprint, second.fingerprint);
});

test('non-public router addresses are recognised', () => {
  for (const ip of ['10.0.0.1', '192.168.1.1', '172.20.0.1', '100.64.1.2', '127.0.0.1', '169.254.1.1']) assert.equal(isNonPublicIPv4(ip), true, ip);
  assert.equal(isNonPublicIPv4('203.0.113.7'), false);
});

test('a WebRTC client connects to the direct listener with no signaling', async (t) => {
  const { directListenerAvailable } = await import('../src/direct/listener.js');
  if (!await directListenerAvailable()) return t.skip('node-datachannel 0.33+ not installed');
  // In its own process: node-datachannel's native threads can keep a process alive.
  const { execFile } = await import('node:child_process');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const output = await new Promise((resolve, reject) => {
    execFile(process.execPath, [new URL('./fixtures/direct-loopback.mjs', import.meta.url).pathname, String(port)], { timeout: 25_000 }, (error, stdout) => {
      if (error && !stdout) reject(error); else resolve(stdout);
    });
  });
  const result = JSON.parse(output.trim().split('\n').pop());
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.reply, 'echo:hello');
  assert.equal(result.viaLan, 'echo:lan', 'reached through its LAN address when the public one does not answer');
  assert.match(result.wrongFingerprint, /^refused/, 'a wrong fingerprint is refused');
});

test('a resolver still holding an empty answer does not hide a relay another resolver returns', async () => {
  const record = await createSignedDirectoryRecord(await identity(), { direct: directRelayUrl({ host: '203.0.113.30', port: 9443, fingerprint: FP }) });
  const fetchImpl = async (url) => new Response(JSON.stringify(url.startsWith('https://stale/')
    ? { Status: 0 } // a cached "nothing here"
    : { Answer: [{ type: 16, data: encodeDirectoryTxt(record) }] }));
  const found = await lookupDirectRelays({ name: '_stale.test', dohUrls: ['https://stale/dns-query', 'https://fresh/dns-query'], fetchImpl, useCache: false });
  assert.deepEqual(found.map((r) => r.node_id), [record.node_id]);
});

test('a relay that showed the directory a post-quantum key is listed or withdrawn only with that key', async () => {
  const { openSqliteD1 } = await import('../src/node/d1-sqlite.js');
  const { signDirectoryPq } = await import('../src/relay-identity.js');
  const { PQ_KEY_HEADER, PQ_SIGNATURE_HEADER } = await import('../src/direct/directory.js');
  const emptyMigrations = mkdtempSync(path.join(tmpdir(), 'freertc-mig-'));
  const env = { ...ENV, DB: await openSqliteD1({ filename: ':memory:', migrationsDir: emptyMigrations }) };
  const cf = fakeCloudflare();
  const pair = await generateRandomPair();
  const id = await createRelayIdentity(pair.pub, pair.priv);
  const pq = { pub: pair.pub, priv: pair.priv, qpub: pair.qpub, qpriv: pair.qpriv };
  const send = async (body, keys, method = 'POST') => {
    const headers = { 'CF-Connecting-IP': '203.0.113.7' };
    if (keys) Object.assign(headers, { [PQ_KEY_HEADER]: keys.qpub, [PQ_SIGNATURE_HEADER]: await signDirectoryPq(keys, body) });
    return handleDirectoryRequest(new Request('https://peer.ooo/api/v1/directory', { method, body: JSON.stringify(body), headers }), env, { fetchImpl: cf.fetchImpl });
  };
  const direct = directRelayUrl({ host: '203.0.113.7', port: 9443, fingerprint: FP });

  const first = await send(await createSignedDirectoryRecord(id, { direct }), pq);
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal((await first.json()).published, true);

  // P-256 alone (what a forger of the relay's ECDSA signature has) is refused now.
  const plain = await send(await createSignedDirectoryRecord(id, { direct, name: 'changed' }), null);
  assert.equal(plain.status, 403);
  // So is another post-quantum key for the same node id.
  const other = await generateRandomPair();
  const swapped = await send(await createSignedDirectoryRecord(id, { direct, name: 'changed' }), { ...pq, qpub: other.qpub, qpriv: other.qpriv });
  assert.equal(swapped.status, 403);
  assert.match((await swapped.json()).error, /not the post-quantum key/);
  // A signature over another record does not carry over.
  const record = await createSignedDirectoryRecord(id, { direct });
  const mismatched = await handleDirectoryRequest(new Request('https://peer.ooo/api/v1/directory', {
    method: 'POST', body: JSON.stringify(record),
    headers: { 'CF-Connecting-IP': '203.0.113.7', [PQ_KEY_HEADER]: pq.qpub, [PQ_SIGNATURE_HEADER]: await signDirectoryPq(pq, { ...record, name: 'x' }) },
  }), env, { fetchImpl: cf.fetchImpl });
  assert.equal(mismatched.status, 403);

  assert.equal((await send(await createSignedWithdrawal(id), null, 'DELETE')).status, 403, 'nor withdrawn without it');
  const withdrawn = await send(await createSignedWithdrawal(id), pq, 'DELETE');
  assert.equal((await withdrawn.json()).removed, 1);

  // A relay that never showed a key (older code) is listed as before.
  const plainPair = await generateRandomPair();
  const plainId = await createRelayIdentity(plainPair.pub, plainPair.priv);
  const old = await handleDirectoryRequest(post(await createSignedDirectoryRecord(plainId, { direct: directRelayUrl({ host: '203.0.113.9', port: 9443, fingerprint: FP }) }), '203.0.113.9'), env, { fetchImpl: cf.fetchImpl });
  assert.equal(old.status, 200);
});

test('a directory entry carries a wss name only when DNS for it points at the relay', async () => {
  const id = await identity();
  const direct = directRelayUrl({ host: '203.0.113.7', port: 9443, fingerprint: FP });
  const name = 'wss://abcdef0123456789abcd.decentralize.ooo:8443/ws';
  const record = await createSignedDirectoryRecord(id, { direct, name });
  assert.equal(recordWssUrl(record), name);
  // DNS points the name elsewhere: refused, nothing listed.
  const wrong = fakeCloudflare({ 'cloudflare-dns.com': { Answer: [{ type: 1, data: '198.51.100.1' }] } });
  const refused = await handleDirectoryRequest(post(record, '203.0.113.7'), ENV, { fetchImpl: wrong.fetchImpl });
  assert.equal(refused.status, 400);
  assert.equal(wrong.records.size, 0);
  // DNS points it at the relay: listed, name and all.
  const right = fakeCloudflare({ 'cloudflare-dns.com': { Answer: [{ type: 1, data: '203.0.113.7' }] } });
  const listed = await (await handleDirectoryRequest(post(record, '203.0.113.7'), ENV, { fetchImpl: right.fetchImpl })).json();
  assert.equal(listed.ok, true);
  const entry = decodeDirectoryTxt([...right.records.values()][0].content);
  assert.equal(recordWssUrl(entry), name);
  assert.equal(await verifyDirectoryRecord(entry), true);
  // A plain name (a label) needs no DNS check, and is no wss address.
  assert.equal(recordWssUrl({ name: 'freertc-node-127.0.0.1-8788' }), null);
  assert.equal(recordWssUrl({ name: 'wss://203.0.113.7:8443/ws' }), null);
});
