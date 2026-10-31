// Ask the home router to forward a port to this machine: UDP for browsers'
// direct connections, TCP for other relays' calls. No configuration: UPnP
// IGD first (most home routers), then NAT-PMP (Apple and some others). No
// dependencies.
//
// Returns { externalIp, externalPort, protocol, method, close() } or null when
// no router answers or it refuses. The mapping is renewed while it is held and
// removed by close().

import { createSocket } from 'node:dgram';
import { execFile } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { readFile } from 'node:fs/promises';

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const SEARCH_MS = 3_000;
const LEASE_SECONDS = 3_600;
const RENEW_MS = 45 * 60_000;
const WAN_SERVICES = [
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];

function lanAddressFor(gatewayHost) {
  const prefix = String(gatewayHost).split('.').slice(0, 3).join('.');
  let fallback = null;
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      if (address.address.startsWith(`${prefix}.`)) return address.address;
      fallback ??= address.address;
    }
  }
  return fallback;
}

/** SSDP search: the LOCATION URLs of internet gateway devices on this network. */
function ssdpSearch(timeoutMs = SEARCH_MS) {
  return new Promise((resolve) => {
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Set();
    const done = () => { try { socket.close(); } catch {} resolve([...found]); };
    socket.on('message', (message) => {
      const location = /^location:\s*(\S+)/im.exec(message.toString())?.[1];
      if (location) found.add(location);
    });
    socket.on('error', done);
    socket.bind(0, () => {
      for (const target of ['urn:schemas-upnp-org:device:InternetGatewayDevice:1', 'urn:schemas-upnp-org:device:InternetGatewayDevice:2', ...WAN_SERVICES]) {
        const search = Buffer.from([
          'M-SEARCH * HTTP/1.1', `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`, 'MAN: "ssdp:discover"', 'MX: 2', `ST: ${target}`, '', '',
        ].join('\r\n'));
        socket.send(search, SSDP_PORT, SSDP_ADDRESS);
      }
      setTimeout(done, timeoutMs).unref?.();
    });
  });
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(5_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${(/<errorDescription>([^<]*)/.exec(text) || [])[1] || text.slice(0, 120)}`);
  return text;
}

/** The WAN connection service of the gateway described at `location`: { controlUrl, serviceType }. */
async function wanService(location) {
  const xml = await fetchText(location);
  for (const block of xml.split(/<service>/i).slice(1)) {
    const serviceType = /<serviceType>\s*([^<\s]+)\s*<\/serviceType>/i.exec(block)?.[1];
    const control = /<controlURL>\s*([^<\s]+)\s*<\/controlURL>/i.exec(block)?.[1];
    if (serviceType && control && WAN_SERVICES.includes(serviceType)) {
      return { controlUrl: new URL(control, location).toString(), serviceType };
    }
  }
  return null;
}

function soapCall({ controlUrl, serviceType }, action, args = {}) {
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${serviceType}">${
    Object.entries(args).map(([key, value]) => `<${key}>${String(value).replace(/[<&>]/g, '')}</${key}>`).join('')
  }</u:${action}></s:Body></s:Envelope>`;
  return fetchText(controlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${serviceType}#${action}"` },
    body,
  });
}

async function mapWithUpnp({ internalPort, externalPort, description, protocol, log }) {
  for (const location of await ssdpSearch()) {
    let service;
    try { service = await wanService(location); } catch { continue; }
    if (!service) continue;
    const gatewayHost = new URL(location).hostname;
    const internalClient = lanAddressFor(gatewayHost);
    if (!internalClient) continue;
    try {
      const ipXml = await soapCall(service, 'GetExternalIPAddress');
      const externalIp = /<NewExternalIPAddress>\s*([^<\s]*)\s*</i.exec(ipXml)?.[1];
      const add = () => soapCall(service, 'AddPortMapping', {
        NewRemoteHost: '',
        NewExternalPort: externalPort,
        NewProtocol: protocol,
        NewInternalPort: internalPort,
        NewInternalClient: internalClient,
        NewEnabled: 1,
        NewPortMappingDescription: description,
        NewLeaseDuration: LEASE_SECONDS,
      });
      await add();
      const renew = setInterval(() => add().catch((error) => log(`UPnP renewal failed: ${error.message}`)), RENEW_MS);
      renew.unref?.();
      return {
        method: 'upnp',
        externalIp,
        externalPort,
        internalClient,
        protocol,
        async close() {
          clearInterval(renew);
          await soapCall(service, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: externalPort, NewProtocol: protocol }).catch(() => {});
        },
      };
    } catch (error) {
      log(`UPnP gateway ${gatewayHost} refused the mapping: ${error.message}`);
    }
  }
  return null;
}

