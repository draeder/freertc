// Can relays reach this address? A local relay whose router forwards its TCP
// port asks a cloud relay to call it back before it federates under its
// public address instead of a tunnel:
//
//   POST /api/v1/reachable   body: { port, node_id }
//
// The cloud relay calls http://<the address the request came from>:<port>/health
// (from a Worker, over a TCP socket: see relay-fetch.js) and says whether a
// relay with that node ID answered. It only ever calls the caller's own
// address, so it cannot be used to probe anyone else.

import { relayFetch } from '../relay-fetch.js';

export const REACHABLE_PATH = '/api/v1/reachable';
const PROBE_TIMEOUT_MS = 5_000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function handleReachableRequest(request, { fetchImpl = relayFetch } = {}) {
  if (request.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);
  let body;
  try { body = JSON.parse((await request.text()).slice(0, 2048)); } catch { return json({ ok: false, error: 'bad JSON' }, 400); }
  const port = Number(body?.port);
  const nodeId = String(body?.node_id || '');
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 25) return json({ ok: false, error: 'bad port' }, 400);
  if (!/^[0-9a-f]{64}$/.test(nodeId)) return json({ ok: false, error: 'bad node_id' }, 400);
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return json({ ok: false, error: 'no caller address' }, 400);
  const host = ip.includes(':') ? `[${ip}]` : ip;
  try {
    const response = await fetchImpl(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const health = await response.json().catch(() => null);
    const reachable = response.ok && health?.node_id === nodeId;
    return json({ ok: true, reachable, ip, ...(reachable ? {} : { why: response.ok ? 'another relay answered' : `status ${response.status}` }) });
  } catch (error) {
    return json({ ok: true, reachable: false, ip, why: String(error?.message || error).slice(0, 120) });
  }
}
