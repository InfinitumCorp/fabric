// FABRIC message encryption: X3DH or hybrid post-quantum session setup + Double Ratchet, after
// the Signal specs (signal.org/docs/specifications/x3dh, /pqxdh and /doubleratchet), on P-256
// with WebCrypto plus ML-KEM-768 (shared/pq.js).
//
//   v2 X3DH   SK = HKDF(F || DH(IKa,SPKb) || DH(EKa,IKb) || DH(EKa,SPKb) [|| DH(EKa,OPKb)])
//   v3 PQXDH  SK = HKDF(F || the same DHs || SS), SS = ML-KEM-768 shared secret encapsulated to
//             Bob's signed post-quantum prekey (PQSPKb). An attacker has to break both P-256 and
//             ML-KEM to learn SK, so recorded traffic stays safe against a future quantum computer.
//             The version is bound into the associated data, so v2 and v3 sessions never mix.
//             Fallback: a peer whose bundle has no PQSPK gets v2. Once a device has used v3 with
//             us, SessionManager refuses v2 with it (a relay stripping PQ keys cannot downgrade).
//   ratchet   KDF_RK = HKDF(salt = RK, ikm = DH out) -> (RK', CK)
//             KDF_CK = HMAC(CK, 0x01) -> message key, HMAC(CK, 0x02) -> next CK
//   message   AES-256-GCM, key and nonce from HKDF(message key); AAD = AD || header || routing
//
// Every message key is used once and then deleted, so a stolen device state cannot read
// earlier messages (forward secrecy). A fresh DH ratchet step on every reply heals the
// session after a compromise (post-compromise security).
//
// All state is plain JSON (base64 bytes + JWKs) so it can be stored and cloned. Functions
// never mutate the state they are given: they return a new one, which callers commit only
// when the operation succeeds.

import {
  b64, unb64, keyId, publicOnly, privateOf, isPublicJwk, ecdh, generateIdentity, signBytes, verifyBytes,
} from './crypto.js';
import { kemKeygen, kemEncapsulate, kemDecapsulate, PUBLIC_KEY_BYTES, CIPHERTEXT_BYTES } from './pq.js';

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const MAX_SKIP = 1000; // most message keys we will derive ahead for one chain
const MAX_STORED_SKIPPED = 2000;

// ---------- primitives ----------
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

async function hkdf(ikm, salt, info, length) {
  const k = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) }, k, length * 8));
}

async function hmac(keyBytes, data) {
  const k = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', k, data));
}

async function kdfRK(rk, dhOut) {
  const out = await hkdf(dhOut, rk, 'FABRIC/v2/ratchet', 64);
  return [out.slice(0, 32), out.slice(32)];
}

async function kdfCK(ck) {
  return [await hmac(ck, Uint8Array.of(2)), await hmac(ck, Uint8Array.of(1))]; // [next chain key, message key]
}

