// A node relay keeps PigeonIdP accounts for the browsers on it, and they
// survive a restart; a browser reaches them with client.relayRequest().
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import WebSocket from 'ws';
import { generateRandomPair } from 'unsea';
import { createSignalingClient } from 'freertc/client';

let records = null;
try { records = await import('pigeonidp/records'); } catch { /* not installed: skipped below */ }

const SERVER = fileURLToPath(new URL('../scripts/node-relay.mjs', import.meta.url));
const PORT = 18_900 + Math.floor(Math.random() * 90);

async function startRelay(dataDir, extraEnv = {}, port = PORT) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', FREERTC_FEDERATION: 'off', FREERTC_DIRECT: 'off', FREERTC_PUNCH: 'off', FREERTC_DATA_DIR: dataDir, ...extraEnv },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('relay did not start')), 8000);
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      if (/\[node-relay\] .* on https?:\/\//.test(output)) { clearTimeout(timer); resolve(); }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`relay exited early with ${code}`)); });
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  return { child, output: () => output };
}

async function stopRelay(relay) {
  const exited = new Promise((resolve) => relay.child.once('exit', resolve));
  relay.child.kill('SIGTERM');
  await exited;
}

async function registeredClient(port = PORT) {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = WebSocket;
  const client = createSignalingClient({
    peerId: Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join(''),
    networkId: 'pigeonchess',
    roomId: 'global',
    signalUrl: `ws://127.0.0.1:${port}/ws`,
    autoConnect: false,
  });
  client.connect()
  for (let i = 0; i < 50 && !client.isRegistered; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  globalThis.WebSocket = original;
  assert.equal(client.isRegistered, true, 'registered on the relay');
  return client;
}

test('accounts kept by a node relay survive its restart', { skip: !records && 'pigeonidp not installed' }, async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'freertc-accounts-'));
  let relay = await startRelay(dataDir);
  assert.match(relay.output(), /accounts: kept for browsers on this relay/);
  let client = await registeredClient();
  try {
    const keys = await generateRandomPair();
    const record = await records.createAccountRecord({ alias: 'Dan', namespace: 'pigeon-chess', keys, password: 'Correct-Horse-9' });
    assert.deepEqual(await client.relayRequest({ action: 'idp-put', record }), { ok: true, stored: true });

    const thief = await generateRandomPair();
    const stolen = await records.createAccountRecord({ alias: 'dan', namespace: 'pigeon-chess', keys: thief, password: 'x' });
    assert.deepEqual(await client.relayRequest({ action: 'idp-put', record: stolen }), { ok: false, error: 'taken' });

    client.disconnect();
    await stopRelay(relay);
    relay = await startRelay(dataDir);
    client = await registeredClient();

    const answer = await client.relayRequest({ action: 'idp-get', namespace: 'pigeon-chess', alias: 'dan' });
    assert.equal(answer.ok, true);
    assert.equal((await records.openAccountRecord(answer.record, 'Correct-Horse-9')).pub, keys.pub);
    assert.deepEqual(await client.relayRequest({ action: 'no-such-thing' }), { ok: false, error: 'unsupported' });
  } finally {
    client.disconnect();
    await stopRelay(relay);
  }
});

test('with FREERTC_IDP=off the relay answers account requests as unsupported', async () => {
  const relay = await startRelay(mkdtempSync(path.join(tmpdir(), 'freertc-accounts-')), { FREERTC_IDP: 'off' });
  const client = await registeredClient();
  try {
    assert.match(relay.output(), /accounts: off \(FREERTC_IDP=off\)/);
    assert.deepEqual(await client.relayRequest({ action: 'idp-get', namespace: 'x', alias: 'y' }), { ok: false, error: 'unsupported' });
  } finally {
    client.disconnect();
    await stopRelay(relay);
  }
});

test('local relays share accounts with each other', { skip: !records && 'pigeonidp not installed' }, async () => {
  const portA = PORT + 100;
  const portB = PORT + 101;
  const mesh = { FREERTC_FEDERATION: 'on', FREERTC_PUBLIC: 'false', FREERTC_TUNNEL: 'off', FREERTC_LINKS: 'off', FREERTC_LAN: 'off' };
  const a = await startRelay(mkdtempSync(path.join(tmpdir(), 'freertc-accounts-a-')), { ...mesh, RELAY_URL: `ws://127.0.0.1:${portA}/ws` }, portA);
  const b = await startRelay(mkdtempSync(path.join(tmpdir(), 'freertc-accounts-b-')), { ...mesh, RELAY_URL: `ws://127.0.0.1:${portB}/ws`, KADEMLIA_BOOTSTRAP_URLS: `ws://127.0.0.1:${portA}/ws` }, portB);
  const knows = async (port, other) => {
    const list = await fetch(`http://127.0.0.1:${port}/api/v1/relays`).then((r) => r.json()).catch(() => null);
    return JSON.stringify(list ?? '').includes(`127.0.0.1:${other}`);
  };
  for (let i = 0; i < 60 && !(await knows(portA, portB) && await knows(portB, portA)); i++) await new Promise((r) => setTimeout(r, 500));
  const clientA = await registeredClient(portA);
  const clientB = await registeredClient(portB);
  try {
    const keys = await generateRandomPair();
    const record = await records.createAccountRecord({ alias: 'Pat', namespace: 'pigeon-chess', keys, password: 'Correct-Horse-9' });
    assert.deepEqual(await clientA.relayRequest({ action: 'idp-put', record }), { ok: true, stored: true });
    let found = null;
    for (let i = 0; i < 20 && !found; i++) {
      found = (await clientB.relayRequest({ action: 'idp-get', namespace: 'pigeon-chess', alias: 'pat' })).record;
      if (!found) await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(found?.pub, keys.pub, 'the other local relay has it');

    const thief = await generateRandomPair();
    const stolen = await records.createAccountRecord({ alias: 'Pat', namespace: 'pigeon-chess', keys: thief, password: 'x' });
    assert.deepEqual(await clientB.relayRequest({ action: 'idp-put', record: stolen }), { ok: false, error: 'taken' });

    const viaHttp = await fetch(`http://127.0.0.1:${portB}/api/v1/idp`, { method: 'POST', body: JSON.stringify({ action: 'idp-get', namespace: 'pigeon-chess', alias: 'PAT' }) }).then((r) => r.json());
    assert.equal(viaHttp.record?.pub, keys.pub);
  } finally {
    clientA.disconnect();
    clientB.disconnect();
    await stopRelay(a);
    await stopRelay(b);
  }
});
