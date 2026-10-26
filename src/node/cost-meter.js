// What this relay would cost on Cloudflare's free plan, counted while it runs
// under Node. The Node relay runs the worker's own code, so every request,
// WebSocket message and D1 query here is one the worker would see too. Each
// event is classified the way the worker deployment bills it:
//
//   Worker request   every HTTP request and WebSocket upgrade that reaches the relay
//   DO request       a request the worker hands to a Durable Object: the relay
//                    coordinator (/ws upgrades, /health, /debug/state, POST
//                    /api/v1/relay) or a relay tunnel (/t/<node id>/...)
//   DO WS message    a message arriving on a socket a Durable Object holds (peer
//                    sockets, tunnel sockets). Cloudflare bills these at 20:1 as
//                    DO requests. Tunnel keepalive pings are auto-answered by the
//                    runtime and not billed, so they are not counted.
//   D1 read / write  one statement each; rows written from the statement's changes
//
// GET /debug/cost on a Node relay returns the counters.

import { TUNNEL_PING } from '../tunnel/frames.js';

const DO_PATHS = new Set(['/health', '/debug/state']);
const WRITE_SQL = /^\s*(insert|update|delete|replace|create|drop|alter)\b/i;

export function createCostMeter() {
  const counts = {
    workerRequests: 0,
    doRequests: 0,
    doWsMessages: 0,
    d1Reads: 0,
    d1Writes: 0,
    d1RowsWritten: 0,
    byPath: {},
  };
  const bump = (key) => { counts.byPath[key] = (counts.byPath[key] ?? 0) + 1; };
  const pathKey = (method, pathname, upgrade) => {
    const base = pathname.startsWith('/t/') ? `/t/*/${pathname.split('/').slice(3).join('/')}` : pathname;
    return `${upgrade ? 'WS' : method} ${base}`;
  };

  return {
    counts,
    /** One HTTP request or upgrade reaching the relay. */
    request(method, pathname, upgrade = false) {
      counts.workerRequests += 1;
      bump(pathKey(method, pathname, upgrade));
      const isDo = pathname.startsWith('/t/')
        || (upgrade && pathname === '/ws')
        || DO_PATHS.has(pathname)
        || (method === 'POST' && pathname === '/api/v1/relay');
      if (isDo) counts.doRequests += 1;
    },
    /** One message arriving on a socket a Durable Object would hold. */
    wsMessage(data) {
      if (String(data) === TUNNEL_PING) return;
      counts.doWsMessages += 1;
    },
    /** Wrap a D1 binding so every statement it runs is counted. */
    wrapD1(db) {
      const meter = counts;
      const wrapStatement = (sql, statement) => ({
        bind: (...values) => wrapStatement(sql, statement.bind(...values)),
        async all() { meter.d1Reads += 1; return statement.all(); },
        async first(column) { meter.d1Reads += 1; return statement.first(column); },
        async run() {
          const result = await statement.run();
          if (WRITE_SQL.test(sql)) {
            meter.d1Writes += 1;
            meter.d1RowsWritten += Number(result?.meta?.changes ?? 0);
          } else {
            meter.d1Reads += 1;
          }
          return result;
        },
      });
      return {
        ...db,
        prepare: (sql) => wrapStatement(sql, db.prepare(sql)),
        async batch(statements) {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          return results;
        },
      };
    },
    snapshot() {
      return {
        ...counts,
        doWsMessagesBilled: counts.doWsMessages / 20,
        byPath: { ...counts.byPath },
      };
    },
  };
}
