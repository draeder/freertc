// A local relay's own DNS name and TLS certificate, so browsers anywhere can
// reach it as wss://<name>:<port>/ws.
//
//   1. It asks its owner's Worker (POST /api/v1/name, src/direct/names.js) to
//      point <label>.<owner's domain> at the address its request comes from,
//      and asks again every CLAIM_EVERY_MS (the home address can change).
//   2. It gets a Let's Encrypt certificate for that name by DNS-01: the
//      Worker writes the challenge TXT record (it holds the DNS token; this
//      relay never does), the relay waits until public DNS shows it, then
//      Let's Encrypt checks it. No inbound port is needed for this, and the
//      private key never leaves this machine. It renews when RENEW_DAYS are
//      left.
//   3. It asks the router to forward its TLS port (UPnP or NAT-PMP), so the
//      name works from outside the home network.
//
// The relay must be registered with the Worker first (`npx freertc name` on
// this machine, with the owner's Cloudflare login).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import path from 'node:path';
import { createNameRequest, NAMES_PATH } from '../direct/names.js';

const CLAIM_EVERY_MS = 10 * 60_000;
const CHECK_CERT_EVERY_MS = 12 * 60 * 60_000;
const RENEW_DAYS = 30;
const RETRY_MS = 5 * 60_000;
const TXT_WAIT_MS = 3 * 60_000;
const DOH_URLS = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'];
const LETS_ENCRYPT = 'https://acme-v02.api.letsencrypt.org/directory';
const LETS_ENCRYPT_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';
/** Directory records hold names of at most this many characters (src/direct/record.js). */
const MAX_DIRECTORY_NAME = 64;

/** The naming settings `freertc name` leaves in the data directory, or null. */
export function loadNameSettings(dataDir, env = process.env) {
  if (env.FREERTC_NAMES_URL) return { worker: env.FREERTC_NAMES_URL };
  const file = path.join(dataDir, 'names.json');
  if (!existsSync(file)) return null;
  try {
    const settings = JSON.parse(readFileSync(file, 'utf8'));
    return settings?.worker ? settings : null;
  } catch {
    return null;
  }
}

/** Days until a PEM certificate expires (negative: expired), and whether it is for `name`. */
export function certificateState(pem, name) {
  try {
    const cert = new X509Certificate(pem);
    const days = (Date.parse(cert.validTo) - Date.now()) / 86_400_000;
    return { days, forName: cert.checkHost(name) === name };
  } catch {
    return { days: -1, forName: false };
  }
}

