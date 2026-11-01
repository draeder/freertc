// A Node relay's own numbers, for the people running it: GET /stats (the
// dashboard, src/node/stats-page.js) and GET /api/v1/stats (JSON).
//
//   traffic     HTTP requests, WebSocket connections (now, peak, total),
//               messages and bytes each way, totals and per second
//   accounts    PigeonIdP records kept, looked up, registered, refused, and
//               shared with other local relays (sent on, fetched, received)
//   federation  links to other local relays, how the relay is reached
//   performance this process (CPU, memory, event-loop delay) and the machine
//               (load, memory, CPUs)
//   history     a sample every 5 s for the last hour, for the charts
//
// Counters only: no peer IDs, addresses or account names are kept.

import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const SAMPLE_MS = 5_000;
const HISTORY_SAMPLES = 720; // an hour

const byteLength = (data) => {
  if (data == null) return 0;
  if (typeof data === 'string') return Buffer.byteLength(data);
  if (typeof data.byteLength === 'number') return data.byteLength;
  if (Array.isArray(data)) return data.reduce((n, part) => n + byteLength(part), 0);
  return Buffer.byteLength(String(data));
};

export function createRelayStats({ now = () => Date.now() } = {}) {
  const startedAt = now();
  const traffic = {
    httpRequests: 0,
    httpBytesIn: 0,
    httpBytesOut: 0,
    connectionsOpened: 0,
    connectionsOpen: 0,
    connectionsPeak: 0,
    messagesIn: 0,
    messagesOut: 0,
    bytesIn: 0,
    bytesOut: 0,
  };
  const accounts = {
    lookups: 0,          // idp-get from browsers on this relay
    found: 0,            //   ... answered with a record
    registrations: 0,    // idp-put from browsers that were stored
    unchanged: 0,        // idp-put already up to date
    refused: 0,          // idp-put refused (taken, invalid, upgrade, full)
    receivedFromRelays: 0, // idp-put from another relay, stored
    askedByRelays: 0,    // idp-get from another relay
    sentToRelays: 0,     // records this relay sent on
    askedRelays: 0,      // lookups this relay made of other relays
    stored: () => 0,
  };
  let links = () => ({ linked: 0, relays: [] });
  let reach = () => ({});
  let events = () => [];

  // Node's measurement includes its own sampling interval: subtract it, so an
  // idle relay reads about 0 ms.
  const LOOP_RESOLUTION_MS = 10;
  const loopDelay = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
  loopDelay.enable();

  /** Count a WebSocket (or anything with send and on('message')) both ways. */
  function watchSocket(socket) {
    if (!socket || socket.__freertcStats) return socket;
    socket.__freertcStats = true;
    traffic.connectionsOpened++;
    traffic.connectionsOpen++;
    traffic.connectionsPeak = Math.max(traffic.connectionsPeak, traffic.connectionsOpen);
    socket.on?.('message', (data) => {
      traffic.messagesIn++;
      traffic.bytesIn += byteLength(data);
    });
    let counted = true;
    socket.on?.('close', () => {
      if (!counted) return;
      counted = false;
      traffic.connectionsOpen = Math.max(0, traffic.connectionsOpen - 1);
    });
    if (typeof socket.send === 'function') {
      const send = socket.send.bind(socket);
      socket.send = (data, ...rest) => {
        traffic.messagesOut++;
        traffic.bytesOut += byteLength(data);
        return send(data, ...rest);
      };
    }
    return socket;
  }

  function http(bytesIn, bytesOut) {
    traffic.httpRequests++;
    traffic.httpBytesIn += bytesIn;
    traffic.httpBytesOut += bytesOut;
  }

  /** Count an account request and what the store answered. */
  function account(body, result) {
    const fromRelay = body?.from_relay === true;
    if (body?.action === 'idp-get') {
      if (fromRelay) accounts.askedByRelays++;
      else {
        accounts.lookups++;
        if (result?.record) accounts.found++;
      }
    } else if (body?.action === 'idp-put') {
      if (result?.ok && result.stored) {
        if (fromRelay) accounts.receivedFromRelays++;
        else accounts.registrations++;
      } else if (result?.ok) accounts.unchanged++;
      else accounts.refused++;
    }
  }

  /** Count a request this relay's account store made of another relay. */
  function accountOutbound(body) {
    if (body?.action === 'idp-put') accounts.sentToRelays++;
    else if (body?.action === 'idp-get') accounts.askedRelays++;
  }

  // History: one sample every 5 s.
  const history = [];
  let last = { at: startedAt, ...traffic, cpu: process.cpuUsage() };
  let latest = { cpuPercent: 0 };
  const sample = () => {
    const at = now();
    const seconds = Math.max(0.001, (at - last.at) / 1000);
    const cpu = process.cpuUsage();
    const cpuPercent = ((cpu.user - last.cpu.user + cpu.system - last.cpu.system) / 1e6 / seconds) * 100;
    const memory = process.memoryUsage();
    const point = {
      at,
      connections: traffic.connectionsOpen,
      messagesInPerSecond: (traffic.messagesIn - last.messagesIn) / seconds,
      messagesOutPerSecond: (traffic.messagesOut - last.messagesOut) / seconds,
      bytesInPerSecond: (traffic.bytesIn + traffic.httpBytesIn - last.bytesIn - last.httpBytesIn) / seconds,
      bytesOutPerSecond: (traffic.bytesOut + traffic.httpBytesOut - last.bytesOut - last.httpBytesOut) / seconds,
      cpuPercent,
      loopDelayP99Ms: Math.max(0, loopDelay.percentile(99) / 1e6 - LOOP_RESOLUTION_MS),
      rssMb: memory.rss / 1048576,
    };
    loopDelay.reset();
    history.push(point);
    if (history.length > HISTORY_SAMPLES) history.shift();
    latest = point;
    last = { at, ...traffic, cpu };
  };
  const timer = setInterval(sample, SAMPLE_MS);
  timer.unref?.();

  function snapshot() {
    const memory = process.memoryUsage();
    const cpus = os.cpus();
    return {
      ok: true,
      at: now(),
      startedAt,
      uptimeSeconds: Math.round((now() - startedAt) / 1000),
      traffic: { ...traffic },
      rates: {
        messagesInPerSecond: latest.messagesInPerSecond ?? 0,
        messagesOutPerSecond: latest.messagesOutPerSecond ?? 0,
        bytesInPerSecond: latest.bytesInPerSecond ?? 0,
        bytesOutPerSecond: latest.bytesOutPerSecond ?? 0,
      },
      accounts: { ...accounts, stored: accounts.stored() },
      federation: { ...links(), ...reach() },
      process: {
        cpuPercent: latest.cpuPercent ?? 0,
        loopDelayP99Ms: latest.loopDelayP99Ms ?? 0,
        rssMb: memory.rss / 1048576,
        heapUsedMb: memory.heapUsed / 1048576,
        heapTotalMb: memory.heapTotal / 1048576,
        node: process.version,
        pid: process.pid,
      },
      system: {
        platform: `${os.type()} ${os.release()} (${os.arch()})`,
        cpus: cpus.length,
        cpuModel: cpus[0]?.model ?? null,
        loadAverage: os.loadavg(),
        memoryTotalMb: os.totalmem() / 1048576,
        memoryFreeMb: os.freemem() / 1048576,
        uptimeSeconds: Math.round(os.uptime()),
      },
      events: events(),
      history,
    };
  }

  return {
    watchSocket,
    http,
    account,
    accountOutbound,
    snapshot,
    /** Where the account count comes from (the store's size). */
    setAccountCount: (fn) => { accounts.stored = fn; },
    /** Where the link list comes from. */
    setLinks: (fn) => { links = fn; },
    /** How the relay is reached, its name and kind, its federation line. */
    setReach: (fn) => { reach = fn; },
    /** Recent account events between relays (newest last). */
    setEvents: (fn) => { events = fn; },
    stop: () => { clearInterval(timer); loopDelay.disable(); },
  };
}

/** Whether an address is this machine or the local network (loopback, private, link-local). */
export function isLocalAddress(address) {
  const value = String(address || '').replace(/^::ffff:/, '').toLowerCase();
  if (!value) return false;
  if (value === '::1' || value === 'localhost' || /^f[cd][0-9a-f]{2}:/.test(value) || /^fe[89ab][0-9a-f]:/.test(value)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(value);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}
