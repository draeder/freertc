// node-relay's direct mode: accept direct browser connections on a UDP port,
// ask the router to forward that port, and list this relay in the DNS relay
// directory (a cloud relay writes it; see directory.js), so browsers find it
// with one DNS-over-HTTPS lookup and connect without any cloud relay.
//
// Nothing is published unless the router gives a public address that is also
// the address the directory sees this relay's requests come from (behind
// carrier-grade NAT or a second router they differ, and browsers could not
// reach the port). In that case the relay keeps using its tunnel as before.

import { loadOrCreateDirectCertificate } from './cert.js';
import { startDirectListener, directListenerAvailable } from './listener.js';
import { mapUdpPort, isNonPublicIPv4 } from './portmap.js';
import { directRelayUrl } from './common.js';
import { createSignedDirectoryRecord, createSignedWithdrawal } from './record.js';
import { DIRECTORY_PATH, PQ_KEY_HEADER, PQ_SIGNATURE_HEADER } from './directory.js';
import { signDirectoryPq } from '../relay-identity.js';
import { networkInterfaces } from 'node:os';
import { isLanEndpoint } from './record.js';

/** This machine's private IPv4 addresses with the relay's own UDP port, "ip:port". */
function lanEndpoints(port) {
  const out = [];
  for (const entry of Object.values(networkInterfaces()).flat()) {
    if (!entry || entry.internal || entry.family !== 'IPv4') continue;
    const endpoint = `${entry.address}:${port}`;
    if (isLanEndpoint(endpoint) && !out.includes(endpoint)) out.push(endpoint);
  }
  return out.slice(0, 4);
}

const REPUBLISH_MS = 20 * 60_000;

export async function startDirectRelay({
  identity,
  dataDir,
  port = 9443,
  directoryUrl,
  publicIp = null,          // set when this machine has a public address and no router to ask
  tunnelUrl = () => null,   // this relay's tunnel URL, when it has one
  wsUrl = () => null,       // ws://<public ip>:<port>/ws when the router forwards its TCP port
  name = null,              // a label, or a function giving it (a wss:// name once the relay has one)
  acceptSocket,
  fetchImpl = globalThis.fetch,
  log = () => {},
  pqIdentity = null,        // { pub, priv, qpub, qpriv }: prove the relay's post-quantum key too
}) {
  // JSON headers, and the post-quantum proof when this relay has a key.
  const headersFor = async (signed) => ({
    'Content-Type': 'application/json',
    ...(pqIdentity ? { [PQ_KEY_HEADER]: pqIdentity.qpub, [PQ_SIGNATURE_HEADER]: await signDirectoryPq(pqIdentity, signed) } : {}),
  });
  if (!await directListenerAvailable()) {
    log('direct connections: off (needs node-datachannel 0.33 or later: npm install node-datachannel)');
    return null;
  }
  const cert = loadOrCreateDirectCertificate(dataDir);
  const listener = await startDirectListener({
    port,
    certFile: cert.certFile,
    keyFile: cert.keyFile,
    onSocket: (socket) => acceptSocket(socket),
    log,
  });
  if (!listener) return null;

  let mapping = null;
  let externalIp = publicIp;
  let externalPort = port;
  if (!publicIp) {
    mapping = await mapUdpPort({ internalPort: port, externalPort: port, description: `freertc relay ${identity.nodeId.slice(0, 8)}`, log });
    if (!mapping) {
      log('direct connections: no router answered UPnP or NAT-PMP; browsers reach this relay through its tunnel');
    } else if (isNonPublicIPv4(mapping.externalIp)) {
      log(`direct connections: the router's own address ${mapping.externalIp} is not public (carrier-grade NAT or a second router); using the tunnel`);
      await mapping.close();
      mapping = null;
    } else {
      externalIp = mapping.externalIp;
      externalPort = mapping.externalPort;
      log(`direct connections: router forwards udp ${externalIp}:${externalPort} here (${mapping.method})`);
    }
  }

  let published = null;
  let retryTimer = null;
  let stopped = false;
  const endpoint = directoryUrl ? new URL(DIRECTORY_PATH, directoryUrl).toString() : null;

  // A relay that cannot be listed here (no public address on this network,
  // or the directory sees a different one) takes down the entry it may have
  // left from its last network: otherwise browsers keep dialing an address
  // where nothing answers until that entry expires.
  let withdrawnStale = false;
  async function withdrawStale(why) {
    if (withdrawnStale || !endpoint) return;
    withdrawnStale = true;
    try {
      const withdrawal = await createSignedWithdrawal(identity);
      const response = await fetchImpl(endpoint, { method: 'DELETE', headers: await headersFor(withdrawal), body: JSON.stringify(withdrawal), signal: AbortSignal.timeout(5_000) });
      const body = await response.json().catch(() => null);
      if (body?.removed) log(`directory: removed this relay's old entry (${why})`);
    } catch (error) {
      withdrawnStale = false;
      log(`directory: could not remove this relay's old entry: ${error?.message || error}`);
    }
  }

  async function publish() {
    if (stopped || !endpoint) return;
    if (!externalIp) {
      await withdrawStale('not reachable directly on this network');
      return;
    }
    const record = await createSignedDirectoryRecord(identity, {
      direct: directRelayUrl({ host: externalIp, port: externalPort, fingerprint: cert.fingerprint }),
      tunnel: tunnelUrl() || null,
      name: typeof name === 'function' ? name() : name,
      // The port the relay listens on (the router may forward a different
      // public one): machines on this network use these, not the public address.
      lan: lanEndpoints(port),
      ws: wsUrl() || null,
    });
    try {
      const response = await fetchImpl(endpoint, { method: 'POST', headers: await headersFor(record), body: JSON.stringify(record) });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.ok) {
        const why = body?.error || `status ${response.status}`;
        log(`directory: not listed (${why}${body?.seen ? `; it sees ${body.seen}, the router says ${externalIp}` : ''})`);
        if (body?.seen && body.seen !== externalIp) {
          externalIp = null; // a second NAT: stop trying
          await withdrawStale('behind a second NAT');
        }
        // Changed too soon after the last write: try again once that has passed.
        if (response.status === 429 && !retryTimer) {
          retryTimer = setTimeout(() => { retryTimer = null; publish().catch(() => {}); }, 75_000);
          retryTimer.unref?.();
        }
        return;
      }
      if (body.published) log(`directory: listed as ${record.direct}${record.lan ? ` (on this network: ${record.lan.join(', ')})` : ''}`);
      published = record;
    } catch (error) {
      log(`directory: ${error?.message || error}`);
    }
  }

  await publish();
  const timer = setInterval(() => publish().catch(() => {}), REPUBLISH_MS);
  timer.unref?.();

  return {
    fingerprint: cert.fingerprint,
    url: () => (externalIp ? directRelayUrl({ host: externalIp, port: externalPort, fingerprint: cert.fingerprint }) : null),
    stats: () => listener.stats(),
    republish: publish,
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (published && endpoint) {
        try {
          const withdrawal = await createSignedWithdrawal(identity);
          await fetchImpl(endpoint, { method: 'DELETE', headers: await headersFor(withdrawal), body: JSON.stringify(withdrawal), signal: AbortSignal.timeout(3_000) });
        } catch {}
      }
      await mapping?.close().catch(() => {});
      listener.close();
    },
  };
}
