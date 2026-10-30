// The direct listener's DTLS certificate: self-signed ECDSA P-256, made once
// with Node's own crypto and kept beside the relay's data, so its fingerprint
// (which the relay publishes in its signed directory record) stays the same
// across restarts. WebRTC checks the certificate only against that
// fingerprint, never against a certificate authority, so self-signed is all it
// needs.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';

function derLength(n) {
  if (n < 0x80) return [n];
  if (n < 0x100) return [0x81, n];
  return [0x82, n >> 8, n & 0xff];
}

function tlv(tag, ...parts) {
  const body = Buffer.concat(parts.map((part) => Buffer.from(part)));
  return Buffer.concat([Buffer.from([tag, ...derLength(body.length)]), body]);
}

const seq = (...parts) => tlv(0x30, ...parts);
const OID_ECDSA_SHA256 = Buffer.from([0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]);
const OID_COMMON_NAME = Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03]);

function derTime(date) {
  const year = date.getUTCFullYear();
  const pad = (n) => String(n).padStart(2, '0');
  const rest = `${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return year < 2050
    ? tlv(0x17, Buffer.from(`${String(year).slice(2)}${rest}`, 'ascii'))
    : tlv(0x18, Buffer.from(`${year}${rest}`, 'ascii'));
}

function name(commonName) {
  return seq(tlv(0x31, seq(OID_COMMON_NAME, tlv(0x0c, Buffer.from(commonName, 'utf8')))));
}

/** A new self-signed P-256 certificate: { certPem, keyPem, fingerprint (hex) }. */
export function createDirectCertificate({ commonName = 'freertc-relay', days = 3650, now = new Date() } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const serial = randomBytes(16);
  serial[0] &= 0x7f; // a positive INTEGER
  const notBefore = new Date(now.getTime() - 24 * 60 * 60_000);
  const notAfter = new Date(now.getTime() + days * 24 * 60 * 60_000);
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([0x02]))), // version 3
    tlv(0x02, serial),
    seq(OID_ECDSA_SHA256),
    name(commonName),
    seq(derTime(notBefore), derTime(notAfter)),
    name(commonName),
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = sign('sha256', tbs, privateKey);
  const der = seq(tbs, seq(OID_ECDSA_SHA256), tlv(0x03, Buffer.from([0x00]), signature));
  const certPem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  return { certPem, keyPem, fingerprint: createHash('sha256').update(der).digest('hex') };
}

/** SHA-256 fingerprint (hex) of a PEM certificate. */
export function certificateFingerprint(certPem) {
  return new X509Certificate(certPem).fingerprint256.replace(/:/g, '').toLowerCase();
}

/**
 * Load the certificate kept in `dir`, or make and keep one. Returns
 * { certFile, keyFile, fingerprint }. A certificate within 30 days of expiry,
 * or one that does not match its key, is replaced.
 */
export function loadOrCreateDirectCertificate(dir, { now = new Date() } = {}) {
  mkdirSync(dir, { recursive: true });
  const certFile = path.join(dir, 'direct-cert.pem');
  const keyFile = path.join(dir, 'direct-key.pem');
  if (existsSync(certFile) && existsSync(keyFile)) {
    try {
      const certPem = readFileSync(certFile, 'utf8');
      const cert = new X509Certificate(certPem);
      const key = createPrivateKey(readFileSync(keyFile, 'utf8'));
      const fresh = new Date(cert.validTo).getTime() - now.getTime() > 30 * 24 * 60 * 60_000;
      if (fresh && cert.checkPrivateKey(key) && createPublicKey(key).asymmetricKeyDetails?.namedCurve === 'prime256v1') {
        return { certFile, keyFile, fingerprint: certificateFingerprint(certPem) };
      }
    } catch {
      // unreadable or mismatched: make a new one below
    }
  }
  const { certPem, keyPem, fingerprint } = createDirectCertificate({ now });
  writeFileSync(keyFile, keyPem, { mode: 0o600 });
  try { chmodSync(keyFile, 0o600); } catch {}
  writeFileSync(certFile, certPem);
  return { certFile, keyFile, fingerprint };
}
