// Rendezvous for hole punching: the only thing a public service does for a
// local freertc server is introduce it. A local server registers a listener
// id; a node that wants to reach it posts an offer to that id; the two swap a
// few signaling messages (offer, answer, ICE candidates) through here; then
// they talk directly over the hole their own packets punched, and this
// service is out of the loop until the next introduction.
//
// Written against the fetch Request/Response API so the same handler runs in
// the Cloudflare worker and in a plain Node server. State lives in a store
// with get/put/delete, so the worker can back it with D1 or KV and a Node
// stand-in with a Map.

const LISTENER_TTL_MS = 90_000;
const MESSAGE_TTL_MS = 60_000;
const MAX_MESSAGES_PER_MAILBOX = 64;
const MAX_BODY_BYTES = 64 * 1024;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const POLL_STEP_MS = 250;

export class MemoryRendezvousStore {
  constructor() {
    this.listeners = new Map(); // listenerId -> { info, expiresAt }
    this.mailboxes = new Map(); // id -> [{ message, expiresAt }]
  }

  registerListener(listenerId, info, now = Date.now()) {
    this.listeners.set(listenerId, { info, expiresAt: now + LISTENER_TTL_MS });
  }

  listListeners(now = Date.now()) {
    const out = [];
    for (const [listenerId, entry] of this.listeners) {
      if (entry.expiresAt <= now) { this.listeners.delete(listenerId); continue; }
      out.push({ listenerId, ...entry.info });
    }
    return out;
  }

  hasListener(listenerId, now = Date.now()) {
    const entry = this.listeners.get(listenerId);
    return Boolean(entry && entry.expiresAt > now);
  }

  push(to, message, now = Date.now()) {
    const box = (this.mailboxes.get(to) ?? []).filter((item) => item.expiresAt > now);
    box.push({ message, expiresAt: now + MESSAGE_TTL_MS });
    while (box.length > MAX_MESSAGES_PER_MAILBOX) box.shift();
    this.mailboxes.set(to, box);
  }

  take(id, now = Date.now()) {
    const box = (this.mailboxes.get(id) ?? []).filter((item) => item.expiresAt > now);
    this.mailboxes.delete(id);
    return box.map((item) => item.message);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
  });
}

async function readJson(request) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Handle /api/v1/punch/*. Returns null for any other path so a caller can
 * mount it in front of its own routes.
 *
 *   POST /api/v1/punch/register   { listenerId, info? }        a local server is here
 *   GET  /api/v1/punch/listeners                               who can be dialed
 *   POST /api/v1/punch/send       { to, from, session, signal } one signaling message
 *   GET  /api/v1/punch/poll?id=&waitMs=                        messages for id (long-poll)
 */
export async function handleRendezvousRequest(request, store, { wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/v1/punch/')) return null;
  const route = url.pathname.slice('/api/v1/punch/'.length);

  if (route === 'register' && request.method === 'POST') {
    const body = await readJson(request);
    if (!ID.test(String(body?.listenerId ?? ''))) return json({ ok: false, error: 'Invalid listenerId' }, 400);
    const info = body.info && typeof body.info === 'object' ? { name: String(body.info.name ?? '').slice(0, 120) } : {};
    await store.registerListener(body.listenerId, info);
    return json({ ok: true, ttlMs: LISTENER_TTL_MS });
  }

  if (route === 'listeners' && request.method === 'GET') {
    return json({ ok: true, listeners: await store.listListeners() });
  }

  if (route === 'send' && request.method === 'POST') {
    const body = await readJson(request);
    const { to, from, session, signal } = body ?? {};
    if (![to, from, session].every((value) => ID.test(String(value ?? '')))) {
      return json({ ok: false, error: 'Invalid to, from or session' }, 400);
    }
    if (!signal || typeof signal !== 'object') return json({ ok: false, error: 'Missing signal' }, 400);
    await store.push(to, { from, session, signal });
    return json({ ok: true });
  }

  if (route === 'poll' && request.method === 'GET') {
    const id = String(url.searchParams.get('id') ?? '');
    if (!ID.test(id)) return json({ ok: false, error: 'Invalid id' }, 400);
    const waitMs = Math.max(0, Math.min(25_000, Number(url.searchParams.get('waitMs') || 0)));
    const deadline = Date.now() + waitMs;
    let messages = await store.take(id);
    while (messages.length === 0 && Date.now() < deadline) {
      await wait(Math.min(POLL_STEP_MS, deadline - Date.now()));
      messages = await store.take(id);
    }
    return json({ ok: true, messages });
  }

  return json({ ok: false, error: 'Unknown punch endpoint' }, 404);
}
