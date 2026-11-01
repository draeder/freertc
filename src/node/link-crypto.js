// The secure channel inside a link between two local relays (relay-links.js).
//
// Proving keys at the start of a link is not enough on its own: someone in
// the middle could pass both relays' challenges and answers along unchanged
// and then read and inject frames. So with post-quantum keys a link is also
// encrypted, end to end between the two relays:
//   - each side makes a fresh key pair for the link (P-256 + ML-KEM-768) and
//     sends its public half in its hello, covered by its hybrid signature;
//   - each side then sends a random secret encrypted to the other's fresh
//     keys (unsea 3 hybrid encryption);
//   - both secrets, both nonces and both node ids go into HKDF-SHA256, which
//     gives one AES-256-GCM key for each direction;
//   - every frame after that is sealed, numbered, and refused if it is out of
//     order or replayed.
// Someone in the middle sees only ciphertext, cannot change it, and cannot
// make the keys: each needs a secret only the two relays can decrypt.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const unb64 = (text) => new Uint8Array(Buffer.from(String(text), 'base64url'));

export function randomLinkSecret() {
  return b64(crypto.getRandomValues(new Uint8Array(32)));
}

/** A digest of a link's fresh public keys, as the hello signature covers it. */
export async function ephemeralDigest(ephemeral) {
  const text = `${ephemeral?.epub}|${ephemeral?.kpub}`;
  return b64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))));
}

async function directionKey(secret, salt, info) {
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(info) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * The two directions' keys for a link, from both sides' secrets. Both sides
 * get the same pair (ordered by node id), each sending with one and
 * receiving with the other.
 */
export async function createLinkChannel({ selfId, peerId, selfNonce, peerNonce, selfSecret, peerSecret }) {
  const selfFirst = selfId < peerId;
  const [lowId, highId] = selfFirst ? [selfId, peerId] : [peerId, selfId];
  const [lowNonce, highNonce] = selfFirst ? [selfNonce, peerNonce] : [peerNonce, selfNonce];
  const [lowSecret, highSecret] = selfFirst ? [selfSecret, peerSecret] : [peerSecret, selfSecret];
  const secret = new Uint8Array([...unb64(lowSecret), ...unb64(highSecret)]);
  if (secret.length !== 64) throw new Error('bad link secret');
  const transcript = `freertc-link/v2|${lowId}|${highId}|${lowNonce}|${highNonce}`;
  const salt = encoder.encode('freertc-link/v2');
  const sendKey = await directionKey(secret, salt, `${transcript}|${selfId}>${peerId}`);
  const receiveKey = await directionKey(secret, salt, `${transcript}|${peerId}>${selfId}`);

  let sent = 0;
  let received = 0;
  let sending = Promise.resolve();
  let receiving = Promise.resolve();
  const ivFor = (n) => {
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setBigUint64(4, BigInt(n));
    return iv;
  };

  return {
    /** Seal a frame and pass it to transmit, in the order seal was called. */
    seal(frame, transmit) {
      const n = ++sent;
      sending = sending.then(async () => {
        const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivFor(n) }, sendKey, encoder.encode(JSON.stringify(frame)));
        transmit({ t: 'enc', n, c: b64(new Uint8Array(data)) });
      }).catch(() => {});
      return sending;
    },
    /** Open a sealed frame, in arrival order; null when it is forged, replayed or out of order. */
    open(sealed) {
      const result = receiving.then(async () => {
        const n = Number(sealed?.n);
        if (!Number.isSafeInteger(n) || n !== received + 1 || typeof sealed.c !== 'string') return null;
        try {
          const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivFor(n) }, receiveKey, unb64(sealed.c));
          received = n;
          return JSON.parse(decoder.decode(plain));
        } catch {
          return null;
        }
      });
      receiving = result.catch(() => null);
      return result;
    },
  };
}