async function defaultGateway() {
  if (process.platform === 'linux') {
    try {
      for (const line of (await readFile('/proc/net/route', 'utf8')).split('\n').slice(1)) {
        const [, destination, gateway] = line.trim().split(/\s+/);
        if (destination === '00000000' && gateway && gateway !== '00000000') {
          return gateway.match(/../g).reverse().map((h) => parseInt(h, 16)).join('.');
        }
      }
    } catch {}
    return null;
  }
  if (process.platform === 'darwin' || process.platform.endsWith('bsd')) {
    return new Promise((resolve) => execFile('route', ['-n', 'get', 'default'], { timeout: 3_000 }, (error, stdout) => {
      resolve(error ? null : (/gateway:\s*(\d+\.\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? null));
    }));
  }
  return null;
}

function pmpRequest(gateway, request, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    const timer = setTimeout(() => { try { socket.close(); } catch {} reject(new Error('NAT-PMP: no answer')); }, timeoutMs);
    socket.on('message', (message) => { clearTimeout(timer); try { socket.close(); } catch {} resolve(message); });
    socket.on('error', (error) => { clearTimeout(timer); try { socket.close(); } catch {} reject(error); });
    socket.send(request, 5351, gateway);
  });
}

async function mapWithPmp({ internalPort, externalPort, protocol, log }) {
  const gateway = await defaultGateway();
  if (!gateway) return null;
  try {
    const ipAnswer = await pmpRequest(gateway, Buffer.from([0, 0]));
    if (ipAnswer.length < 12 || ipAnswer.readUInt16BE(2) !== 0) return null;
    const externalIp = [...ipAnswer.subarray(8, 12)].join('.');
    const map = async (lifetime) => {
      const request = Buffer.alloc(12);
      request[0] = 0; request[1] = protocol === 'TCP' ? 2 : 1; // version 0, map UDP (1) or TCP (2)
      request.writeUInt16BE(internalPort, 4);
      request.writeUInt16BE(externalPort, 6);
      request.writeUInt32BE(lifetime, 8);
      const answer = await pmpRequest(gateway, request);
      if (answer.length < 16 || answer.readUInt16BE(2) !== 0) throw new Error(`NAT-PMP refused (result ${answer.readUInt16BE(2)})`);
      return answer.readUInt16BE(10);
    };
    const mappedPort = await map(LEASE_SECONDS);
    const renew = setInterval(() => map(LEASE_SECONDS).catch((error) => log(`NAT-PMP renewal failed: ${error.message}`)), RENEW_MS);
    renew.unref?.();
    return {
      method: 'nat-pmp',
      externalIp,
      externalPort: mappedPort,
      protocol,
      async close() { clearInterval(renew); await map(0).catch(() => {}); },
    };
  } catch (error) {
    log(`NAT-PMP gateway ${gateway}: ${error.message}`);
    return null;
  }
}

/** Forward externalPort (protocol 'UDP' or 'TCP') on the router to internalPort here. */
export async function mapPort({ internalPort, externalPort = internalPort, protocol = 'UDP', description = 'freertc relay', log = () => {} }) {
  return (await mapWithUpnp({ internalPort, externalPort, description, protocol, log }))
    ?? (await mapWithPmp({ internalPort, externalPort, protocol, log }));
}

export const mapUdpPort = (options) => mapPort({ ...options, protocol: 'UDP' });
export const mapTcpPort = (options) => mapPort({ ...options, protocol: 'TCP' });

/** True for an address that is not reachable from the internet (private, CGNAT, loopback, link-local). */
export function isNonPublicIPv4(ip) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(String(ip));
  if (!m) return true;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
