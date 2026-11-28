// Emergency burn code: burn every burner number of an account from any browser, after the phone
// that holds them is lost or taken.
//
// The primary device makes a code (160 random bits, written like a recovery key) and shows it once.
// The relay keeps only a hash of it, and only accepts that hash in a message signed by the account
// key, so a linked device (or anyone who takes over a session) can't swap in a code of their own.
// Whoever types the handle and the code on /burn.html burns all of the account's burner numbers
// at once. The code then stops working: a leaked code can't keep burning numbers made later.

import { b64, signBytes, verifyBytes } from './crypto.js';
import { newRecoveryKey, parseRecoveryKey } from './channel.js';

const enc = new TextEncoder();
export const BURN_CODE_MAX_SKEW_MS = 10 * 60 * 1000;
export const BURN_CODE_HASH_RE = /^[A-Za-z0-9+/]{43}=$/;

export const newBurnCode = () => newRecoveryKey();

/** What the relay stores and compares: SHA-256 over a label and the code's 20 bytes. */
export async function burnCodeHash(codeText) {
  const raw = parseRecoveryKey(codeText);
  const label = enc.encode('FABRIC/burn-all/v1|');
  const bytes = new Uint8Array(label.length + raw.length);
  bytes.set(label); bytes.set(raw, label.length);
  return b64(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)));
}

/** `hash` is '' to turn the code off. `at` (ms) must only go up, so an old message can't be replayed. */
const message = ({ handle, hash, at }) => enc.encode(`fabric-burn-code|v1|${handle}|${hash}|${at}`);

export async function signBurnCode(accountPrivateKey, { handle, hash, at = Date.now() }) {
  return { handle, hash, at, sig: await signBytes(accountPrivateKey, message({ handle, hash, at })) };
}

/** Relay side. Returns null if fine, or the reason it is refused. */
export async function checkBurnCode(accountPublicJwk, msg, { handle, lastAt = 0, now = Date.now() }) {
  const { hash, at, sig } = msg || {};
  if (hash !== '' && !BURN_CODE_HASH_RE.test(String(hash))) return 'bad code';
  if (!Number.isSafeInteger(at) || Math.abs(now - at) > BURN_CODE_MAX_SKEW_MS) return 'clock off: check the time on this device';
  if (at <= lastAt) return 'replayed';
  if (typeof sig !== 'string' || !(await verifyBytes(accountPublicJwk, sig, message({ handle, hash, at })))) return 'not signed by the account key';
  return null;
}
