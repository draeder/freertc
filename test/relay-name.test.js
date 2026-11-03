import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateRandomPair } from 'unsea';
import { createRelayIdentity } from '../src/relay-identity.js';
import { handleNameRequest, relayHostname } from '../src/direct/names.js';
import { certificateState, loadNameSettings, startRelayName, waitForTxt } from '../src/node/relay-name.js';

const hasOpenssl = spawnSync('openssl', ['version']).status === 0;

function selfSigned(dir, name, days = 80) {
  const key = path.join(dir, `${name}.key`), crt = path.join(dir, `${name}.crt`);
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', crt, '-days', String(days), '-subj', `/CN=${name}`, '-addext', `subjectAltName=DNS:${name}`]);
  assert.equal(r.status, 0, String(r.stderr));
}

test('relay names: settings from the data directory, and certificate checks', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'names-'));
  assert.equal(loadNameSettings(dir, {}), null);
  writeFileSync(path.join(dir, 'names.json'), JSON.stringify({ worker: 'https://freertc.example.workers.dev', domain: 'decentralize.ooo' }));
  assert.equal(loadNameSettings(dir, {}).worker, 'https://freertc.example.workers.dev');
  assert.equal(loadNameSettings(dir, { FREERTC_NAMES_URL: 'https://other.example' }).worker, 'https://other.example');
  assert.deepEqual(certificateState('not a certificate', 'x.example'), { days: -1, forName: false });
});

test('relay names: waits until public DNS shows the challenge record', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response(JSON.stringify({ Answer: calls > 2 ? [{ data: '"the-value-1234567890123"' }] : [] }));
  };
  assert.equal(await waitForTxt('_acme-challenge.a.example', 'the-value-1234567890123', { fetchImpl, everyMs: 1, timeoutMs: 1000 }), true);
  assert.equal(await waitForTxt('_acme-challenge.a.example', 'never', { fetchImpl: async () => new Response('{}'), everyMs: 1, timeoutMs: 20 }), false);
});

test('relay names: claims its name from its Worker, serves the certificate, and lists wss://<name>:<port>/ws', { skip: !hasOpenssl && 'no openssl to make a test certificate' }, async () => {
  const pair = await generateRandomPair();
  const identity = await createRelayIdentity(pair.pub, pair.priv);
  const domain = 'decentralize.ooo';
  const name = relayHostname(identity.nodeId, domain);
  const dataDir = mkdtempSync(path.join(tmpdir(), 'relay-'));
  mkdirSync(path.join(dataDir, 'tls'), { recursive: true });
  selfSigned(path.join(dataDir, 'tls'), name);
  // The owner's Worker (an open one here) in front of a fake DNS.
  const dns = [];
  const dnsFetch = async (url, init = {}) => {
    const u = new URL(url);
    if ((init.method || 'GET') === 'GET') return new Response(JSON.stringify({ success: true, result: dns.filter((r) => r.type === u.searchParams.get('type') && r.name === u.searchParams.get('name')) }));
    dns.push({ ...JSON.parse(init.body), id: String(dns.length + 1) });
    return new Response(JSON.stringify({ success: true, result: {} }));
  };
  const env = { NAMES_DNS_TOKEN: 't', NAMES_ZONE_ID: 'z', NAMES_DOMAIN: domain, NAMES_OPEN: '1' };
  const fetchImpl = async (url, init) => {
    const request = new Request(url, { ...init, headers: { ...init.headers, 'CF-Connecting-IP': '203.0.113.7' } });
    return handleNameRequest(request, env, { fetchImpl: dnsFetch });
  };
  const certs = [], addresses = [];
  const relay = await startRelayName({
    identity, dataDir, worker: 'https://freertc.example.workers.dev', tlsPort: 8443,
    mapPort: async (port) => ({ externalIp: '203.0.113.7', externalPort: port, close: async () => {} }),
    onCertificate: (c) => certs.push(c),
    onAddress: (url) => addresses.push(url),
    fetchImpl,
  });
  try {
    assert.equal(relay.name, name);
    assert.deepEqual(dns.map((r) => [r.type, r.name, r.content]), [['A', name, '203.0.113.7']]);
    assert.equal(certs.length, 1);
    assert.equal(certs[0].name, name);
    assert.match(certs[0].cert, /BEGIN CERTIFICATE/);
    assert.deepEqual(addresses, [`wss://${name}:8443/ws`]);
    assert.equal(relay.wssUrl, `wss://${name}:8443/ws`);
  } finally {
    relay.stop();
  }
});

test('freertc name: arguments, and the same relay identity the relay uses', async () => {
  const { parseArgs, relayIdentity } = await import('../scripts/name-setup.mjs');
  assert.deepEqual(parseArgs(['--domain', 'Decentralize.OOO.', '--worker=freertc']), { domain: 'decentralize.ooo', worker: 'freertc' });
  const dir = mkdtempSync(path.join(tmpdir(), 'ident-'));
  const a = await relayIdentity(dir), b = await relayIdentity(dir);
  assert.equal(a.nodeId, b.nodeId, 'kept in the data directory, as the relay keeps it');
});