async function messageCipher(mk) {
  const out = await hkdf(mk, new Uint8Array(32), 'FABRIC/v2/message', 44);
  const key = await subtle.importKey('raw', out.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { key, iv: out.slice(32) };
}

/** JSON with sorted keys, so AAD is byte-identical on both ends whatever the transport did. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

const clone = (s) => structuredClone(s);

// ---------- prekeys ----------
const spkMessage = (id, pub) => enc.encode(`FABRIC/v2/spk|${id}|${keyId(pub)}`);

// The post-quantum prekey shares the signed prekey's id and lifetime; its own signature binds it to that id.
const pqMessage = (id, pubB64) => enc.encode(`FABRIC/v3/pqspk|${id}|${pubB64}`);
const isB64Of = (s, bytes) => typeof s === 'string' && s.length === Math.ceil(bytes / 3) * 4 && /^[A-Za-z0-9+/]+={0,2}$/.test(s);

export async function generateSignedPreKey(signingPrivateJwk, id) {
  const kp = await generateIdentity();
  const pqKeys = kemKeygen();
  const pqPub = b64(pqKeys.publicKey);
  return {
    id, createdAt: Date.now(), ...kp,
    sig: await signBytes(signingPrivateJwk, spkMessage(id, kp.publicJwk)),
    pq: { pub: pqPub, secret: b64(pqKeys.secretKey), sig: await signBytes(signingPrivateJwk, pqMessage(id, pqPub)) },
  };
}

/** True if `spk.pq` is a well-formed ML-KEM-768 key signed by this device for this prekey id. */
export function verifyPqPreKey(signingPublicJwk, spk) {
  const pq = spk?.pq;
  if (!pq || !isB64Of(pq.pub, PUBLIC_KEY_BYTES) || typeof pq.sig !== 'string') return Promise.resolve(false);
  return verifyBytes(signingPublicJwk, pq.sig, pqMessage(spk.id, pq.pub));
}

export async function generateOneTimePreKeys(startId, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push({ id: startId + i, ...(await generateIdentity()) });
  return out;
}

export function verifySignedPreKey(signingPublicJwk, spk) {
  if (!spk || !isPublicJwk(spk.pub) || typeof spk.sig !== 'string') return Promise.resolve(false);
  return verifyBytes(signingPublicJwk, spk.sig, spkMessage(spk.id, spk.pub));
}

/** What gets uploaded to the relay: public halves only. */
export function publicPreKeys(spk, opks = []) {
  return {
    spk: { id: spk.id, pub: publicOnly(spk.publicJwk), sig: spk.sig, ...(spk.pq ? { pq: { pub: spk.pq.pub, sig: spk.pq.sig } } : {}) },
    opks: opks.map((k) => ({ id: k.id, pub: publicOnly(k.publicJwk) })),
  };
}

// ---------- X3DH ----------
const F = new Uint8Array(32).fill(0xff);

function associatedData(v, initiator, responder) {
  // binds the protocol version and both identities (and handles) into every message of the session
  return enc.encode(
    `FABRIC/v${v}/AD|${initiator.handle}|${keyId(initiator.id.dh)}|${keyId(initiator.id.sig)}` +
    `|${responder.handle}|${keyId(responder.id.dh)}|${keyId(responder.id.sig)}`,
  );
}

async function setupSecret(dhs, pqSecret) {
  if (!pqSecret) return hkdf(concat(F, ...dhs), new Uint8Array(32), 'FABRIC/v2/X3DH', 32);
  return hkdf(concat(F, ...dhs, pqSecret), new Uint8Array(32), 'FABRIC/v3/PQXDH/P-256/ML-KEM-768', 32);
}

/**
 * Initiator side. `bundle` = { identity: {dh, sig}, spk: {id, pub, sig, pq?: {pub, sig}}, opk?: {id, pub} }
 * from the relay. `myIdentity` = full key pairs { dh: {publicJwk, privateKey | privateJwk}, sig: {...} }.
 * `requirePq`: refuse a bundle without a post-quantum prekey (this device used v3 with us before).
 */
export async function initiateSession({ myHandle, myIdentity, peerHandle, bundle, requirePq = false }) {
  if (!(await verifySignedPreKey(bundle.identity.sig, bundle.spk))) throw new Error('bad signed prekey signature');
  let pq = null;
  if (bundle.spk.pq) {
    // a PQ key that is offered but fails to verify is an attack or a fault, never a reason to fall back
    if (!(await verifyPqPreKey(bundle.identity.sig, bundle.spk))) throw new Error('bad post-quantum prekey signature');
    pq = kemEncapsulate(unb64(bundle.spk.pq.pub));
  } else if (requirePq) {
    throw new Error('this device used post-quantum encryption before; refusing a setup without it');
  }
  const v = pq ? 3 : 2;
  const ek = await generateIdentity();
  const dhs = [
    await ecdh(privateOf(myIdentity.dh), bundle.spk.pub),
    await ecdh(ek.privateJwk, bundle.identity.dh),
    await ecdh(ek.privateJwk, bundle.spk.pub),
  ];
  if (bundle.opk) dhs.push(await ecdh(ek.privateJwk, bundle.opk.pub));
  const sk = await setupSecret(dhs, pq?.sharedSecret);

  const myPub = { dh: publicOnly(myIdentity.dh.publicJwk), sig: publicOnly(myIdentity.sig.publicJwk) };
  const ad = associatedData(v, { handle: myHandle, id: myPub }, { handle: peerHandle, id: bundle.identity });

  // Double Ratchet init (Alice): first sending chain from DH(new ratchet key, Bob's SPK)
  const DHs = await generateIdentity();
  const [rk, cks] = await kdfRK(sk, await ecdh(DHs.privateJwk, bundle.spk.pub));
  // sent with every message until the peer replies, so they can build the session; it is part of
  // each message's AAD, so a changed KEM ciphertext fails to decrypt instead of making a new session
  const pre = { ek: ek.publicJwk, spkId: bundle.spk.id, opkId: bundle.opk ? bundle.opk.id : null };
  if (pq) pre.pq = { ct: b64(pq.cipherText) };
  return {
    v,
    peer: peerHandle,
    peerIdentity: bundle.identity,
    ad: b64(ad),
    RK: b64(rk), CKs: b64(cks), CKr: null,
    DHs, DHr: publicOnly(bundle.spk.pub),
    Ns: 0, Nr: 0, PN: 0,
    skipped: {},
    pre,
    ek: keyId(ek.publicJwk),
    createdAt: Date.now(),
  };
}

/**
 * Responder side, from the `pre` block of an initial message.
 * `prekeys` = { spks: {id: keypair}, opks: {id: keypair} } (private halves, on this device only).
 * Returns the new state and which one-time prekey it consumed; the caller deletes that key
 * only after the first message decrypts.
 */
export async function acceptSession({ myHandle, myIdentity, prekeys, peerHandle, peerIdentity, pre, requirePq = false }) {
  if (!pre || !isPublicJwk(pre.ek)) throw new Error('missing session setup');
  const spk = prekeys.spks[pre.spkId];
  if (!spk) throw new Error('unknown signed prekey');
  let pqSecret = null;
  if (pre.pq != null) {
    if (!isB64Of(pre.pq?.ct, CIPHERTEXT_BYTES)) throw new Error('bad post-quantum ciphertext');
    if (!spk.pq?.secret) throw new Error('no post-quantum prekey for this setup');
    pqSecret = kemDecapsulate(unb64(pre.pq.ct), unb64(spk.pq.secret));
  } else if (requirePq) {
    throw new Error('this device used post-quantum encryption before; refusing a setup without it');
  }
  const v = pqSecret ? 3 : 2;
  let opk = null;
  if (pre.opkId != null) {
    opk = prekeys.opks[pre.opkId];
    if (!opk) throw new Error('one-time prekey already used');
  }
  const dhs = [
    await ecdh(spk.privateJwk, peerIdentity.dh),
    await ecdh(privateOf(myIdentity.dh), pre.ek),
    await ecdh(spk.privateJwk, pre.ek),
  ];
  if (opk) dhs.push(await ecdh(opk.privateJwk, pre.ek));
  const sk = await setupSecret(dhs, pqSecret);

  const myPub = { dh: publicOnly(myIdentity.dh.publicJwk), sig: publicOnly(myIdentity.sig.publicJwk) };
  const ad = associatedData(v, { handle: peerHandle, id: peerIdentity }, { handle: myHandle, id: myPub });

  // Double Ratchet init (Bob): our SPK is the first ratchet key; the receiving chain starts on decrypt
  return {
    state: {
      v,
      peer: peerHandle,
      peerIdentity,
      ad: b64(ad),
      RK: b64(sk), CKs: null, CKr: null,
      DHs: { publicJwk: spk.publicJwk, privateJwk: spk.privateJwk },
      DHr: null,
      Ns: 0, Nr: 0, PN: 0,
      skipped: {},
      pre: null,
      ek: keyId(pre.ek),
      createdAt: Date.now(),
    },
    usedOpkId: opk ? pre.opkId : null,
  };
}

// ---------- Double Ratchet ----------
function messageAad(state, header, routing) {
  return concat(unb64(state.ad), enc.encode(canonical(header)), enc.encode(routing));
}

/** Encrypt. Returns { state, header, ct }; commit `state` only once you hold the result. */
export async function ratchetEncrypt(state, payload, routing) {
  if (!state.CKs) throw new Error('session cannot send yet');
  const s = clone(state);
  const [ck, mk] = await kdfCK(unb64(s.CKs));
  s.CKs = b64(ck);
  const header = { dh: publicOnly(s.DHs.publicJwk), n: s.Ns, pn: s.PN };
  if (s.pre) header.pre = s.pre;
  s.Ns += 1;
  const { key, iv } = await messageCipher(mk);
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: messageAad(s, header, routing) },
    key,
    enc.encode(JSON.stringify(payload)),
  );
  return { state: s, header, ct: b64(ct) };
}

