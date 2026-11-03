#!/usr/bin/env node
// npx freertc name [--domain example.com] [--worker <script name>]
//
// Gives the local relay on this machine a name and a certificate on your own
// domain, kept by your own FreeRTC Worker (src/direct/names.js,
// src/node/relay-name.js). Run it once on each machine that runs a relay:
//
//   1. Log in to Cloudflare with wrangler (a browser window, if not already).
//   2. Find your FreeRTC Worker (by its /health) and the domain (a zone in
//      your account).
//   3. The first time for a domain: the Worker needs an API token that can
//      only edit DNS on that domain. Wrangler's login cannot make tokens, so
//      this opens Cloudflare's token page already filled in (DNS edit, that
//      domain only): click Create Token, then Copy, and press Enter here (it is read from
//      the clipboard, never shown or pasted in the terminal), once. It is
//      checked, stored in the Worker (NAMES_DNS_TOKEN, NAMES_ZONE_ID,
//      NAMES_DOMAIN) and never written on this machine.
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
import { resolveProjectRoot } from './project-bootstrap.mjs';

const API = 'https://api.cloudflare.com/client/v4';

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

/** `wrangler auth token` (reading the login's token) needs a recent wrangler: npx fetches it once. */
const LOGIN_WRANGLER = 'wrangler@4.156.0';

function wrangler(args, options = {}) {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  return spawnSync(npx, ['--yes', LOGIN_WRANGLER, ...args], { cwd: ROOT, encoding: 'utf8', env: process.env, shell: process.platform === 'win32', ...options });
}

/** The login's token, from `wrangler auth token --json` (printed over several lines). */
export function tokenFromOutput(stdout) {
  const text = String(stdout || '');
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (typeof parsed?.token === 'string' && parsed.token) return parsed.token;
    } catch { /* not JSON */ }
  }
  return null;
}

