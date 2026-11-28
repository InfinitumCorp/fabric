// Sealed sender: the relay delivers an envelope without learning who sent it.
//
// The ratchet envelope (which names the sender) goes inside two layers:
//   outer: AES-GCM under ECDH(ephemeral, recipient device DH key). Anyone can make one; it hides
//          the sender from the relay and carries { from, fromDevice, box }.
//   box:   AES-GCM under ECDH(sender device DH key, recipient device DH key), bound to the
//          ephemeral key. Only the device named in the outer layer can make it, so a stranger
//          can't put a message under someone else's name (not even one that fails to decrypt).
// The ratchet inside then authenticates the message itself, as for any envelope.
//
// Plaintext is padded to a few fixed sizes so the length says little about what is inside.
// Abuse control is separate: each account has a delivery key that only its contacts learn
// (inside ratchet messages). The relay accepts a sealed envelope only with the recipient's key.

import { b64, unb64, keyId, ecdh, generateIdentity, isPublicJwk, publicOnly, isValidHandle } from './crypto.js';
import { deviceAddr, parseAddr, DEVICE_ID_RE } from './devices.js';

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();
const LABEL = 'FABRIC/v1/sealed';

export const DELIVERY_KEY_RE = /^[A-Za-z0-9_-]{22}$/;

/** 128 random bits, base64url without padding. */
export function newDeliveryKey() {
  return b64(globalThis.crypto.getRandomValues(new Uint8Array(16))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]);
}

export const isDeliveryKey = (k) => typeof k === 'string' && DELIVERY_KEY_RE.test(k);

/** Padded size: 1, 2, 4, 8 or 16 KiB, then whole 16 KiB blocks. Most texts fit the first. */
export function paddedLength(n) {
  if (n <= 16384) {
    let s = 1024;
    while (s < n) s *= 2;
    return s;
  }
  return Math.ceil(n / 16384) * 16384;
}

function pad(bytes) {
  const out = new Uint8Array(paddedLength(bytes.length + 1));
  out.set(bytes);
  out[bytes.length] = 0x80; // ISO/IEC 7816-4: a marker byte, then zeros
  return out;
}

function unpad(bytes) {
  let i = bytes.length - 1;
  while (i >= 0 && bytes[i] === 0) i--;
  if (i < 0 || bytes[i] !== 0x80) throw new Error('bad padding');
  return bytes.subarray(0, i);
}

async function aesKey(shared, info) {
  const k = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(LABEL), info: enc.encode(info) },
    k, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

async function boxUp(key, aad, bytes) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, bytes);
  return { iv: b64(iv), ct: b64(ct) };
}

async function unbox(key, aad, box) {
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv), additionalData: enc.encode(aad) }, key, unb64(box.ct)));
}

const outerInfo = (to, ek, rk) => `outer|${to}|${keyId(ek)}|${keyId(rk)}`;
const innerInfo = (from, to, ek) => `inner|${from}|${to}|${keyId(ek)}`;

/**
 * Seal a ratchet envelope for one device.
 * @param {object} o
 * @param {object} o.envelope       the ratchet envelope ({ id, from, fromDevice, to, toDevice, ts, header, ct })
 * @param {object} o.recipientDh    the recipient device's public DH key (from its signed device list)
 * @param {CryptoKey|object} o.senderDh  this device's private DH key
 */
export async function seal({ envelope, recipientDh, senderDh }) {
  const from = deviceAddr(envelope.from, envelope.fromDevice);
  const to = deviceAddr(envelope.to, envelope.toDevice);
  const eph = await generateIdentity();
  const ek = eph.publicJwk;
  const { header, ct, id, ts } = envelope;
  const inner = enc.encode(JSON.stringify({ id, ts, header, ct }));
  const box = await boxUp(await aesKey(await ecdh(senderDh, recipientDh), innerInfo(from, to, ek)), LABEL, inner);
  const outer = enc.encode(JSON.stringify({ from: envelope.from, fromDevice: envelope.fromDevice, box }));
  const sealed = await boxUp(await aesKey(await ecdh(eph.privateJwk, recipientDh), outerInfo(to, ek, recipientDh)), LABEL, pad(outer));
  return { v: 1, ek, ...sealed };
}

/** Shape check the relay runs (it can't open the envelope). */
export function isSealed(s) {
  return Boolean(s && s.v === 1 && isPublicJwk(s.ek) && typeof s.iv === 'string' && s.iv.length === 16 && typeof s.ct === 'string');
}

/**
 * First step on the receiving device: who does this claim to be from?
 * Nothing here is trusted yet; openSealed checks it against the sender's device key.
 */
export async function peekSealed({ sealed, me, myDh, myDhPub }) {
  if (!isSealed(sealed)) throw new Error('not a sealed envelope');
  const to = typeof me === 'string' ? me : deviceAddr(me.handle, me.deviceId);
  const key = await aesKey(await ecdh(myDh, sealed.ek), outerInfo(to, publicOnly(sealed.ek), myDhPub));
  const outer = JSON.parse(dec.decode(unpad(await unbox(key, LABEL, sealed))));
  if (!isValidHandle(outer.from) || !DEVICE_ID_RE.test(String(outer.fromDevice)) || !outer.box) throw new Error('bad sealed envelope');
  return { from: outer.from, fromDevice: outer.fromDevice, box: outer.box, ek: publicOnly(sealed.ek), to };
}

/**
 * Second step: open the inner box with the claimed sender's DH key (from its account's signed
 * device list). Fails unless that device made it. Returns the ratchet envelope.
 */
export async function openSealed(peeked, { myDh, senderDh }) {
  const from = deviceAddr(peeked.from, peeked.fromDevice);
  const key = await aesKey(await ecdh(myDh, senderDh), innerInfo(from, peeked.to, peeked.ek));
  const inner = JSON.parse(dec.decode(await unbox(key, LABEL, peeked.box)));
  const { handle: to, deviceId: toDevice } = parseAddr(peeked.to);
  return { id: inner.id, ts: inner.ts, header: inner.header, ct: inner.ct, from: peeked.from, fromDevice: peeked.fromDevice, to, toDevice, sealed: true };
}
