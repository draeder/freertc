#!/usr/bin/env node
// npx freertc name [--domain example.com] [--worker <script name>]
//
// Gives the local relay on this machine a name and a certificate on your own
// domain, kept by your own FreeRTC Worker (src/direct/names.js,
// src/node/relay-name.js). Run it once on each machine that runs a relay:
//
//   1. Log in to Cloudflare with wrangler, adding two permissions to the usual
//      ones: edit DNS, and create API tokens. (A browser window: click Allow.)
//   2. Find your FreeRTC Worker (by its /health) and the domain (a zone in
//      your account).
//   3. The first time: create an API token that can only edit DNS on that
//      domain, and store it in the Worker (NAMES_DNS_TOKEN, NAMES_ZONE_ID,
//      NAMES_DOMAIN). The token is never shown or kept on this machine.
//   4. Register this relay with the Worker: its node id goes in the Worker's
//      database (table freertc_name_owners), so the Worker gives names only
//      to your relays.
//   5. Write <data dir>/names.json; the relay picks it up when it next starts.
//
// Everything goes through Cloudflare's API with your login, so it works
// whether the Worker came from the Deploy button or from `npm run deploy`.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { generateRandomPair } from 'unsea';
import { createRelayIdentity, decodeRelayIdentitySecret, encodeRelayIdentitySecret } from '../src/relay-identity.js';
import { OWNERS_TABLE, relayHostname } from '../src/direct/names.js';
import { resolveProjectRoot, resolveWranglerCommand } from './project-bootstrap.mjs';

const API = 'https://api.cloudflare.com/client/v4';
/** Wrangler's usual login permissions (wrangler 4.x), plus the two this needs. */
const USUAL_SCOPES = [
  'account:read', 'user:read', 'workers:write', 'workers_kv:write', 'workers_routes:write', 'workers_scripts:write',
  'workers_tail:read', 'd1:write', 'pages:write', 'zone:read', 'ssl_certs:write', 'ai:write', 'queues:write',
  'pipelines:write', 'secrets_store:write', 'containers:write', 'cloudchamber:write', 'connectivity:admin',
  'email_routing:write', 'email_sending:write', 'browser:write',
];
const CORE_SCOPES = ['account:read', 'user:read', 'workers:write', 'workers_scripts:write', 'workers_routes:write', 'workers_kv:write', 'workers_tail:read', 'd1:write', 'pages:write', 'zone:read'];
const EXTRA_SCOPES = ['dns_records:edit', 'account_api_tokens:create'];
/** Cloudflare's permission group "DNS Write" (zone scope), if the list cannot be read. */
const DNS_WRITE_GROUP = '4755a26eedb94da69e1066d98aa820be';

const ROOT = resolveProjectRoot(process.cwd());
const say = (line) => console.log(`[freertc name] ${line}`);

export function parseArgs(args) {
  const out = { domain: null, worker: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--domain') out.domain = args[++i];
    else if (args[i].startsWith('--domain=')) out.domain = args[i].slice(9);
    else if (args[i] === '--worker') out.worker = args[++i];
    else if (args[i].startsWith('--worker=')) out.worker = args[i].slice(9);
  }
  if (out.domain) out.domain = out.domain.toLowerCase().replace(/\.$/, '');
  return out;
}

/** This relay's identity: the same file the relay keeps (generated now if it has not run yet). */
export async function relayIdentity(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'relay-identity.json');
  let secret = process.env.RELAY_IDENTITY_SECRET || (existsSync(file) ? readFileSync(file, 'utf8').trim() : null);
  if (!secret) {
    const pair = await generateRandomPair();
    secret = encodeRelayIdentitySecret(pair.pub, pair.priv);
    writeFileSync(file, secret, { mode: 0o600 });
  }
  const { publicKey, privateKey } = decodeRelayIdentitySecret(secret);
  return createRelayIdentity(publicKey, privateKey);
}

