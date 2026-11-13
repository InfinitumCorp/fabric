// FABRIC crypto primitives shared by the browser and Node (WebCrypto only).
// Message encryption lives in ratchet.js (X3DH + Double Ratchet); this file holds identities,
// encoding helpers, relay ownership proofs and safety numbers.

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();

export const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
export const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };

export const HANDLE_RE = /^@[a-z0-9_]{2,24}\.veil$/;

export function normalizeHandle(input) {
  let h = String(input || '').trim().toLowerCase();
  h = h.replace(/^[+@]/, ''); // people type +name (how the app shows handles); accounts are @name underneath
  h = '@' + h;
  if (!h.endsWith('.veil')) h = h + '.veil';
  return h;
}

export function isValidHandle(h) {
  return HANDLE_RE.test(h);
}

export function b64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s);
}

export function unb64(str) {
  const s = atob(str);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

export function publicOnly(jwk) {
  const { kty, crv, x, y } = jwk;
  return { kty, crv, x, y };
}

/** Stable text id for a public key. */
export const keyId = (jwk) => `${jwk.x}.${jwk.y}`;

export function isPublicJwk(jwk) {
  return Boolean(jwk && jwk.kty === 'EC' && jwk.crv === 'P-256' && typeof jwk.x === 'string' && typeof jwk.y === 'string');
}

/** A fresh ECDH P-256 key pair as JWKs. */
export async function generateIdentity() {
  const kp = await subtle.generateKey(ECDH, true, ['deriveBits']);
  return {
    publicJwk: publicOnly(await subtle.exportKey('jwk', kp.publicKey)),
    privateJwk: await subtle.exportKey('jwk', kp.privateKey),
  };
}

/** A fresh ECDSA P-256 key pair as JWKs (signs prekeys). */
export async function generateSigningKey() {
  const kp = await subtle.generateKey(ECDSA, true, ['sign', 'verify']);
  return {
    publicJwk: publicOnly(await subtle.exportKey('jwk', kp.publicKey)),
    privateJwk: await subtle.exportKey('jwk', kp.privateKey),
  };
}

/** A user's long-term identity: a DH key (X3DH, relay proofs) and a signing key (prekeys). */
export async function generateUserIdentity() {
  return { dh: await generateIdentity(), sig: await generateSigningKey() };
}

/** Public half of a user identity, as published in the directory. */
export function publicIdentity(identity) {
  return { dh: publicOnly(identity.dh.publicJwk), sig: publicOnly(identity.sig.publicJwk) };
}

export const sameIdentity = (a, b) =>
  Boolean(a && b && keyId(a.dh) === keyId(b.dh) && keyId(a.sig) === keyId(b.sig));

/** A private key given as a CryptoKey (e.g. non-extractable, from the vault) or as a JWK. */
const isCryptoKey = (k) => typeof globalThis.CryptoKey === 'function' && k instanceof globalThis.CryptoKey;

/** The private half of a key pair: long-term identity keys carry `privateKey` (a CryptoKey), others `privateJwk`. */
export const privateOf = (kp) => kp.privateKey ?? kp.privateJwk;

export async function ecdh(privateKey, publicJwk) {
  const priv = isCryptoKey(privateKey) ? privateKey : await subtle.importKey('jwk', privateKey, ECDH, false, ['deriveBits']);
  const pub = await subtle.importKey('jwk', publicOnly(publicJwk), ECDH, true, []);
  return new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256));
}

export async function signBytes(privateKey, bytes) {
  const k = isCryptoKey(privateKey) ? privateKey : await subtle.importKey('jwk', privateKey, ECDSA, false, ['sign']);
  return b64(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k, bytes));
}

export async function verifyBytes(publicJwk, sigB64, bytes) {
  try {
    const k = await subtle.importKey('jwk', publicOnly(publicJwk), ECDSA, false, ['verify']);
    return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, unb64(sigB64), bytes);
  } catch {
    return false;
  }
}

export function newMessageId() {
  return b64(globalThis.crypto.getRandomValues(new Uint8Array(12)))
    .replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]);
}

/**
 * Proof that the client holds the private key behind its published identity:
 * HMAC-SHA256(key = ECDH(client, relay), nonce). The relay checks it with ECDH(relay, client).
 * Stops anyone from registering (and draining the offline queue of) a handle they do not own.
 */
export async function ownershipProof(myPrivateJwk, peerPublicJwk, nonceB64) {
  const shared = await ecdh(myPrivateJwk, peerPublicJwk);
  const hmacKey = await subtle.importKey('raw', shared, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await subtle.sign('HMAC', hmacKey, enc.encode('FABRIC/v1/register|' + nonceB64));
  return b64(sig);
}

export function timingSafeEqualB64(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Safety number: both parties compute the same 60 digits from both public identities
 * ({dh, sig}). If the relay ever swapped a key, the numbers on the two devices would differ.
 */
/** Safety number over both accounts' signing keys (v3: device changes do not alter it). */
export async function safetyNumber(handleA, accountA, handleB, accountB) {
  const parts = [
    `${handleA}:${keyId(accountA)}`,
    `${handleB}:${keyId(accountB)}`,
  ].sort();
  const first = new Uint8Array(await subtle.digest('SHA-256', enc.encode(parts.join('||'))));
  const second = new Uint8Array(await subtle.digest('SHA-256', first));
  const bytes = new Uint8Array([...first, ...second]);
  const groups = [];
  for (let i = 0; i < 12; i++) {
    let n = 0;
    for (let j = 0; j < 5; j++) n = (n * 256 + bytes[i * 5 + j]) % 100000;
    groups.push(String(n).padStart(5, '0'));
  }
  return groups.join(' ');
}
