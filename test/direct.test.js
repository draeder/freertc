import assert from 'node:assert/strict';
import test from 'node:test';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateRandomPair } from 'unsea';
import { createRelayIdentity } from '../src/relay-identity.js';
import {
  directAnswerSdp, directRelayUrl, isDirectRelayUrl, parseDirectRelayUrl, parseRelayIceCredential, relayIceCredentialFor,
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

function fakeCloudflare() {
  const records = new Map();
  let next = 1;
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const u = new URL(url);
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
  assert.match(result.wrongFingerprint, /^refused/, 'a wrong fingerprint is refused');
});
