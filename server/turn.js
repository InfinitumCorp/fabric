// TURN run by the operator (coturn or any server that speaks the "TURN REST API" shared-secret
// scheme). The relay never stores TURN passwords: it signs short-lived ones for signed-in devices.
//
//   username   = "<expiry unix seconds>:<random id>"   (no handle, so TURN logs don't name anyone)
//   credential = base64(HMAC-SHA1(shared secret, username))
//
// coturn checks the same HMAC with `use-auth-secret` and `static-auth-secret`, and refuses the
// username after its expiry. Credentials go out only over an authenticated relay socket, so the
// TURN server can't be used by whoever finds its address.

import { createHmac, randomBytes } from 'node:crypto';

const listEnv = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
export const TURN_URL_RE = /^turns?:[A-Za-z0-9.\-[\]:]+(\?transport=(udp|tcp))?$/;

/** TURN settings from the environment, or null. */
export function turnFromEnv(env = process.env) {
  const urls = listEnv(env.FABRIC_TURN_URLS);
  if (!urls.length) return null;
  if (!env.FABRIC_TURN_SECRET) throw new Error('FABRIC_TURN_URLS is set but FABRIC_TURN_SECRET is not');
  for (const u of urls) if (!TURN_URL_RE.test(u)) throw new Error(`not a TURN URL: ${u}`);
  const ttl = Number(env.FABRIC_TURN_TTL || 3600);
  if (!(ttl >= 300 && ttl <= 86_400)) throw new Error('FABRIC_TURN_TTL must be between 300 and 86400 seconds');
  return { urls, secret: env.FABRIC_TURN_SECRET, ttl };
}

/** One RTCIceServer entry with a fresh time-limited login. */
export function turnCredentials({ urls, secret, ttl }, now = Date.now()) {
  const expires = Math.floor(now / 1000) + ttl;
  const username = `${expires}:${randomBytes(9).toString('base64url')}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { urls, username, credential, expires };
}

/** What coturn does with a login: the same HMAC, and not past its expiry. */
export function checkTurnLogin(secret, username, credential, now = Date.now()) {
  const expiry = Number(String(username).split(':')[0]);
  if (!Number.isFinite(expiry) || expiry < Math.floor(now / 1000)) return false;
  return createHmac('sha1', secret).update(String(username)).digest('base64') === credential;
}
