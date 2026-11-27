// Proof of work for a new address (sybil resistance without asking for anything personal).
// The relay sends each connection a random nonce and how many leading zero bits it wants
// (`powBits` in `hello`). To register an address that does not exist yet, the client finds a
// counter so that SHA-256("fabric-pow|<nonce>|<handle>|<counter>") starts with that many zero
// bits. At 16 bits that is about 65,000 hashes on average: around a second on a phone, once per
// address, while a million addresses cost a million times that. Signing in to an address that
// already exists, or one backed by a Cumulus://ID, needs no work.
// Uses Web Crypto only, so it runs the same in the page, in workers and in node.

export const POW_MAX_BITS = 28;
const enc = new TextEncoder();

const input = (nonce, handle, counter) => enc.encode(`fabric-pow|${nonce}|${handle}|${counter}`);

/** Leading zero bits of a byte array. */
export function leadingZeroBits(bytes) {
  let n = 0;
  for (const b of bytes) {
    if (b === 0) { n += 8; continue; }
    return n + Math.clz32(b) - 24;
  }
  return n;
}

async function bitsOf(nonce, handle, counter) {
  return leadingZeroBits(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', input(nonce, handle, counter))));
}

/** Does `counter` (a decimal string) do the work for this nonce and handle? */
export async function checkPow({ nonce, handle, counter, bits }) {
  if (!bits) return true;
  if (typeof counter !== 'string' || !/^\d{1,16}$/.test(counter)) return false;
  return (await bitsOf(nonce, handle, counter)) >= bits;
}

/**
 * Finds a counter (decimal string). Hashes in batches so Web Crypto can run them side by side;
 * `signal` (an AbortSignal) stops it.
 */
export async function solvePow({ nonce, handle, bits, batch = 512, signal = null }) {
  if (!bits) return '0';
  if (!Number.isInteger(bits) || bits < 0 || bits > POW_MAX_BITS) throw new Error('bad proof-of-work size');
  for (let start = 0; ; start += batch) {
    if (signal?.aborted) throw new Error('stopped');
    const tries = Array.from({ length: batch }, (_, i) => String(start + i));
    const got = await Promise.all(tries.map((c) => bitsOf(nonce, handle, c)));
    const i = got.findIndex((z) => z >= bits);
    if (i >= 0) return tries[i];
  }
}
