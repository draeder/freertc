import { sha256 as sha256Hex } from 'js-sha256'

/**
 * SHA-256 hash of a string using the browser's built-in Web Crypto API.
 * Returns a lowercase hex string.
 */
export async function sha256(text) {
  const webCrypto = globalThis.window?.crypto ?? globalThis.crypto
  if (webCrypto?.subtle) {
    try {
      const encoded = new TextEncoder().encode(text)
      const buf = await webCrypto.subtle.digest('SHA-256', encoded)
      return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    } catch {
      // Fall through to the pure JS implementation.
    }
  }
  return sha256Hex(text)
}

function fallbackTopicHash(text) {
  // Non-cryptographic fallback for environments without WebCrypto.
  const parts = [0, 1, 2, 3].map((i) => fnv1a(`${text}|${i}`))
  return parts.map((n) => n.toString(16).padStart(8, '0')).join('').padEnd(64, '0').slice(0, 64)
}

function fnv1a(input) {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Generate a short random topic name. */
export function randomTopic() {
  const a = Math.random().toString(36).slice(2, 7)
  const b = Math.random().toString(36).slice(2, 7)
  return `${a}-${b}`
}