function wrangler(args, options = {}) {
  const w = resolveWranglerCommand(ROOT);
  return spawnSync(w.command, [...w.baseArgs, ...args], { cwd: ROOT, encoding: 'utf8', env: process.env, ...options });
}

function oauthToken() {
  const result = wrangler(['auth', 'token', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const parsed = JSON.parse(String(result.stdout).trim().split('\n').filter((l) => l.trim().startsWith('{')).pop());
    return parsed?.token || null;
  } catch {
    return null;
  }
}

function login() {
  say('opening Cloudflare in your browser: allow wrangler to edit DNS and create API tokens');
  let result = wrangler(['login', '--scopes', ...USUAL_SCOPES, ...EXTRA_SCOPES], { stdio: 'inherit' });
  if (result.status !== 0) result = wrangler(['login', '--scopes', ...CORE_SCOPES, ...EXTRA_SCOPES], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('wrangler login did not finish');
}

async function api(token, method, pathname, body) {
  const response = await fetch(`${API}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.success === false) {
    const why = data?.errors?.map((e) => `${e.code}: ${e.message}`).join('; ') || `status ${response.status}`;
    const error = new Error(`${method} ${pathname}: ${why}`);
    error.status = response.status;
    throw error;
  }
  return data?.result;
}

async function choose(question, options) {
  if (options.length === 1) return options[0];
  if (!process.stdin.isTTY) throw new Error(`${question} (several: ${options.join(', ')}); pass it on the command line`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    options.forEach((o, i) => console.log(`  ${i + 1}. ${o}`));
    const answer = await rl.question(`${question} [1-${options.length}]: `);
    const pick = options[Number(answer) - 1];
    if (!pick) throw new Error('no choice made');
    return pick;
  } finally {
    rl.close();
  }
}

/** The account's FreeRTC Workers: scripts whose workers.dev /health answers as a relay. */
async function findWorkers(token, account, subdomain, wanted) {
  const scripts = (await api(token, 'GET', `/accounts/${account}/workers/scripts`)) || [];
  const names = scripts.map((s) => s.id).filter((n) => !wanted || n === wanted);
  const found = [];
  await Promise.all(names.map(async (name) => {
    const url = `https://${name}.${subdomain}.workers.dev`;
    try {
      const health = await (await fetch(`${url}/health`, { signal: AbortSignal.timeout(8000) })).json();
      if (health?.relay_url && health?.node_id) found.push({ name, url });
    } catch { /* not a relay, or not on workers.dev */ }
  }));
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const dataDir = path.resolve(process.env.FREERTC_DATA_DIR || path.join(process.cwd(), '.freertc-relay'));
  const identity = await relayIdentity(dataDir);
  say(`this relay: ${identity.nodeId.slice(0, 16)}… (data in ${dataDir})`);

  let token = oauthToken();
  if (!token) { login(); token = oauthToken(); }
  if (!token) throw new Error('no Cloudflare login (wrangler auth token gave nothing)');

  // Account, Worker, domain.
  const accounts = (await api(token, 'GET', '/accounts')) || [];
  const accountName = await choose('Which Cloudflare account?', accounts.map((a) => `${a.name} (${a.id})`));
  const account = accountName.match(/\(([0-9a-f]+)\)$/)[1];
  const { subdomain } = await api(token, 'GET', `/accounts/${account}/workers/subdomain`);
  const workers = await findWorkers(token, account, subdomain, args.worker);
  if (!workers.length) throw new Error(args.worker ? `no FreeRTC Worker named ${args.worker} answers on workers.dev` : 'no FreeRTC Worker in this account answers on workers.dev; deploy one first (the Deploy button or npx freertc deploy)');
  const workerLabel = await choose('Which FreeRTC Worker?', workers.map((w) => w.name));
  const worker = workers.find((w) => w.name === workerLabel);
  const zones = (await api(token, 'GET', `/zones?per_page=50&account.id=${account}${args.domain ? `&name=${encodeURIComponent(args.domain)}` : ''}`)) || [];
  if (!zones.length) throw new Error(args.domain ? `${args.domain} is not a domain on this Cloudflare account` : 'this Cloudflare account has no domains');
  const domain = await choose('Which domain do relay names go on?', zones.map((z) => z.name));
  const zone = zones.find((z) => z.name === domain);
  say(`Worker ${worker.url}, domain ${domain}`);

  // The Worker's DNS token, the first time (or for a new domain).
  const settings = await api(token, 'GET', `/accounts/${account}/workers/scripts/${worker.name}/settings`);
  const secrets = new Set(((await api(token, 'GET', `/accounts/${account}/workers/scripts/${worker.name}/secrets`)) || []).map((s) => s.name));
  const nameFile = path.join(dataDir, 'names.json');
  const previous = existsSync(nameFile) ? JSON.parse(readFileSync(nameFile, 'utf8')) : null;
  const sameDomain = previous?.domain === domain && previous?.worker === worker.url;
  if (!secrets.has('NAMES_DNS_TOKEN') || !sameDomain) {
    let created;
    try {
      created = await createDnsToken(token, account, zone, worker.name);
    } catch (error) {
      if (error.status !== 403 && error.status !== 401) throw error;
      login();
      token = oauthToken();
      created = await createDnsToken(token, account, zone, worker.name);
    }
    for (const [name, text] of [['NAMES_DNS_TOKEN', created], ['NAMES_ZONE_ID', zone.id], ['NAMES_DOMAIN', domain]]) {
      await api(token, 'PUT', `/accounts/${account}/workers/scripts/${worker.name}/secrets`, { name, text, type: 'secret_text' });
    }
    say(`stored a DNS token for ${domain} in ${worker.name} (it can edit DNS on ${domain} only)`);
  } else say(`${worker.name} already has a DNS token for ${domain}`);

  // Register this relay in the Worker's database.
  const d1 = (settings?.bindings || []).find((b) => b.type === 'd1' && b.name === 'DB');
  if (!d1?.id && !d1?.database_id) throw new Error(`${worker.name} has no DB database binding`);
  const databaseId = d1.id || d1.database_id;
  await api(token, 'POST', `/accounts/${account}/d1/database/${databaseId}/query`, {
    sql: `CREATE TABLE IF NOT EXISTS ${OWNERS_TABLE} (node_id TEXT PRIMARY KEY, added_at_ms INTEGER NOT NULL)`,
  });
  await api(token, 'POST', `/accounts/${account}/d1/database/${databaseId}/query`, {
    sql: `INSERT OR IGNORE INTO ${OWNERS_TABLE} (node_id, added_at_ms) VALUES (?, ?)`,
    params: [identity.nodeId, Date.now()],
  });

  const name = relayHostname(identity.nodeId, domain);
  writeFileSync(nameFile, JSON.stringify({ worker: worker.url, domain, name }, null, 2) + '\n');
  say(`registered. This relay will be ${name}`);
  say('restart the relay (npm run dev): it claims the name, gets its Let\'s Encrypt certificate, and serves');
  say(`  wss://${name}:8443/ws`);
}

async function createDnsToken(token, account, zone, workerName) {
  let group = DNS_WRITE_GROUP;
  try {
    const groups = (await api(token, 'GET', `/accounts/${account}/tokens/permission_groups`)) || [];
    group = groups.find((g) => g.name === 'DNS Write')?.id || group;
  } catch { /* use the known id */ }
  const created = await api(token, 'POST', `/accounts/${account}/tokens`, {
    name: `freertc names ${zone.name} (${workerName})`,
    policies: [{ effect: 'allow', permission_groups: [{ id: group }], resources: { [`com.cloudflare.api.account.zone.${zone.id}`]: '*' } }],
  });
  if (!created?.value) throw new Error('Cloudflare made the token but did not return it');
  return created.value;
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (import.meta.url === entry) {
  main().catch((error) => {
    console.error(`[freertc name] ${error?.message || error}`);
    process.exitCode = 1;
  });
}
