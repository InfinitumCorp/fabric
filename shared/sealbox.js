// Seal a phone record to every device of an account.
//
// The relay builds the event (a call, a text, a voicemail), then forgets it. What it stores is a
// box: the content under a fresh AES-256-GCM key, and that key wrapped for each device with
// ECDH (an ephemeral key × the device's DH key from its signed device list) and HKDF. The box is
// bound to its row with the AAD `phone|<handle>|<seq>` (voicemail audio uses `phone-audio|…`).
// A device linked later has no wrap, so it cannot open older rows; it gets that history from
// another device, the same way chats work. The relay keeps the time, the account, and — for a
// burner line — the `via` number, because burning that line has to delete its rows.

import { b64, unb64, ecdh, generateIdentity, isPublicJwk, publicOnly } from './crypto.js';
import { DEVICE_ID_RE } from './devices.js';

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();
const LABEL = 'FABRIC/v1/phone';

async function aesFromRaw(raw) {
  return subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function wrapKey(shared, info) {
  const k = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(LABEL), info: enc.encode(info) },
    k, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

/** A box this module produced. The relay can check the shape; it cannot open it. */
export function isPhoneBox(box) {
  return Boolean(
    box && box.v === 1 && isPublicJwk(box.ek)
    && typeof box.iv === 'string' && typeof box.ct === 'string'
    && Array.isArray(box.wraps) && box.wraps.length > 0
    && box.wraps.every((w) => w && DEVICE_ID_RE.test(String(w.id || '')) && typeof w.iv === 'string' && typeof w.ct === 'string'),
  );
}

/**
 * Seal `payload` (JSON) to each `{ id, dh }` device. `aad` defaults to the phone-row binding.
 * The content key is not returned.
 */
export async function sealToDevices({ payload, handle, seq, devices, aad = null }) {
  const list = [];
  const seen = new Set();
  for (const d of devices || []) {
    if (!d || seen.has(d.id) || !DEVICE_ID_RE.test(String(d.id || '')) || !isPublicJwk(d.dh)) continue;
    seen.add(d.id);
    list.push(d);
  }
  if (!list.length) throw new Error('no device keys to seal to');
  const eph = await generateIdentity();
  const content = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const binding = aad || `phone|${handle}|${seq}`;
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(binding) },
    await aesFromRaw(content),
    enc.encode(JSON.stringify(payload)),
  ));
  const wraps = [];
  for (const d of list) {
    const key = await wrapKey(await ecdh(eph.privateJwk, d.dh), `wrap|${handle}|${seq}|${d.id}`);
    const wiv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const wct = new Uint8Array(await subtle.encrypt(
      { name: 'AES-GCM', iv: wiv, additionalData: enc.encode(`phone-wrap|${handle}|${seq}|${d.id}`) },
      key,
      content,
    ));
    wraps.push({ id: d.id, iv: b64(wiv), ct: b64(wct) });
  }
  return { v: 1, ek: publicOnly(eph.publicJwk), iv: b64(iv), ct: b64(ct), wraps };
}

/**
 * Open a box on the device it was sealed for. `privateKey` is that device's DH private key
 * (a JWK or a non-extractable CryptoKey). Fails for any other device, handle, seq or AAD.
 */
export async function openSeal({ box, handle, seq, deviceId, privateKey, aad = null }) {
  if (!isPhoneBox(box)) throw new Error('not a sealed phone record');
  const wrap = box.wraps.find((w) => w.id === deviceId);
  if (!wrap) throw new Error('not sealed for this device');
  const key = await wrapKey(await ecdh(privateKey, box.ek), `wrap|${handle}|${seq}|${deviceId}`);
  const content = new Uint8Array(await subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(wrap.iv), additionalData: enc.encode(`phone-wrap|${handle}|${seq}|${deviceId}`) },
    key,
    unb64(wrap.ct),
  ));
  const binding = aad || `phone|${handle}|${seq}`;
  const plain = await subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(box.iv), additionalData: enc.encode(binding) },
    await aesFromRaw(content),
    unb64(box.ct),
  );
  return JSON.parse(dec.decode(plain));
}
