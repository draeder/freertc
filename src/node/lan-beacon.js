// LAN discovery for local relays: relays on one network find each other with
// a UDP broadcast and link over the LAN (relay-links.js), so federation
// between them never leaves the building.
//
// Every BEACON_EVERY_MS a relay broadcasts { freertc: 'lan', v: 1, node_id, port }
// to 255.255.255.255:FREERTC_LAN_PORT. A beacon is only a hint: the link it
// leads to is authenticated (each side signs the other's nonce with the key its
// node ID comes from), so a false beacon costs a failed handshake and nothing
// else. Loopback addresses are never linked, and nothing learned here is stored
// in the overlay: a relay is still federated under its public (tunnel) address,
// and a public relay still never publishes a private one.

import dgram from 'node:dgram';
import { networkInterfaces } from 'node:os';

export const DEFAULT_LAN_PORT = 41235;
const BEACON_EVERY_MS = 30_000;

/** Whether an IPv4 address is on a LAN this relay could link over (not loopback). */
export function isLanAddress(address) {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(String(address));
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** Whether this host has any LAN address at all. */
export function hasLanAddress() {
  return Object.values(networkInterfaces()).flat().some((entry) => entry && !entry.internal && entry.family === 'IPv4' && isLanAddress(entry.address));
}

export function startLanBeacon({ nodeId, port, lanPort = DEFAULT_LAN_PORT, onRelay, log = () => {} }) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let timer = null;
  socket.on('error', (error) => log(`LAN beacon: ${error.message}`));
  socket.on('message', (raw, remote) => {
    let beacon;
    try { beacon = JSON.parse(String(raw)); } catch { return; }
    if (beacon?.freertc !== 'lan' || beacon.v !== 1 || beacon.node_id === nodeId) return;
    if (!/^[0-9a-f]{64}$/.test(String(beacon.node_id)) || !Number.isInteger(beacon.port)) return;
    if (!isLanAddress(remote.address)) return;
    onRelay(beacon.node_id, `ws://${remote.address}:${beacon.port}/api/v1/link`);
  });
  socket.bind(lanPort, () => {
    try { socket.setBroadcast(true); } catch {}
    const beacon = Buffer.from(JSON.stringify({ freertc: 'lan', v: 1, node_id: nodeId, port }));
    const send = () => socket.send(beacon, lanPort, '255.255.255.255', () => {});
    send();
    timer = setInterval(send, BEACON_EVERY_MS);
    timer.unref?.();
    log(`LAN beacon on udp ${lanPort}`);
  });
  socket.unref?.();
  return { stop() { clearInterval(timer); try { socket.close(); } catch {} } };
}
