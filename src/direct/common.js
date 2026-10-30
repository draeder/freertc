// Direct relays: a browser opens a WebRTC data channel straight to a relay's
// public address, with no signaling server, no DNS name for the relay and no
// certificate authority. The relay publishes (in its signed directory record,
// see record.js) its address, a UDP port and the SHA-256 fingerprint of its
// self-signed DTLS certificate; that is everything the browser needs.
//
// The handshake needs no round trip because each side can write the other's
// half itself:
//   - The browser makes an ordinary offer and leaves it alone (Chrome refuses
//     rewritten ICE credentials). It then writes the relay's answer: the relay's
//     address, its fingerprint, and ICE credentials of its own choosing that
//     carry the browser's own ICE username and password inside them:
//       freertc+direct+v1/<browser ufrag>/<browser pwd>
//   - The browser's first ICE check reaches the relay's shared UDP port with
//     that username. The relay reads the browser's credentials out of it,
//     writes the browser's offer to match, answers with the same credentials,
//     and the connection completes.
// DTLS checks the relay's certificate against the fingerprint the browser put
// in the answer, so only the relay that signed the record can answer. The relay
// cannot tell who the browser is; peers prove who they are with signed frames.

export const DIRECT_SCHEME = 'webrtc-direct:';
export const DIRECT_UFRAG_PREFIX = 'freertc+direct+v1/';
export const DIRECT_CHANNEL_LABEL = 'freertc-relay';

const ICE_CHARS = /^[A-Za-z0-9+/]+$/;

function normalizeFingerprintHex(value) {
  const hex = String(value || '').replace(/:/g, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

/** "AB:CD:…" (SDP form) for a 64-digit hex fingerprint. */
export function fingerprintToSdp(hex) {
  return normalizeFingerprintHex(hex).toUpperCase().match(/.{2}/g).join(':');
}

function isIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return Boolean(m) && m.slice(1).every((part) => Number(part) <= 255);
}

function isIPv6(host) {
  return /^[0-9a-f:]+$/i.test(host) && host.includes(':') && host.length <= 39;
}

/** webrtc-direct://<ip>:<port>/sha256/<hex>, with the IPv6 address in brackets. */
export function directRelayUrl({ host, port, fingerprint }) {
  const hex = normalizeFingerprintHex(fingerprint);
  const p = Number(port);
  if (!hex) throw new TypeError('Direct relay fingerprint must be a SHA-256 fingerprint');
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new TypeError('Direct relay port must be 1-65535');
  if (isIPv4(host)) return `${DIRECT_SCHEME}//${host}:${p}/sha256/${hex}`;
  if (isIPv6(host)) return `${DIRECT_SCHEME}//[${host.toLowerCase()}]:${p}/sha256/${hex}`;
  throw new TypeError('Direct relay host must be an IP address');
}

/** { host, port, fingerprint (hex), family } for a direct relay URL, or null. */
export function parseDirectRelayUrl(value) {
  const m = /^webrtc-direct:\/\/(?:\[([0-9a-f:]+)\]|(\d{1,3}(?:\.\d{1,3}){3})):(\d{1,5})\/sha256\/([0-9a-f]{64})$/i.exec(String(value || ''));
  if (!m) return null;
  const host = (m[1] || m[2]).toLowerCase();
  const port = Number(m[3]);
  if (port < 1 || port > 65535) return null;
  if (m[2] && !isIPv4(host)) return null;
  return { host, port, fingerprint: m[4].toLowerCase(), family: m[1] ? 6 : 4 };
}

export function isDirectRelayUrl(value) {
  return parseDirectRelayUrl(value) !== null;
}

/** The ICE username (and password) the relay answers with, carrying the browser's own. */
export function relayIceCredentialFor(browserUfrag, browserPwd) {
  if (!ICE_CHARS.test(browserUfrag) || !ICE_CHARS.test(browserPwd)) {
    throw new TypeError('ICE credentials must be ice-chars');
  }
  const value = `${DIRECT_UFRAG_PREFIX}${browserUfrag}/${browserPwd}`;
  if (value.length > 256) throw new TypeError('ICE credentials are too long');
  return value;
}

/** The browser's { ufrag, pwd } inside a relay ICE username, or null. */
export function parseRelayIceCredential(value) {
  const text = String(value || '');
  if (!text.startsWith(DIRECT_UFRAG_PREFIX) || text.length > 256) return null;
  const parts = text.slice(DIRECT_UFRAG_PREFIX.length).split('/');
  // The password may itself contain '/', so everything after the first part is the password.
  const ufrag = parts.shift();
  const pwd = parts.join('/');
  if (!ufrag || !pwd || !ICE_CHARS.test(ufrag) || !ICE_CHARS.test(pwd)) return null;
  if (ufrag.length < 4 || pwd.length < 22) return null;
  return { ufrag, pwd };
}

/** The relay's answer, written by the browser. */
export function directAnswerSdp({ host, port, fingerprint, family }, credential) {
  const ipVersion = family === 6 ? 'IP6' : 'IP4';
  return [
    'v=0',
    `o=- 0 0 IN ${ipVersion} ${host}`,
    's=-',
    't=0 0',
    'a=ice-lite',
    'a=group:BUNDLE 0',
    `m=application ${port} UDP/DTLS/SCTP webrtc-datachannel`,
    `c=IN ${ipVersion} ${host}`,
    'a=mid:0',
    `a=ice-ufrag:${credential}`,
    `a=ice-pwd:${credential}`,
    `a=fingerprint:sha-256 ${fingerprintToSdp(fingerprint)}`,
    'a=setup:passive',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
    `a=candidate:1 1 UDP 2130706431 ${host} ${port} typ host`,
    'a=end-of-candidates',
    '',
  ].join('\r\n');
}

/** The browser's offer, written by the relay from the credentials in its ICE username. */
export function directBrowserOfferSdp({ ufrag, pwd }) {
  return [
    'v=0',
    'o=- 0 0 IN IP4 0.0.0.0',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=mid:0',
    `a=ice-ufrag:${ufrag}`,
    `a=ice-pwd:${pwd}`,
    // The browser's certificate is not known in advance; the relay does not
    // authenticate browsers (it is started with fingerprint checks off), so
    // this placeholder is never compared.
    `a=fingerprint:sha-256 ${Array(32).fill('00').join(':')}`,
    // The browser is the DTLS client: the answer it wrote says passive.
    'a=setup:active',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
    '',
  ].join('\r\n');
}