function validHeader(h) {
  return h && isPublicJwk(h.dh) && Number.isInteger(h.n) && h.n >= 0 && Number.isInteger(h.pn) && h.pn >= 0;
}

async function skipKeys(s, until) {
  if (!s.CKr) return;
  if (until - s.Nr > MAX_SKIP) throw new Error('too many skipped messages');
  let ck = unb64(s.CKr);
  while (s.Nr < until) {
    const [next, mk] = await kdfCK(ck);
    s.skipped[`${keyId(s.DHr)}:${s.Nr}`] = b64(mk);
    ck = next;
    s.Nr += 1;
  }
  s.CKr = b64(ck);
  const keys = Object.keys(s.skipped);
  for (let i = 0; i < keys.length - MAX_STORED_SKIPPED; i++) delete s.skipped[keys[i]]; // oldest first
}

async function dhRatchet(s, header) {
  s.PN = s.Ns;
  s.Ns = 0;
  s.Nr = 0;
  s.DHr = publicOnly(header.dh);
  let [rk, ck] = await kdfRK(unb64(s.RK), await ecdh(s.DHs.privateJwk, s.DHr));
  s.CKr = b64(ck);
  s.DHs = await generateIdentity();
  [rk, ck] = await kdfRK(rk, await ecdh(s.DHs.privateJwk, s.DHr));
  s.RK = b64(rk);
  s.CKs = b64(ck);
}

async function decryptWith(mk, s, header, ct, routing) {
  const { key, iv } = await messageCipher(mk);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: messageAad(s, header, routing) }, key, unb64(ct));
  return JSON.parse(dec.decode(pt));
}

/** Decrypt. Returns { state, payload }; throws (and the caller keeps the old state) on any failure. */
export async function ratchetDecrypt(state, header, ct, routing) {
  if (!validHeader(header)) throw new Error('bad header');
  const s = clone(state);
  const skippedId = `${keyId(header.dh)}:${header.n}`;
  let payload;
  if (s.skipped[skippedId]) {
    const mk = unb64(s.skipped[skippedId]);
    delete s.skipped[skippedId];
    payload = await decryptWith(mk, s, header, ct, routing);
  } else {
    if (!s.DHr || keyId(header.dh) !== keyId(s.DHr)) {
      await skipKeys(s, header.pn);
      await dhRatchet(s, header);
    }
    await skipKeys(s, header.n);
    const [ck, mk] = await kdfCK(unb64(s.CKr));
    s.CKr = b64(ck);
    s.Nr += 1;
    payload = await decryptWith(mk, s, header, ct, routing);
  }
  s.pre = null; // the peer has answered on this session: stop sending setup info
  return { state: s, payload };
}
