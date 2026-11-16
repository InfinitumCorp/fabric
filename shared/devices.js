// FABRIC v3 accounts and devices.
//
//   account key   ECDSA P-256, held only by the primary device (and in encrypted backups).
//                 Contacts pin it; safety numbers are computed over it, so adding a device
//                 does not change them.
//   device        its own DH + signing identity, prekeys and ratchet sessions.
//   device list   { handle, version, account, devices[] } signed by the account key. The relay
//                 enforces it (and that versions only go up), but peers verify it themselves:
//                 a relay that adds a device to someone's list cannot sign it.

import { b64, unb64, keyId, publicOnly, isPublicJwk, signBytes, verifyBytes } from './crypto.js';
import { canonical } from './ratchet.js';

const enc = new TextEncoder();

export const MAX_DEVICES = 6;
export const DEVICE_ID_RE = /^[0-9a-f]{16}$/;

export const deviceAddr = (handle, deviceId) => `${handle}#${deviceId}`;
export function parseAddr(addr) {
  const i = addr.lastIndexOf('#');
  return { handle: addr.slice(0, i), deviceId: addr.slice(i + 1) };
}

export function newDeviceId() {
  return [...globalThis.crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const listMessage = (payload) => enc.encode('FABRIC/v3/devices|' + canonical(payload));

function normalize(payload) {
  return {
    v: 3,
    handle: payload.handle,
    version: payload.version,
    account: publicOnly(payload.account),
    devices: [...payload.devices]
      .map((d) => ({ id: d.id, name: String(d.name || 'Device').slice(0, 40), dh: publicOnly(d.dh), sig: publicOnly(d.sig), addedAt: Number(d.addedAt) || 0 }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export async function signDeviceList(accountPrivateKey, payload) {
  const p = normalize(payload);
  return { payload: p, sig: await signBytes(accountPrivateKey, listMessage(p)) };
}

/**
 * Check a signed device list. `account` is the pinned account key (or null on first contact,
 * in which case the list's own key is taken, trust on first use). Returns the payload.
 */
export async function verifyDeviceList(list, { handle, account = null, minVersion = 0 } = {}) {
  const p = list?.payload;
  if (!p || p.v !== 3 || p.handle !== handle) throw new Error('device list is for another account');
  if (!isPublicJwk(p.account)) throw new Error('device list has no account key');
  if (account && keyId(account) !== keyId(p.account)) throw new Error('account key changed');
  if (!Number.isInteger(p.version) || p.version < minVersion) throw new Error('device list rolled back');
  if (!Array.isArray(p.devices) || p.devices.length < 1 || p.devices.length > MAX_DEVICES) throw new Error('bad device count');
  const ids = new Set();
  for (const d of p.devices) {
    if (!DEVICE_ID_RE.test(d.id) || ids.has(d.id) || !isPublicJwk(d.dh) || !isPublicJwk(d.sig)) throw new Error('bad device entry');
    ids.add(d.id);
  }
  if (canonical(normalize(p)) !== canonical(p)) throw new Error('device list not canonical');
  if (!(await verifyBytes(p.account, list.sig, listMessage(p)))) throw new Error('bad device list signature');
  return p;
}

export const findDevice = (payload, id) => payload.devices.find((d) => d.id === id) || null;

/** The next list version with devices added and/or removed (unsigned). */
export function nextDeviceList(payload, { add = [], remove = [] } = {}) {
  const devices = payload.devices.filter((d) => !remove.includes(d.id));
  for (const d of add) if (!devices.some((x) => x.id === d.id)) devices.push(d);
  return { ...payload, version: payload.version + 1, devices };
}

// ---------- device linking (provisioning) ----------
// The new device shows a link code: its relay mailbox id plus an ephemeral public key. The user
// carries it to the primary device by hand, so the relay never gets to substitute that key.

export function encodeLinkCode(mailbox, ephemeralPub) {
  return `FAB1.${mailbox}.${ephemeralPub.x}.${ephemeralPub.y}`;
}

export function decodeLinkCode(code) {
  const parts = String(code).trim().split('.');
  if (parts.length !== 4 || parts[0] !== 'FAB1') throw new Error('That is not a FABRIC link code.');
  const [, mailbox, x, y] = parts;
  const pub = { kty: 'EC', crv: 'P-256', x, y };
  const coord = /^[A-Za-z0-9_-]{43}$/; // a P-256 coordinate is 32 bytes = 43 base64url chars
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(mailbox) || !coord.test(x) || !coord.test(y) || !isPublicJwk(pub)) throw new Error('That link code is damaged.');
  return { mailbox, pub };
}

/**
 * Six-digit confirmation number both devices show before a link completes.
 *
 * It covers both ephemeral keys, the account being joined and a nonce the new device sends only
 * inside the encrypted channel, after the primary's key is fixed. So whoever sits in the middle
 * (a relay that swapped the primary's key, or someone who swapped the code itself) has already
 * committed to their keys when the nonce appears, and matches the number by luck at best:
 * one chance in a million.
 */
export async function linkConfirmCode({ deviceEph, primaryEph, account, handle, nonce }) {
  const text = ['FABRIC/v4/link-confirm', keyId(deviceEph), keyId(primaryEph), keyId(account), handle, nonce].join('|');
  const h = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  const n = (((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0) % 1_000_000;
  const s = String(n).padStart(6, '0');
  return `${s.slice(0, 3)} ${s.slice(3)}`;
}

export const newLinkNonce = () => b64(globalThis.crypto.getRandomValues(new Uint8Array(16)));
export const LINK_NONCE_RE = /^[A-Za-z0-9+/]{22}==$/;

export { b64, unb64 };
