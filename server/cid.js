// Cumulus://ID™ (CID) sign-in for the relay: an OpenID Connect client (authorization code
// flow with PKCE). The relay is the client: it holds the PKCE verifier, swaps the code for an
// ID token itself and checks that token. The browser only carries the code back from the
// sign-in window, so no CID token ever reaches the page.
//
// What CID is used for: proving that an address belongs to a CID account (and, when the relay
// requires it, that each new address has one), and finding that account's encrypted backup
// on a new device. CID never gets a key that can read messages or sign a device list.

import { createHash, createHmac, createPublicKey, randomBytes, verify as verifySig } from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const SKEW_S = 60;
const FLOW_TTL_MS = 10 * 60 * 1000;
const ALGS = { ES256: { hash: 'sha256', dsaEncoding: 'ieee-p1363', kty: 'EC' }, RS256: { hash: 'sha256', kty: 'RSA' } };

const isLocalUrl = (u) => ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) || u.hostname.endsWith('.localhost');

/** https, or plain http on this machine only (the development stand-in). */
function checkUrl(text, what) {
  let u;
  try { u = new URL(text); } catch { throw new Error(`${what} is not a URL`); }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocalUrl(u))) throw new Error(`${what} must use https`);
  return u;
}

/** CID settings from the environment, or null when CID sign-in is off. */
export function cidFromEnv(env = process.env) {
  if (!env.FABRIC_CID_ISSUER) return null;
  if (!env.FABRIC_CID_CLIENT_ID) throw new Error('FABRIC_CID_ISSUER is set but FABRIC_CID_CLIENT_ID is not');
  return {
    issuer: env.FABRIC_CID_ISSUER,
    clientId: env.FABRIC_CID_CLIENT_ID,
    clientSecret: env.FABRIC_CID_CLIENT_SECRET || null,
    publicUrl: env.FABRIC_PUBLIC_URL || null,
    required: env.FABRIC_CID_REQUIRED === '1',
  };
}

/** PKCE (RFC 7636, S256). */
export function pkce() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

function decodePart(part) {
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); } catch { throw new Error('malformed token'); }
}

/**
 * Check an ID token: signature against the issuer's keys, then issuer, audience, time and nonce.
 * Only ES256 and RS256 are accepted (never "none", never a shared-secret algorithm).
 */
export async function verifyIdToken(jwt, { issuer, clientId, nonce, keys, now = Date.now() }) {
  const parts = String(jwt).split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const header = decodePart(parts[0]);
  const claims = decodePart(parts[1]);
  const alg = ALGS[header.alg];
  if (!alg) throw new Error(`token algorithm ${header.alg} not allowed`);
  const jwk = await keys(header.kid);
  if (!jwk || jwk.kty !== alg.kty || (jwk.alg && jwk.alg !== header.alg) || (jwk.use && jwk.use !== 'sig')) throw new Error('unknown signing key');
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  const ok = verifySig(alg.hash, Buffer.from(`${parts[0]}.${parts[1]}`), alg.dsaEncoding ? { key, dsaEncoding: alg.dsaEncoding } : key, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new Error('bad token signature');

  const t = Math.floor(now / 1000);
  if (claims.iss !== issuer) throw new Error('token from another issuer');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) throw new Error('token for another client');
  if (aud.length > 1 && claims.azp !== clientId) throw new Error('token for another client');
  if (!(Number.isFinite(claims.exp) && claims.exp + SKEW_S > t)) throw new Error('token expired');
  if (Number.isFinite(claims.iat) && claims.iat - SKEW_S > t) throw new Error('token from the future');
  if (typeof nonce !== 'string' || claims.nonce !== nonce) throw new Error('token nonce mismatch');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw new Error('token has no subject');
  return claims;
}

/**
 * The relay's CID client. `secret` keys the stored account ids: the relay keeps
 * HMAC(secret, issuer|sub), never CID's own id for the person.
 */
export function createCid({ issuer, clientId, clientSecret = null, redirectUri, secret, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  checkUrl(issuer, 'FABRIC_CID_ISSUER');
  checkUrl(redirectUri, 'the CID redirect address');
  let config = null;
  let jwks = { at: 0, keys: [] };
  const flows = new Map(); // state -> { owner, purpose, nonce, verifier, expires }

  async function getJson(url, init) {
    const r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000) });
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { throw new Error(`CID answered ${r.status} without JSON`); }
    if (!r.ok) throw new Error(`CID: ${body.error_description || body.error || r.status}`);
    return body;
  }

  async function discover() {
    if (config) return config;
    const c = await getJson(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
    if (c.issuer !== issuer) throw new Error('CID discovery names another issuer');
    for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) checkUrl(c[k], `CID ${k}`);
    if (Array.isArray(c.code_challenge_methods_supported) && !c.code_challenge_methods_supported.includes('S256')) throw new Error('CID does not support PKCE S256');
    return (config = c);
  }

  /** A signing key by id; the key set is refetched at most once a minute for an unknown id. */
  async function keyFor(kid) {
    const find = () => jwks.keys.find((k) => (kid ? k.kid === kid : true));
    if (find()) return find();
    if (now() - jwks.at < 60_000) return null;
    const { jwks_uri: uri } = await discover();
    const set = await getJson(uri);
    jwks = { at: now(), keys: Array.isArray(set.keys) ? set.keys : [] };
    return find() || null;
  }

  /** Start a sign-in for `owner` (the socket that asked). Returns the URL for the sign-in window. */
  async function begin(owner, purpose) {
    const c = await discover();
    const state = b64url(randomBytes(24));
    const nonce = b64url(randomBytes(24));
    const { verifier, challenge } = pkce();
    flows.set(state, { owner, purpose, nonce, verifier, expires: now() + FLOW_TTL_MS });
    const u = new URL(c.authorization_endpoint);
    u.search = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: 'openid email profile',
      state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
    }).toString();
    return { state, url: u.toString() };
  }

  /**
   * Finish a sign-in: only the socket that started it, only once, only in time. Swaps the code
   * for an ID token and checks it. Returns { purpose, key, email, name }.
   */
  async function finish(owner, state, code) {
    const flow = typeof state === 'string' && flows.get(state);
    if (!flow || flow.owner !== owner) throw new Error('That sign-in was not started here.');
    flows.delete(state); // one try per sign-in, whatever happens next
    if (flow.expires < now()) throw new Error('That sign-in took too long. Try again.');
    if (typeof code !== 'string' || !code || code.length > 2048) throw new Error('No sign-in code came back.');
    const c = await discover();
    const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    const form = { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: flow.verifier, client_id: clientId };
    if (clientSecret) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`;
    const tok = await getJson(c.token_endpoint, { method: 'POST', headers, body: new URLSearchParams(form).toString() });
    if (typeof tok.id_token !== 'string') throw new Error('CID sent no ID token');
    const claims = await verifyIdToken(tok.id_token, { issuer, clientId, nonce: flow.nonce, keys: keyFor, now: now() });
    return {
      purpose: flow.purpose,
      key: createHmac('sha256', secret).update(`${issuer}|${claims.sub}`).digest('base64url'),
      email: typeof claims.email === 'string' ? claims.email.slice(0, 254) : null,
      name: typeof claims.name === 'string' ? claims.name.slice(0, 100) : null,
    };
  }

  const forget = (owner) => { for (const [s, f] of flows) if (f.owner === owner) flows.delete(s); };
  const sweep = () => { const t = now(); for (const [s, f] of flows) if (f.expires < t) flows.delete(s); };

  return { begin, finish, forget, sweep, discover };
}
