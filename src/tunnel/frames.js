// What a tunnel carries between a relay behind NAT and its tunnel home: JSON
// text frames over one WebSocket the relay opened outward.
//
//   home → relay  { t: 'challenge', nonce, host }
//   relay → home  { t: 'hello', record, signature }      signed node record + signed nonce
//   home → relay  { t: 'ready', url }
//   home → relay  { t: 'req', id, method, path, headers, body }   an HTTP request for the relay
//   relay → home  { t: 'res', id, status, headers, body }         its answer
//   home → relay  { t: 'open', sid, path, headers }      a WebSocket opened to the relay's /ws
//   both ways     { t: 'data', sid, data }               one message on that WebSocket
//   both ways     { t: 'end', sid, code, reason }        it closed
//   relay → home  'ping'  answered 'pong' without waking a hibernating home
//
// Bodies are base64 so any response, not just JSON, makes it through.

export const TUNNEL_PING = 'ping';
export const TUNNEL_PONG = 'pong';
export const MAX_TUNNEL_BODY_BYTES = 1_000_000;

const HOP_BY_HOP = new Set([
  'connection', 'upgrade', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'host', 'content-length',
  'proxy-authorization', 'proxy-authenticate', 'sec-websocket-key', 'sec-websocket-version',
  'sec-websocket-extensions', 'sec-websocket-accept', 'sec-websocket-protocol',
]);

export function forwardHeaders(headers) {
  const out = [];
  headers.forEach((value, name) => {
    if (!HOP_BY_HOP.has(name.toLowerCase())) out.push([name, value]);
  });
  return out;
}

export function encodeBody(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function decodeBody(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const TUNNEL_ROUTE_RE = /^\/t\/([0-9a-f]{64})(\/.*)?$/;

/** For a path under /t/<node id>, the node id and the path the relay itself sees. */
export function tunnelRoute(pathname) {
  const match = TUNNEL_ROUTE_RE.exec(pathname);
  return match ? { nodeId: match[1], rest: match[2] || '/' } : null;
}

/** ws(s)://home/ws → ws(s)://home/t/<nodeId>/ws */
export function tunnelUrlFor(homeUrl, nodeId) {
  const url = new URL(homeUrl);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol === 'http:') url.protocol = 'ws:';
  url.pathname = `/t/${nodeId}/ws`;
  url.search = '';
  url.hash = '';
  return url.toString();
}
