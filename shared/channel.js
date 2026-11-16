// Small authenticated-encryption helpers shared by device linking and backups.

import { b64, unb64, keyId, ecdh } from './crypto.js';

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

async function hkdfKey(ikm, salt, info) {
  const k = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(salt), info: enc.encode(info) },
    k, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

export async function sealJson(key, label, obj) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(label) }, key, enc.encode(JSON.stringify(obj)));
  return { iv: b64(iv), ct: b64(ct) };
}

export async function openJson(key, label, box) {
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv), additionalData: enc.encode(label) }, key, unb64(box.ct));
  return JSON.parse(dec.decode(pt));
}

/** Link channel key: ECDH of the two ephemeral keys, bound to both public keys. */
export async function linkChannelKey(myPrivateJwk, myPub, theirPub) {
  const info = [keyId(myPub), keyId(theirPub)].sort().join('|');
  return hkdfKey(await ecdh(myPrivateJwk, theirPub), 'FABRIC/v3/link', info);
}

// ---------- backups ----------
// A recovery key is 160 random bits shown as 32 Crockford base32 characters in groups of four.
// That much entropy needs no slow KDF: guessing it is out of reach.

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function newRecoveryKey() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(20));
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  let s = '';
  for (let i = 0; i < 160; i += 5) s += B32[parseInt(bits.slice(i, i + 5), 2)];
  return s.match(/.{4}/g).join('-');
}

export function parseRecoveryKey(text) {
  const s = String(text).toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (!/^[0-9A-HJKMNP-TV-Z]{32}$/.test(s)) throw new Error('A recovery key is 32 letters and digits.');
  let bits = '';
  for (const c of s) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return out;
}

const BACKUP_LABEL = 'FABRIC/v3/backup';

export async function sealBackup(recoveryKeyText, content) {
  const salt = b64(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const key = await hkdfKey(parseRecoveryKey(recoveryKeyText), salt, BACKUP_LABEL);
  return { format: 'fabric-backup', v: 3, createdAt: new Date().toISOString(), handle: content.handle, salt, box: await sealJson(key, BACKUP_LABEL, content) };
}

export async function openBackup(recoveryKeyText, file) {
  if (file?.format !== 'fabric-backup' || file.v !== 3) throw new Error('That is not a FABRIC backup file.');
  const key = await hkdfKey(parseRecoveryKey(recoveryKeyText), file.salt, BACKUP_LABEL);
  try {
    return await openJson(key, BACKUP_LABEL, file.box);
  } catch {
    throw new Error('Wrong recovery key, or the backup file is damaged.');
  }
}
