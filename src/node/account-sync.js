// Accounts between linked local relays (src/node/relay-links.js). When a link
// opens, and every 10 minutes after, each side takes the other's whole
// PigeonIdP store over it (pigeonidp/relay exportRecords / importRecords), so
// a relay has every account before anyone asks for it, also after a network
// change. Only a linked relay can ask: a link proves both ends, and with
// post-quantum keys it is encrypted end to end.

import { signMessage, verifyMessage } from 'unsea';
import { canonicalJson, relayNodeId } from '../kademlia.js';

export const ACCOUNT_SYNC_PATH = '/api/v1/idp/sync';
export const ACCOUNT_SYNC_EVERY_MS = 10 * 60_000;

export function createAccountSync({ store, event = () => {}, log = () => {} }) {
  /** The answer to a linked relay asking for the store, or null for any other request. */
  function handleLinkRequest(request) {
    if (new URL(request.url).pathname !== ACCOUNT_SYNC_PATH) return null;
    const current = store();
    if (!current) return new Response(JSON.stringify({ ok: false, error: 'no accounts here' }), { status: 404 });
    return new Response(JSON.stringify({ ok: true, records: current.exportRecords() }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /** Take what the relay at the other end of a link holds. */
  async function syncOver(nodeId, link) {
    const current = store();
    if (!current || !link?.open) return null;
    const who = `relay ${String(nodeId).slice(0, 8)}`;
    try {
      const response = await link.request('POST', ACCOUNT_SYNC_PATH, [['content-type', 'application/json']], new TextEncoder().encode('{}'));
      const answer = await response.json().catch(() => null);
      if (!response.ok || !answer?.ok) {
        event(`accounts: ${who}: no sync (${answer?.error || `answered ${response.status}`})`);
        return null;
      }
      const result = await current.importRecords(answer.records, { from: who });
      if (result.stored) log(`accounts: ${result.stored} from ${who}`);
      return result;
    } catch (error) {
      event(`accounts: ${who}: sync failed (${error?.message || error})`);
      return null;
    }
  }

  return { handleLinkRequest, syncOver };
}

// ---------------------------------------------------------------------------
// The same exchange without a link: over the relays' ordinary federation path
// (POST /api/v1/idp), which works wherever one relay can reach another. That
// path is open to anyone, so the request is signed by the asking relay's own
// key (with its post-quantum key, when it has one), and a relay hands over its
// store only to a relay it already knows as a local relay of the federation,
// showing the post-quantum key pinned for it, if one is.

export const ACCOUNT_SYNC_ACTION = 'idp-sync';
const SYNC_REQUEST_MAX_AGE_MS = 5 * 60_000;

const syncRequestText = (nodeId, target, at) => canonicalJson(['freertc-idp-sync', 1, String(nodeId), String(target), Number(at)]);

/** A signed request for another relay's store. target is that relay's federation URL. */
export async function createSyncRequest({ identity, pqIdentity = null, target, now = Date.now() }) {
  const text = syncRequestText(identity.nodeId, target, now);
  return {
    action: ACCOUNT_SYNC_ACTION,
    node_id: identity.nodeId,
    public_key: identity.publicKey,
    ...(pqIdentity ? { pq_public_key: pqIdentity.qpub } : {}),
    target,
    at: now,
    sig: await signMessage(text, pqIdentity || identity.privateKey),
  };
}

/**
 * Whether a sync request comes from a local relay this one knows: signed by
 * the key its node id comes from (and its pinned post-quantum key), recent,
 * and meant for this relay.
 */
export async function verifySyncRequest(body, { selfUrl, knownLocalNodeIds, pinnedPqKey = () => null, now = Date.now() }) {
  try {
    if (body?.action !== ACCOUNT_SYNC_ACTION || typeof body.sig !== 'string') return { ok: false, error: 'malformed' };
    if (Math.abs(now - Number(body.at)) > SYNC_REQUEST_MAX_AGE_MS) return { ok: false, error: 'stale request' };
    const same = (a, b) => { try { return new URL(String(a)).toString() === new URL(String(b)).toString(); } catch { return false; } };
    if (!same(body.target, selfUrl)) return { ok: false, error: 'meant for another relay' };
    if (await relayNodeId(body.public_key) !== body.node_id) return { ok: false, error: 'key does not match node id' };
    const known = await knownLocalNodeIds();
    if (!known.has(body.node_id)) return { ok: false, error: 'not a local relay this one knows' };
    const pinned = pinnedPqKey(body.node_id);
    if (pinned && body.pq_public_key !== pinned) return { ok: false, error: 'not the post-quantum key this relay showed before' };
    const keys = typeof body.pq_public_key === 'string' ? { pub: body.public_key, qpub: body.pq_public_key } : body.public_key;
    if (!await verifyMessage(syncRequestText(body.node_id, body.target, body.at), body.sig, keys)) return { ok: false, error: 'bad signature' };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}
