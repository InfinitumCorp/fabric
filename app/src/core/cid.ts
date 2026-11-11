// Cumulus ID sign-in for the FabriC++ React Native app: pure helpers (no React Native imports),
// so they run under node --test. OAuth 2.0 authorization code + PKCE S256 against the issuer.

export const CID_DEFAULT_ISSUER = "https://id.cumuluscloud.app";
export const CID_CLIENT = "fabric";
/** The IdP accepts any path on infinitumfabric.app; /cid/rn hands the code to the app's scheme. */
export const CID_REDIRECT = "https://infinitumfabric.app/cid/rn";
export const CID_APP_RETURN = "infinitumfabric-app://cid/return";

export type CidProfile = { cid: string; username: string; email: string; handle: string };
export type CidSession = { token: string; until: number; profile: CidProfile };
export type CidPending = { verifier: string; state: string; issuer: string };

/** Issuer from EXPO_PUBLIC_CID_ISSUER (for a Russia-reachable mirror), HTTPS only. */
export function cidIssuer(env: string | undefined): string {
  const value = (env ?? "").trim().replace(/\/+$/, "");
  return value.startsWith("https://") ? value : CID_DEFAULT_ISSUER;
}

export function base64url(base64: string): string {
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function authorizeUrl(pending: CidPending, challenge: string, create = false): string {
  const params = new URLSearchParams({
    client_id: CID_CLIENT,
    redirect_uri: CID_REDIRECT,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: pending.state,
  });
  if (create) params.set("prompt", "create");
  return `${pending.issuer}/api/id/authorize?${params.toString()}`;
}

export type CidReturn = { code: string; state: string; error: string };

/** Reads infinitumfabric-app://cid/return?code&state. Null for anything else. */
export function parseReturn(url: string): CidReturn | null {
  if (!url.startsWith(`${CID_APP_RETURN}?`) && url !== CID_APP_RETURN) return null;
  const q = new URLSearchParams(url.slice(CID_APP_RETURN.length + 1));
  return { code: q.get("code") ?? "", state: q.get("state") ?? "", error: q.get("error") ?? "" };
}

export function profileOf(raw: unknown): CidProfile {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
  return { cid: s("cid"), username: s("username"), email: s("email"), handle: s("handle") };
}

export function displayName(p: CidProfile): string {
  return p.email || p.username || p.handle || "Signed in";
}

/** Turns a /api/id/token response into a session, or throws a short message. */
export function sessionFrom(status: number, body: unknown, now = Date.now()): CidSession {
  const o = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (status < 200 || status >= 300 || typeof o.access_token !== "string" || !o.access_token) {
    throw new Error("Cumulus ID sign-in failed. Please try again.");
  }
  const expiresIn = Math.min(Math.max(Number(o.expires_in) || 3600, 60), 60 * 60 * 24 * 30);
  return { token: o.access_token, until: now + expiresIn * 1000, profile: profileOf(o.profile) };
}

export function isLive(s: CidSession | null, now = Date.now()): s is CidSession {
  return !!s && !!s.token && s.until > now;
}
