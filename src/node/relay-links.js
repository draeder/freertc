// Local-to-local federation: links between relays that carry their federation
// calls directly, instead of out through a cloud tunnel home and back.
//
// Two local relays behind NAT reach each other at wss://<home>/t/<node id>/...,
// so every DHT lookup, peer query and forwarded signal between them crossed a
// cloud relay twice. A link is a socket between the two relays themselves:
//   - a punched data channel (label freertc-federation), introduced once
//     through the other relay's tunnel exactly as a client's would be; or
//   - a WebSocket to the other relay's LAN address (/api/v1/link), when the two
//     share a network (see lan-beacon.js).
// Either way both ends prove who they are before anything else crosses:
//   each side  → { t: 'challenge', nonce }
//   each side  → { t: 'hello', record, signature,    its signed node record, and
//                  pq_public_key, pq_signature }     a signature over the other's nonce;
//                                                   with its post-quantum key (relay-pq.js),
//                                                   also a hybrid one. A relay with pq set
//                                                   links only to relays that prove one,
//                                                   the same one as the first time, and the
//                                                   link is then encrypted end to end
//                                                   (link-crypto.js): hello carries fresh
//                                                   keys, then each side sends
//                                                   { t: 'key', c } and every frame after is
//                                                   { t: 'enc', n, c }.
// then requests flow both ways in the tunnel's own frame format:
//   { t: 'req', id, method, path, headers, body }  →  { t: 'res', id, status, headers, body }
// The relay's fetch is wrapped (wrapFetch) so a federation call to a linked
// relay's tunnel URL goes over the link; everything else is unchanged.
//
// Which relays to link to: other local relays this relay has verified through
// the overlay, at most MAX_LINKS, one per XOR bucket first (the relays most
// unlike this one in ID, as Kademlia keeps its contacts), and only the one with
// the lower node ID dials, so two relays make one link between them.

import { decodeBody, encodeBody, forwardHeaders } from '../tunnel/frames.js';
import { decryptMessageWithMeta, encryptMessageWithMeta, generateRandomPair } from 'unsea';
import { signLinkChallenge, signLinkChallengePq, verifyLinkChallenge, verifyLinkChallengePq, verifySignedRelayRecord } from '../relay-identity.js';
import { createLinkChannel, ephemeralDigest, randomLinkSecret } from './link-crypto.js';

export const LINK_CHANNEL_LABEL = 'freertc-federation';
export const LINK_PATH = '/api/v1/link';
const MAX_LINKS = 8;
const HELLO_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAINTAIN_EVERY_MS = 60_000;
const REDIAL_AFTER_MS = 5 * 60_000;
const TUNNEL_PATH_RE = /^\/t\/([0-9a-f]{64})(\/.*)$/;

const randomNonce = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

/** Highest differing bit between two node IDs: the Kademlia bucket. */
export function bucketOf(a, b) {
  for (let i = 0; i < 64; i += 1) {
    const x = Number.parseInt(a[i], 16) ^ Number.parseInt(b[i], 16);
    if (x) return 255 - (i * 4 + (3 - Math.floor(Math.log2(x))));
  }
  return -1;
}

/** Choose which relays to link to: distinct buckets first, then the closest rest. */
export function chooseLinkTargets(selfNodeId, records, max = MAX_LINKS) {
  const others = records.filter((r) => r?.node_id && r.node_id !== selfNodeId);
  const byBucket = new Map();
  for (const record of others) {
    const bucket = bucketOf(selfNodeId, record.node_id);
    if (!byBucket.has(bucket)) byBucket.set(bucket, []);
    byBucket.get(bucket).push(record);
  }
  const chosen = [];
  for (const bucket of [...byBucket.keys()].sort((a, b) => b - a)) {
    if (chosen.length >= max) break;
    chosen.push(byBucket.get(bucket).sort((a, b) => a.node_id.localeCompare(b.node_id))[0]);
  }
  for (const record of others.sort((a, b) => a.node_id.localeCompare(b.node_id))) {
    if (chosen.length >= max) break;
    if (!chosen.includes(record)) chosen.push(record);
  }
  return chosen;
}