function oauthToken() {
  const json = wrangler(['auth', 'token', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const token = tokenFromOutput(json.stdout);
  if (token) return token;
  // Without --json it prints just the token, on its own line.
  const plain = wrangler(['auth', 'token'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const line = String(plain.stdout || '').trim().split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
  return /^[A-Za-z0-9._-]{20,}$/.test(line) ? line : null;
}

function login() {
  say('logging in to Cloudflare (a browser window)');
  const result = wrangler(['login'], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('wrangler login did not finish');
}

function openInBrowser(url) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawnSync(opener, args, { stdio: 'ignore' });
}

/** Does this look like a Cloudflare API token (and nothing else)? */
export function looksLikeToken(text) {
  return /^[A-Za-z0-9_-]{30,200}$/.test(String(text || '').trim());
}

const CLIPBOARD_READERS = {
  darwin: [['pbpaste', []]],
  win32: [['powershell', ['-NoProfile', '-Command', 'Get-Clipboard']]],
  linux: [['wl-paste', ['-n']], ['xclip', ['-selection', 'clipboard', '-o']], ['xsel', ['-b', '-o']]],
};
const CLIPBOARD_CLEARERS = {
  darwin: [['pbcopy', []]],
  win32: [['powershell', ['-NoProfile', '-Command', 'Set-Clipboard -Value $null']]],
  linux: [['wl-copy', ['--clear']], ['xclip', ['-selection', 'clipboard', '-i']], ['xsel', ['-b', '-c']]],
};

/** The clipboard's text, read here (nothing is pasted into the terminal), or null without a way to read it. */
function readClipboard() {
  for (const [command, args] of CLIPBOARD_READERS[process.platform] || []) {
    const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (result.status === 0) return String(result.stdout || '').trim();
  }
  return null;
}

/** Empty the clipboard, so the token does not stay there. */
function clearClipboard() {
  for (const [command, args] of CLIPBOARD_CLEARERS[process.platform] || []) {
    if (spawnSync(command, args, { input: '', stdio: ['pipe', 'ignore', 'ignore'] }).status === 0) return true;
  }
  return false;
}

/**
 * Read keys with nothing echoed: until Enter, returning what was typed (with
 * any bracketed-paste markers removed). Ctrl-C quits.
 */
function readKeysSilently(prompt) {
  if (!process.stdin.isTTY) throw new Error('needs a terminal');
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    let typed = '';
    const done = (value) => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      resolve(value);
    };
    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      if (text.includes('\u0003')) { process.stdout.write('\n'); process.exit(130); }
      typed += text;
      const enter = typed.search(/[\r\n]/);
      if (enter >= 0) done(typed.slice(0, enter).replace(/\x1b\[20[01]~/g, '').trim());
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

/**
 * Get the token without it ever showing on screen: copied in the browser, read
 * here from the clipboard when Enter is pressed (no paste into the terminal,
 * so no terminal shows it or warns about a paste), then the clipboard is
 * emptied. Without a clipboard tool, it is typed or pasted with nothing echoed.
 */
async function tokenFromOwner() {
  if (readClipboard() !== null) {
    await readKeysSilently('[freertc name] click Copy next to the new token in the browser, then press Enter here (do not paste it): ');
    const text = readClipboard();
    if (!looksLikeToken(text)) return null;
    say(clearClipboard() ? 'read the token from the clipboard and emptied the clipboard' : 'read the token from the clipboard (empty the clipboard yourself)');
    return text.trim();
  }
  const typed = await readKeysSilently('[freertc name] paste the token here (nothing is shown): ');
  return looksLikeToken(typed) ? typed : null;
}

/** Cloudflare's token page, filled in: DNS edit on this one zone. */
export function tokenTemplateUrl(account, zone) {
  const keys = encodeURIComponent(JSON.stringify([{ key: 'dns', type: 'edit' }]));
  return `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${keys}&accountId=${account}&zoneId=${zone.id}&name=${encodeURIComponent(`freertc names ${zone.name}`)}`;
}

/** Get the DNS token from the owner, once, and check it can edit this zone's DNS. */
async function dnsTokenFromOwner(account, zone) {
  const url = tokenTemplateUrl(account, zone);
  say(`the Worker needs a token that can edit DNS on ${zone.name} only. Opening Cloudflare's token page, filled in:`);
  console.log(`  ${url}`);
  say('check that it says Zone / DNS / Edit and Include / Specific zone / ' + zone.name + ', then click Continue to summary and Create Token');
  openInBrowser(url);
  for (let tries = 0; tries < 3; tries++) {
    const pasted = await tokenFromOwner();
    if (!pasted) { say('that is not a Cloudflare token (nothing was shown or kept); copy the token itself and try again'); continue; }
    try {
      await api(pasted, 'GET', `/zones/${zone.id}/dns_records?per_page=1`);
      return pasted;
    } catch (error) {
      say(`that token cannot read ${zone.name}'s DNS (${error.message}); try again`);
    }
  }
  throw new Error('no working token');
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
  // Does the Worker already name relays on this domain (set up from this or another machine)?
  const naming = await fetch(new URL('/api/v1/name', worker.url)).then((r) => r.json()).catch(() => null);
  // Workers with names answer here: with `names` (now), or (the first version) 404 'gives no names' / 405 to a GET.
  const hasNames = naming && ('names' in naming || /gives no names|method not allowed/.test(String(naming.error || '')));
  if (!hasNames) {
    throw new Error(`${worker.name} runs an older FreeRTC without relay names; redeploy it first (the Deploy button, or npx freertc deploy), then run this again`);
  }
  const nameFile = path.join(dataDir, 'names.json');
  const sameDomain = naming?.ok === true && naming.domain === domain;
  // (The first version cannot say its domain: then the token is asked for again, which replaces it; harmless.)
  if (!sameDomain) {
    const created = await dnsTokenFromOwner(account, zone);
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

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (import.meta.url === entry) {
  main().catch((error) => {
    console.error(`[freertc name] ${error?.message || error}`);
    process.exitCode = 1;
  });
}
