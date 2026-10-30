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
import { DIRECTORY_PATH } from './directory.js';

const REPUBLISH_MS = 30 * 60_000;

export async function startDirectRelay({
  identity,
  dataDir,
  port = 9443,
  directoryUrl,
  publicIp = null,          // set when this machine has a public address and no router to ask
  tunnelUrl = () => null,   // this relay's tunnel URL, when it has one
  name = null,
  acceptSocket,
  fetchImpl = globalThis.fetch,
  log = () => {},
}) {
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
  let stopped = false;
  const endpoint = directoryUrl ? new URL(DIRECTORY_PATH, directoryUrl).toString() : null;

  async function publish() {
    if (stopped || !externalIp || !endpoint) return;
    const record = await createSignedDirectoryRecord(identity, {
      direct: directRelayUrl({ host: externalIp, port: externalPort, fingerprint: cert.fingerprint }),
      tunnel: tunnelUrl() || null,
      name,
    });
    try {
      const response = await fetchImpl(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record) });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.ok) {
        const why = body?.error || `status ${response.status}`;
        log(`directory: not listed (${why}${body?.seen ? `; it sees ${body.seen}, the router says ${externalIp}` : ''})`);
        if (body?.seen && body.seen !== externalIp) externalIp = null; // a second NAT: stop trying
        return;
      }
      if (body.published) log(`directory: listed as ${record.direct}`);
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
          await fetchImpl(endpoint, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(withdrawal), signal: AbortSignal.timeout(3_000) });
        } catch {}
      }
      await mapping?.close().catch(() => {});
      listener.close();
    },
  };
}