export function createRelayLinks({
  identity,
  nodeRecord,
  handleRequest,
  dialPunch = null,
  dialLan = null,
  listRelays = async () => [],
  maxLinks = MAX_LINKS,
  log = () => {},
  verifyRecord = verifySignedRelayRecord,
  // { identity: { pub, priv, qpub, qpriv }, pins: { get, set }, required = true }
  pq = null,
  // Called once a link has proved both ends (and, with pq, is encrypted):
  // the place to exchange what only proved relays may have.
  onLinked = () => {},
}) {
  const links = new Map(); // node id -> link
  const lastDial = new Map(); // node id -> when we last tried
  let stopped = false;

  // A post-quantum answer: valid, and the key pinned for that node id (or the
  // first one seen, which is pinned now).
  async function pqOk(record, frame, nonce, peerEphemeralDigest) {
    const pinned = pq.pins?.get(record.node_id) ?? null;
    const short = record.node_id.slice(0, 8);
    if (typeof frame.pq_public_key !== 'string') {
      if (pinned || pq.required !== false) {
        log(`refused a link from ${short}: it did not prove a post-quantum key${pinned ? ' (it had one before)' : ''}`);
        return false;
      }
      return true;
    }
    if (pinned && pinned !== frame.pq_public_key) {
      log(`refused a link from ${short}: its post-quantum key is not the one it had before`);
      return false;
    }
    if (!await verifyLinkChallengePq(record.public_key, frame.pq_public_key, record.node_id, nonce, frame.pq_signature, peerEphemeralDigest)) {
      log(`refused a link from ${short}: its post-quantum signature did not check out`);
      return false;
    }
    if (!pinned) pq.pins?.set(record.node_id, frame.pq_public_key);
    return true;
  }

  function attach(socket, { via = 'punch', expectNodeId = null } = {}) {
    const myNonce = randomNonce();
    const pending = new Map();
    const answered = new Set();
    let peerNodeId = null;
    let closed = false;
    // Encrypted links (with post-quantum keys): this link's fresh keys, the
    // secret this side contributes, and the channel once both are in.
    const secure = Boolean(pq?.identity);
    const ephemeral = secure ? generateRandomPair() : null;
    const mySecret = secure ? randomLinkSecret() : null;
    let peerNonce = null;
    let verified = null; // { record, ephemeral } once the peer's hello checks out
    let peerKeyFrame = null;
    let channel = null;
    // Sealed frames that arrive while this side is still opening the other's
    // link key (the other side may finish first and send at once): held, and
    // opened in order once the channel exists.
    const earlySealed = [];
    const link = {
      via,
      get nodeId() { return peerNodeId; },
      get open() { return Boolean(peerNodeId) && !closed; },
      request,
      close: () => { try { socket.close(); } catch {} },
    };
    const sendRaw = (frame) => { try { socket.send(JSON.stringify(frame)); } catch {} };
    // Requests and responses go sealed on an encrypted link.
    const send = (frame) => (channel && (frame.t === 'req' || frame.t === 'res') ? channel.seal(frame, sendRaw) : sendRaw(frame));
    const helloTimer = setTimeout(() => { if (!peerNodeId) { log(`link over ${via} did not identify itself`); link.close(); } }, HELLO_TIMEOUT_MS);
    helloTimer.unref?.();

    async function request(method, path, headers, bodyBytes) {
      if (!link.open) throw new Error('link is not open');
      const id = randomNonce();
      const reply = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('link request timed out')); }, REQUEST_TIMEOUT_MS);
        timer.unref?.();
        pending.set(id, (frame) => { clearTimeout(timer); pending.delete(id); resolve(frame); });
      });
      send({ t: 'req', id, method, path, headers, body: bodyBytes ? encodeBody(bodyBytes) : null });
      const frame = await reply;
      const status = Number(frame.status) || 502;
      const nullBody = method === 'HEAD' || status === 204 || status === 304 || !frame.body;
      return new Response(nullBody ? null : decodeBody(frame.body), { status, headers: frame.headers || [] });
    }

    socket.on('message', async (raw) => {
      let frame;
      try { frame = JSON.parse(String(raw)); } catch { return; }
      if (frame?.t === 'challenge' && typeof frame.nonce === 'string') {
        if (answered.has(frame.nonce)) return;
        if (secure && peerNonce && peerNonce !== frame.nonce) return; // one handshake per link
        answered.add(frame.nonce);
        peerNonce = frame.nonce;
        const fresh = secure ? await ephemeral : null;
        const freshPublic = fresh ? { epub: fresh.epub, kpub: fresh.kpub } : null;
        sendRaw({
          t: 'hello',
          record: await nodeRecord(),
          signature: await signLinkChallenge(identity, frame.nonce),
          ...(pq?.identity ? {
            pq_public_key: pq.identity.qpub,
            pq_signature: await signLinkChallengePq(pq.identity, identity.nodeId, frame.nonce, await ephemeralDigest(freshPublic)),
            ephemeral: freshPublic,
          } : {}),
        });
        return;
      }
      if (frame?.t === 'key' && secure) {
        if (channel || peerKeyFrame) return;
        peerKeyFrame = frame;
        await finishSecure();
        return;
      }
      if (frame?.t === 'enc' && secure) {
        if (!channel) {
          if (earlySealed.length < 64) earlySealed.push(frame);
          return;
        }
        await openSealed(frame);
        return;
      }
      if (frame?.t === 'hello') {
        if (peerNodeId) return;
        const record = frame.record;
        const ok = record && record.node_id !== identity.nodeId
          && (!expectNodeId || record.node_id === expectNodeId)
          && await verifyRecord(record)
          && await verifyLinkChallenge(record.public_key, myNonce, frame.signature);
        if (!ok) { log(`link over ${via} failed to identify itself`); link.close(); return; }
        const peerEphemeral = frame.ephemeral && typeof frame.ephemeral.epub === 'string' && typeof frame.ephemeral.kpub === 'string'
          ? { epub: frame.ephemeral.epub, kpub: frame.ephemeral.kpub } : null;
        if (secure && !peerEphemeral && frame.pq_public_key) { log(`refused a link from ${record.node_id.slice(0, 8)}: no keys for an encrypted link`); link.close(); return; }
        if (pq && !await pqOk(record, frame, myNonce, peerEphemeral ? await ephemeralDigest(peerEphemeral) : '')) { link.close(); return; }
        if (verified || peerNodeId) return;
        if (!secure || !frame.pq_public_key) {
          // Without post-quantum keys on both ends (FREERTC_PQ=off and pq not
          // required): the link as before, unencrypted.
          open(record);
          return;
        }
        verified = { record, ephemeral: peerEphemeral };
        // This side's secret, encrypted to the other side's fresh keys.
        sendRaw({ t: 'key', c: await encryptMessageWithMeta(mySecret, peerEphemeral) });
        await finishSecure();
        return;
      }
      if (!peerNodeId || channel) return; // nothing but the handshake before it completes; sealed frames only on an encrypted link
      await handleFrame(frame);
    });

    function open(record) {
      if (peerNodeId || closed) return;
      clearTimeout(helloTimer);
      const existing = links.get(record.node_id);
      if (existing?.open) { log(`already linked to ${record.node_id.slice(0, 8)}; closing the second link`); link.close(); return; }
      peerNodeId = record.node_id;
      link.url = typeof record.url === 'string' ? record.url : null;
      links.set(peerNodeId, link);
      log(`linked to ${peerNodeId.slice(0, 8)} over ${via}${channel ? ' (encrypted, post-quantum)' : ''}`);
      try { Promise.resolve(onLinked(peerNodeId, link)).catch(() => {}); } catch { /* the link stands either way */ }
    }

    // Both secrets in (ours sent, theirs received): make the channel and open the link.
    // Runs once: the hello and the key frame can each be the one that
    // completes the handshake, and both may arrive while the other's
    // decryption is still under way; a second channel would restart the
    // frame numbering and every later frame would fail to open.
    let finishing = null;
    function finishSecure() {
      if (channel || !verified || !peerKeyFrame) return finishing ?? Promise.resolve();
      finishing ??= finishSecureOnce();
      return finishing;
    }

    async function finishSecureOnce() {
      const keyFrame = peerKeyFrame;
      let peerSecret;
      try {
        peerSecret = await decryptMessageWithMeta(keyFrame.c, await ephemeral);
      } catch {
        log(`link from ${verified.record.node_id.slice(0, 8)}: its link key did not open; closing`);
        link.close();
        return;
      }
      if (channel) return;
      channel = await createLinkChannel({
        selfId: identity.nodeId,
        peerId: verified.record.node_id,
        selfNonce: myNonce,
        peerNonce,
        selfSecret: mySecret,
        peerSecret,
      }).catch(() => null);
      if (!channel) { link.close(); return; }
      open(verified.record);
      for (const frame of earlySealed.splice(0)) openSealed(frame);
    }

    async function openSealed(frame) {
      const inner = await channel.open(frame);
      if (!inner) { log(`link to ${peerNodeId?.slice(0, 8) ?? '?'}: a frame did not open; closing`); link.close(); return; }
      if (inner.t === 'req' || inner.t === 'res') await handleFrame(inner);
    }

    async function handleFrame(frame) {
      if (frame?.t === 'req' && typeof frame.id === 'string' && typeof frame.path === 'string') {
        try {
          const request = new Request(new URL(frame.path, 'http://relay-link'), {
            method: frame.method || 'GET',
            headers: frame.headers || [],
            body: frame.body && frame.method !== 'GET' && frame.method !== 'HEAD' ? decodeBody(frame.body) : undefined,
          });
          const response = await handleRequest(request);
          const bytes = new Uint8Array(await response.arrayBuffer());
          send({ t: 'res', id: frame.id, status: response.status, headers: forwardHeaders(response.headers), body: bytes.byteLength ? encodeBody(bytes) : null });
        } catch (error) {
          send({ t: 'res', id: frame.id, status: 502, headers: [], body: null });
          log(`link request ${frame.path} failed: ${error?.message ?? error}`);
        }
        return;
      }
      if (frame?.t === 'res' && pending.has(frame.id)) pending.get(frame.id)(frame);
    }
    socket.on('close', () => {
      closed = true;
      clearTimeout(helloTimer);
      if (peerNodeId && links.get(peerNodeId) === link) links.delete(peerNodeId);
      for (const resolve of pending.values()) resolve({ status: 502 });
      pending.clear();
      if (peerNodeId) log(`link to ${peerNodeId.slice(0, 8)} closed`);
    });
    // The other end may attach its handler a moment after the channel opens
    // (the dialer only gets the socket once its open resolves), so a challenge
    // sent into that gap is lost. Repeat it until the other end has answered.
    send({ t: 'challenge', nonce: myNonce });
    const resend = setInterval(() => {
      if (peerNodeId || closed) { clearInterval(resend); return; }
      send({ t: 'challenge', nonce: myNonce });
    }, 1_000);
    resend.unref?.();
    return link;
  }

  async function maintain() {
    if (stopped) return;
    const records = (await listRelays().catch(() => [])).filter((r) => r?.relay_kind === 'local');
    const targets = chooseLinkTargets(identity.nodeId, records, maxLinks);
    for (const record of targets) {
      if (links.get(record.node_id)?.open) continue;
      // One link per pair: the lower node ID dials.
      if (identity.nodeId > record.node_id) continue;
      if (Date.now() - (lastDial.get(record.node_id) ?? 0) < REDIAL_AFTER_MS) continue;
      const punch = Array.isArray(record.reach) ? record.reach.find((entry) => entry?.via === 'punch') : null;
      if (!punch || !dialPunch) continue;
      lastDial.set(record.node_id, Date.now());
      dialPunch(punch.url)
        .then((socket) => attach(socket, { via: 'punch', expectNodeId: record.node_id }))
        .catch((error) => log(`no link to ${record.node_id.slice(0, 8)}: ${error?.message ?? error}`));
    }
  }

  const timer = setInterval(() => { maintain().catch(() => {}); }, MAINTAIN_EVERY_MS);
  timer.unref?.();

  return {
    links,
    /** The federation URLs of the relays this one is linked to right now. */
    linkedRelayUrls: () => [...links.values()].filter((link) => link.open && link.url).map((link) => link.url),
    accept: (socket, options) => attach(socket, options),
    maintain,
    /** A relay on the LAN announced itself: link to it there (lower node ID dials). */
    lanSeen(nodeId, url) {
      if (stopped || !dialLan || !/^[0-9a-f]{64}$/.test(nodeId) || nodeId === identity.nodeId) return;
      if (links.get(nodeId)?.open || identity.nodeId > nodeId) return;
      if (Date.now() - (lastDial.get(nodeId) ?? 0) < REDIAL_AFTER_MS / 5) return;
      lastDial.set(nodeId, Date.now());
      dialLan(url)
        .then((socket) => attach(socket, { via: 'lan', expectNodeId: nodeId }))
        .catch((error) => log(`no LAN link to ${nodeId.slice(0, 8)}: ${error?.message ?? error}`));
    },
    /** Send federation calls to a linked relay's tunnel URL over the link. */
    wrapFetch(fetchImpl) {
      return async (input, init = undefined) => {
        let url;
        try { url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url); } catch { return fetchImpl(input, init); }
        const match = TUNNEL_PATH_RE.exec(url.pathname);
        const link = match ? links.get(match[1]) : null;
        if (!link?.open) return fetchImpl(input, init);
        const request = new Request(input, init);
        const body = request.method === 'GET' || request.method === 'HEAD' ? null : new Uint8Array(await request.arrayBuffer());
        return link.request(request.method, `${match[2]}${url.search}`, forwardHeaders(request.headers), body && body.byteLength ? body : null);
      };
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      for (const link of links.values()) link.close();
    },
  };
}
