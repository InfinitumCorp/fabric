// Media frame encryption (SFrame-style) for calls, on top of WebRTC's DTLS-SRTP.
//
// Each encoded audio/video frame is AES-256-GCM encrypted with the sender's current media key.
// The first few bytes stay in the clear (and are authenticated as AAD) so the RTP packetizer
// and depacketizer can still parse the codec header: 10 bytes for a VP8 key frame, 3 for a VP8
// delta frame, 1 for Opus (the TOC byte). Calls with frame encryption force VP8 for this reason.
//
//   frame' = clearHeader ‖ AES-GCM(key, iv, rest, aad = clearHeader ‖ kid) ‖ iv ‖ kid
//
// kid is a one-byte key id, so a receiver knows which of the sender's keys to use while the
// sender rotates. The IV is random per frame, and keys rotate on every join and leave and every
// ten minutes, so each key stays far below the random-IV limit.

const subtle = globalThis.crypto.subtle;

export const IV_BYTES = 12;
export const TAG_BYTES = 16;
export const KID_BYTES = 1;
export const OVERHEAD = IV_BYTES + TAG_BYTES + KID_BYTES;

export function clearBytesFor(kind, frameType) {
  if (kind === 'audio') return 1;
  return frameType === 'key' ? 10 : 3;
}

export function importMediaKey(raw) {
  return subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function aad(header, kid) {
  const a = new Uint8Array(header.length + 1);
  a.set(header);
  a[header.length] = kid;
  return a;
}

export async function encryptFrame(key, data, clear, kid = 0) {
  const src = new Uint8Array(data);
  const n = Math.min(clear, src.length);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(src.subarray(0, n), kid) }, key, src.subarray(n),
  ));
  const out = new Uint8Array(n + ct.length + IV_BYTES + KID_BYTES);
  out.set(src.subarray(0, n));
  out.set(ct, n);
  out.set(iv, n + ct.length);
  out[out.length - 1] = kid;
  return out.buffer;
}

/** The key id a sealed frame was made with. */
export function frameKid(data) {
  const src = new Uint8Array(data);
  if (src.length < OVERHEAD) throw new Error('frame too short');
  return src[src.length - 1];
}

/**
 * @param {CryptoKey | ((kid: number) => CryptoKey | undefined)} keyOrLookup
 */
export async function decryptFrame(keyOrLookup, data, clear) {
  const src = new Uint8Array(data);
  if (src.length < OVERHEAD) throw new Error('frame too short');
  const kid = src[src.length - 1];
  const key = typeof keyOrLookup === 'function' ? keyOrLookup(kid) : keyOrLookup;
  if (!key) throw new Error('unknown key id');
  const n = Math.min(clear, src.length - OVERHEAD); // frames shorter than the header were sent all-clear
  const ivAt = src.length - KID_BYTES - IV_BYTES;
  const pt = new Uint8Array(await subtle.decrypt(
    { name: 'AES-GCM', iv: src.subarray(ivAt, ivAt + IV_BYTES), additionalData: aad(src.subarray(0, n), kid) },
    key, src.subarray(n, ivAt),
  ));
  const out = new Uint8Array(n + pt.length);
  out.set(src.subarray(0, n));
  out.set(pt, n);
  return out.buffer;
}