/** Wait until public DNS shows TXT `value` at `name` (Let's Encrypt asks public DNS too). */
export async function waitForTxt(name, value, { fetchImpl = globalThis.fetch, timeoutMs = TXT_WAIT_MS, everyMs = 5_000 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    for (const doh of DOH_URLS) {
      try {
        const response = await fetchImpl(`${doh}?name=${encodeURIComponent(name)}&type=TXT`, { headers: { accept: 'application/dns-json' } });
        const answer = await response.json();
        if ((answer?.Answer || []).some((a) => String(a.data).replace(/"/g, '') === value)) return true;
      } catch { /* try the next */ }
    }
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  return false;
}

export async function startRelayName({
  identity,
  dataDir,
  worker,
  tlsPort,
  /** async (port) => { externalIp, externalPort, close } | null: the router's forward for the TLS port. */
  mapPort = async () => null,
  /** Called with { name, key, cert } when a certificate is ready (first time and on renewal). */
  onCertificate,
  /** Called when the wss address (for the directory) changes: wss://<name>:<port>/ws, or null. */
  onAddress = () => {},
  log = () => {},
  fetchImpl = globalThis.fetch,
  staging = false,
}) {
  const dir = path.join(dataDir, 'tls');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const endpoint = new URL(NAMES_PATH, worker).toString();
  let name = null, ip = null, mapping = null, wssUrl = null, stopped = false;
  const timers = [];

  async function ask(action, value = null) {
    const body = await createNameRequest(identity, { action, value });
    const response = await fetchImpl(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.ok) throw new Error(result?.error || `status ${response.status}`);
    return result;
  }

  async function claim() {
    const result = await ask('claim');
    if (result.name !== name || result.ip !== ip) log(`name: ${result.name} -> ${result.ip}`);
    name = result.name;
    ip = result.ip;
  }

  async function obtain() {
    const acme = (await import('acme-client')).default;
    const accountFile = path.join(dir, 'acme-account.key');
    const accountKey = existsSync(accountFile) ? readFileSync(accountFile) : await acme.crypto.createPrivateEcdsaKey();
    if (!existsSync(accountFile)) writeFileSync(accountFile, accountKey, { mode: 0o600 });
    const client = new acme.Client({ directoryUrl: staging ? LETS_ENCRYPT_STAGING : LETS_ENCRYPT, accountKey });
    const [key, csr] = await acme.crypto.createCsr({ commonName: name, altNames: [name] }, await acme.crypto.createPrivateEcdsaKey());
    log(`certificate: asking Let's Encrypt for ${name}${staging ? ' (staging)' : ''}`);
    const cert = await client.auto({
      csr,
      termsOfServiceAgreed: true,
      challengePriority: ['dns-01'],
      // Checked here against public DNS instead (the local resolver may cache).
      skipChallengeVerification: true,
      challengeCreateFn: async (_authz, _challenge, keyAuthorization) => {
        await ask('acme-set', keyAuthorization);
        if (!await waitForTxt(`_acme-challenge.${name}`, keyAuthorization, { fetchImpl })) throw new Error('the challenge record did not show up in public DNS');
      },
      challengeRemoveFn: async () => { await ask('acme-clear').catch(() => {}); },
    });
    writeFileSync(path.join(dir, `${name}.key`), key, { mode: 0o600 });
    writeFileSync(path.join(dir, `${name}.crt`), cert);
    log(`certificate: issued for ${name}, valid ${Math.round(certificateState(cert, name).days)} days`);
    return { key: key.toString(), cert: cert.toString() };
  }

  /** The certificate on disk if it is good for a while yet, else a new one. */
  async function certificate(force = false) {
    const keyFile = path.join(dir, `${name}.key`), certFile = path.join(dir, `${name}.crt`);
    if (!force && existsSync(keyFile) && existsSync(certFile)) {
      const cert = readFileSync(certFile, 'utf8');
      const state = certificateState(cert, name);
      if (state.forName && state.days > RENEW_DAYS) return { key: readFileSync(keyFile, 'utf8'), cert, fresh: false };
    }
    return { ...(await obtain()), fresh: true };
  }

  function setAddress() {
    const port = mapping?.externalPort ?? null;
    const next = name && port ? `wss://${name}:${port}/ws` : null;
    const fits = next && next.length <= MAX_DIRECTORY_NAME ? next : null;
    if (next && !fits) log(`directory: ${next} is longer than ${MAX_DIRECTORY_NAME} characters; listed without it`);
    if (fits !== wssUrl) { wssUrl = fits; onAddress(wssUrl); }
  }

  async function run() {
    try {
      await claim();
      const { key, cert } = await certificate();
      onCertificate({ name, key, cert });
      if (!mapping) {
        mapping = await mapPort(tlsPort).catch(() => null);
        if (mapping) log(`router forwards tcp ${mapping.externalIp}:${mapping.externalPort} to ${tlsPort}`);
        else log(`no router forward for tcp ${tlsPort}: wss://${name}:${tlsPort}/ws works on this network only`);
      }
      setAddress();
    } catch (error) {
      log(`name: ${error?.message || error}; trying again in ${RETRY_MS / 60_000} min`);
      if (!stopped) timers.push(setTimeout(() => run().catch(() => {}), RETRY_MS));
      return;
    }
    timers.push(setInterval(() => claim().catch((error) => log(`name: ${error?.message || error}`)), CLAIM_EVERY_MS));
    timers.push(setInterval(async () => {
      try {
        const { key, cert, fresh } = await certificate();
        if (fresh) onCertificate({ name, key, cert });
      } catch (error) {
        log(`certificate: renewal failed (${error?.message || error}); trying again later`);
      }
    }, CHECK_CERT_EVERY_MS));
  }

  await run();
  return {
    get name() { return name; },
    get wssUrl() { return wssUrl; },
    stop() {
      stopped = true;
      for (const t of timers) { clearTimeout(t); clearInterval(t); }
      mapping?.close?.().catch?.(() => {});
    },
  };
}
