// How one relay calls another over HTTP.
//
// A relay at a bare public IP (a local relay whose router forwards its TCP
// port, see scripts/node-relay.mjs) is reached with no tunnel. A Cloudflare
// Worker cannot fetch() a bare IP address, but it can open a TCP connection
// to one (cloudflare:sockets), so there this speaks HTTP/1.1 itself. The
// calls carry only signed or public data, so they need no TLS.
//
// Everywhere else (named hosts, and Node) it is plain fetch().

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export function isIpLiteralHost(hostname) {
  return IPV4.test(hostname) || hostname.startsWith('[');
}

function inWorker() {
  return typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';
}

let socketsModule = null;
async function sockets() {
  socketsModule ??= import('cloudflare:sockets');
  return socketsModule;
}

export async function relayFetch(url, init = {}) {
  const target = new URL(url);
  if (target.protocol !== 'http:' || !isIpLiteralHost(target.hostname) || !inWorker()) {
    return fetch(url, init);
  }
  return fetchOverTcp(target, init);
}

function indexOfCrlfCrlf(bytes, from = 0) {
  for (let i = from; i + 3 < bytes.length; i += 1) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i;
  }
  return -1;
}

function concat(chunks, total) {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

/** Decode a chunked transfer-encoded body. */
export function dechunk(bytes) {
  const decoder = new TextDecoder();
  const parts = [];
  let total = 0;
  let i = 0;
  while (i < bytes.length) {
    let lineEnd = i;
    while (lineEnd + 1 < bytes.length && !(bytes[lineEnd] === 13 && bytes[lineEnd + 1] === 10)) lineEnd += 1;
    const size = parseInt(decoder.decode(bytes.subarray(i, lineEnd)).split(';')[0].trim(), 16);
    if (!Number.isFinite(size)) throw new Error('bad chunked body');
    if (size === 0) break;
    const start = lineEnd + 2;
    parts.push(bytes.subarray(start, start + size));
    total += size;
    i = start + size + 2;
  }
  return concat(parts, total);
}

/** Parse a complete HTTP/1.1 response (headers and body, read until close). */
export function parseHttpResponse(bytes) {
  const headerEnd = indexOfCrlfCrlf(bytes);
  if (headerEnd < 0) throw new Error('incomplete HTTP response');
  const lines = new TextDecoder().decode(bytes.subarray(0, headerEnd)).split('\r\n');
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(lines[0])?.[1]);
  if (!status) throw new Error('bad HTTP status line');
  const headers = new Headers();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  let body = bytes.subarray(headerEnd + 4);
  if (/chunked/i.test(headers.get('transfer-encoding') || '')) body = dechunk(body);
  else if (headers.has('content-length')) body = body.subarray(0, Number(headers.get('content-length')));
  headers.delete('transfer-encoding');
  const nullBody = status === 204 || status === 304 || (status >= 100 && status < 200);
  return new Response(nullBody ? null : body, { status, headers });
}

async function fetchOverTcp(target, init) {
  const { connect } = await sockets();
  const method = String(init.method || 'GET').toUpperCase();
  const body = init.body == null ? null
    : typeof init.body === 'string' ? new TextEncoder().encode(init.body)
      : new Uint8Array(init.body);
  const headers = new Headers(init.headers || {});
  headers.set('Host', target.host);
  headers.set('Connection', 'close');
  headers.set('User-Agent', 'freertc-relay');
  if (body) headers.set('Content-Length', String(body.length));
  let head = `${method} ${target.pathname}${target.search} HTTP/1.1\r\n`;
  for (const [name, value] of headers) head += `${name}: ${value}\r\n`;
  head += '\r\n';

  const socket = connect({ hostname: target.hostname.replace(/^\[|\]$/g, ''), port: Number(target.port || 80) });
  const abort = () => { try { socket.close(); } catch {} };
  if (init.signal?.aborted) { abort(); throw new DOMException('aborted', 'AbortError'); }
  init.signal?.addEventListener?.('abort', abort, { once: true });
  try {
    const writer = socket.writable.getWriter();
    await writer.write(new TextEncoder().encode(head));
    if (body) await writer.write(body);
    writer.releaseLock();

    const reader = socket.readable.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (total > MAX_RESPONSE_BYTES) throw new Error('response too large');
    }
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return parseHttpResponse(concat(chunks, total));
  } finally {
    init.signal?.removeEventListener?.('abort', abort);
    abort();
  }
}
