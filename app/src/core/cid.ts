// Cumulus://ID sign-in for the FabriC++ React Native app: pure helpers (no React Native imports),
// so they run under node --test. OpenID Connect authorization code + PKCE S256 + nonce against the
// issuer (contract: cumulus-id docs/integration.md). The ID token is verified (ES256 signature
// against the issuer's JWKS, iss, aud, exp, nonce) before a session is kept, and the person is
// keyed by its `sub` (the cid). The ECDSA check itself is injected, so this file needs no crypto
// library: the app passes one built on @noble/curves, the tests one built on WebCrypto.

export const CID_DEFAULT_ISSUER = "https://id.cumuluscloud.app/realms/cumulus";
export const CID_CLIENT = "fabric";
export const CID_SCOPE = "openid profile email";
/** The IdP accepts any path on infinitumfabric.app; /cid/rn hands the code to the app's scheme. */
export const CID_REDIRECT = "https://infinitumfabric.app/cid/rn";
export const CID_APP_RETURN = "infinitumfabric-app://cid/return";

export type CidProfile = { cid: string; username: string; email: string; handle: string };
export type CidSession = { token: string; until: number; profile: CidProfile };
export type CidPending = { verifier: string; state: string; nonce: string; issuer: string };

/** Issuer from EXPO_PUBLIC_CID_ISSUER (for a mirror), HTTPS only. */
export function cidIssuer(env: string | undefined): string {
  const value = (env ?? "").trim().replace(/\/+$/, "");
  return value.startsWith("https://") ? value : CID_DEFAULT_ISSUER;
}

/** The issuer's OpenID Connect endpoints. */
export function cidEndpoints(issuer: string) {
  const oidc = `${issuer.replace(/\/+$/, "")}/protocol/openid-connect`;
  return { authorize: `${oidc}/auth`, token: `${oidc}/token`, jwks: `${oidc}/certs`, revoke: `${oidc}/revoke` };
}

export function base64url(base64: string): string {
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function authorizeUrl(pending: CidPending, challenge: string, create = false): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CID_CLIENT,
    redirect_uri: CID_REDIRECT,
    scope: CID_SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: pending.state,
    nonce: pending.nonce,
  });
  if (create) params.set("prompt", "create");
  return `${cidEndpoints(pending.issuer).authorize}?${params.toString()}`;
}

/** Form body for the token endpoint (public client: no secret, the verifier binds the code). */
export function tokenRequestBody(pending: CidPending, code: string): string {
  return new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: pending.verifier,
    client_id: CID_CLIENT,
    redirect_uri: CID_REDIRECT,
  }).toString();
}

export type CidReturn = { code: string; state: string; error: string };

/** Reads infinitumfabric-app://cid/return?code&state. Null for anything else. */
export function parseReturn(url: string): CidReturn | null {
  if (!url.startsWith(`${CID_APP_RETURN}?`) && url !== CID_APP_RETURN) return null;
  const q = new URLSearchParams(url.slice(CID_APP_RETURN.length + 1));
  return { code: q.get("code") ?? "", state: q.get("state") ?? "", error: q.get("error") ?? "" };
}

export type Jwk = { kty?: string; crv?: string; x?: string; y?: string; kid?: string; use?: string };
/** ES256: true when `signature` (raw r||s, 64 bytes) signs `signingInput` under `jwk`. */
export type Es256Verify = (jwk: Jwk, signingInput: string, signature: Uint8Array) => Promise<boolean>;

export function base64urlToBytes(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const decodeJson = (part: string): Record<string, unknown> => {
  const bytes = base64urlToBytes(part);
  return JSON.parse(decodeURIComponent(Array.from(bytes, (b) => `%${b.toString(16).padStart(2, "0")}`).join(""))) as Record<string, unknown>;
};

const VERIFY_FAILED = "That sign-in couldn't be verified. Please try again.";

/**
 * Verifies a Cumulus://ID ID token: ES256 signature against `keys` (the issuer's JWKS), then iss,
 * aud (this client), exp and nonce. Returns its claims or throws a short message.
 */
export async function verifyIdToken(
  idToken: unknown,
  opts: { issuer: string; nonce: string; keys: readonly Jwk[]; verify: Es256Verify; now?: number },
): Promise<Record<string, unknown>> {
  const parts = typeof idToken === "string" ? idToken.split(".") : [];
  if (parts.length !== 3) throw new Error(VERIFY_FAILED);
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = decodeJson(parts[0]);
    claims = decodeJson(parts[1]);
  } catch {
    throw new Error(VERIFY_FAILED);
  }
  if (header.alg !== "ES256" || String(header.typ ?? "JWT").toLowerCase() === "at+jwt") throw new Error(VERIFY_FAILED);
  const jwk = opts.keys.find((k) => k.kty === "EC" && k.crv === "P-256" && (!header.kid || k.kid === header.kid) && (!k.use || k.use === "sig"));
  if (!jwk) throw new Error(VERIFY_FAILED);
  const signed = await opts.verify(jwk, `${parts[0]}.${parts[1]}`, base64urlToBytes(parts[2])).catch(() => false);
  const seconds = Math.floor((opts.now ?? Date.now()) / 1000);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const ok =
    signed &&
    claims.iss === opts.issuer &&
    aud.includes(CID_CLIENT) &&
    (aud.length === 1 || claims.azp === CID_CLIENT) &&
    typeof claims.exp === "number" &&
    claims.exp + 60 > seconds &&
    claims.nonce === opts.nonce &&
    typeof claims.sub === "string" &&
    claims.sub.length > 0;
  if (!ok) throw new Error(VERIFY_FAILED);
  return claims;
}

/** The person, keyed by the verified ID token's `sub` (the cid). */
export function profileOf(claims: Record<string, unknown>): CidProfile {
  const s = (k: string) => (typeof claims[k] === "string" ? (claims[k] as string) : "");
  return { cid: s("sub"), username: s("preferred_username") || s("username"), email: s("email"), handle: s("handle") };
}

export function displayName(p: CidProfile): string {
  return p.email || p.username || p.handle || "Signed in";
}

/** Checks a token response's status and access token, or throws a short message (never the body). */
export function tokenResponse(status: number, body: unknown): { accessToken: string; idToken: unknown; expiresIn: number } {
  const o = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (status < 200 || status >= 300 || typeof o.access_token !== "string" || !o.access_token) {
    throw new Error("Cumulus ID sign-in failed. Please try again.");
  }
  const expiresIn = Math.min(Math.max(Number(o.expires_in) || 3600, 60), 60 * 60 * 24 * 30);
  return { accessToken: o.access_token, idToken: o.id_token, expiresIn };
}

/** A session from a checked token response and the verified ID token's claims. */
export function sessionFrom(token: { accessToken: string; expiresIn: number }, claims: Record<string, unknown>, now = Date.now()): CidSession {
  return { token: token.accessToken, until: now + token.expiresIn * 1000, profile: profileOf(claims) };
}

export function isLive(s: CidSession | null, now = Date.now()): s is CidSession {
  return !!s && !!s.token && s.until > now;
}
