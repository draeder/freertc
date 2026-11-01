// Accounts between linked local relays (src/node/relay-links.js). When a link
// opens, and every 10 minutes after, each side takes the other's whole
// PigeonIdP store over it (pigeonidp/relay exportRecords / importRecords), so
// a relay has every account before anyone asks for it, also after a network
// change. Only a linked relay can ask: a link proves both ends, and with
// post-quantum keys it is encrypted end to end.

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
