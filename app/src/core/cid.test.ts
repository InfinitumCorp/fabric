import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import {
  authorizeUrl,
  base64url,
  cidEndpoints,
  cidIssuer,
  isLive,
  parseReturn,
  sessionFrom,
  tokenRequestBody,
  tokenResponse,
  verifyIdToken,
  type Es256Verify,
  type Jwk,
} from "./cid.ts";

const ISSUER = "https://id.cumuluscloud.app/realms/cumulus";
const pending = { verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", state: "st", nonce: "nn", issuer: ISSUER };

// The app checks ES256 with @noble/curves; the tests use WebCrypto for the same check.
const verify: Es256Verify = async (jwk, input, sig) => {
  const key = await webcrypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  return webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, new TextEncoder().encode(input));
};
const b64u = (v: string | ArrayBuffer) => Buffer.from(typeof v === "string" ? v : new Uint8Array(v)).toString("base64url");
async function issuer() {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await webcrypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1", use: "sig" } as Jwk;
  const sign = async (over: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: ISSUER, aud: "fabric", sub: "cid_7c1e", exp: now + 300, iat: now, nonce: "nn", email: "a@cumuluscloud.app", preferred_username: "ada", ...over };
    const h = b64u(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "k1" }));
    const p = b64u(JSON.stringify(claims));
    const sig = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${b64u(sig)}`;
  };
  return { keys: [jwk], sign };
}

test("challenge is base64url SHA-256 (RFC 7636 example)", () => {
  assert.equal(base64url(createHash("sha256").update(pending.verifier).digest("base64")), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("authorize URL uses the OIDC endpoint, the fabric client, PKCE S256, a nonce and the RN return page", () => {
  const u = new URL(authorizeUrl(pending, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"));
  assert.equal(u.origin + u.pathname, `${ISSUER}/protocol/openid-connect/auth`);
  assert.equal(u.searchParams.get("client_id"), "fabric");
  assert.equal(u.searchParams.get("redirect_uri"), "https://infinitumfabric.app/cid/rn");
  assert.equal(u.searchParams.get("scope"), "openid profile email");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("state"), "st");
  assert.equal(u.searchParams.get("nonce"), "nn");
  assert.equal(u.searchParams.get("prompt"), null);
  assert.equal(new URL(authorizeUrl(pending, "x", true)).searchParams.get("prompt"), "create");
});

test("token request is a public-client form post with the verifier", () => {
  assert.equal(cidEndpoints(ISSUER).token, `${ISSUER}/protocol/openid-connect/token`);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(tokenRequestBody(pending, "c0de"))), {
    grant_type: "authorization_code",
    code: "c0de",
    code_verifier: pending.verifier,
    client_id: "fabric",
    redirect_uri: "https://infinitumfabric.app/cid/rn",
  });
});

test("issuer is the cumulus realm, configurable but HTTPS only", () => {
  assert.equal(cidIssuer(undefined), ISSUER);
  assert.equal(cidIssuer("https://mirror.example/realms/cumulus/"), "https://mirror.example/realms/cumulus");
  assert.equal(cidIssuer("http://insecure.example"), ISSUER);
});

test("parses only the app's return URL", () => {
  assert.deepEqual(parseReturn("infinitumfabric-app://cid/return?code=c&state=s"), { code: "c", state: "s", error: "" });
  assert.equal(parseReturn("https://evil.example/?code=c"), null);
  assert.equal(parseReturn("infinitumfabric://cid/return?code=c"), null);
});

test("a verified ID token becomes a live session keyed by sub; errors do not echo the body", async () => {
  const { keys, sign } = await issuer();
  const claims = await verifyIdToken(await sign(), { issuer: ISSUER, nonce: "nn", keys, verify });
  const s = sessionFrom(tokenResponse(200, { access_token: "tok", expires_in: 600 }), claims, 0);
  assert.equal(s.token, "tok");
  assert.equal(s.until, 600_000);
  assert.deepEqual(s.profile, { cid: "cid_7c1e", username: "ada", email: "a@cumuluscloud.app", handle: "" });
  assert.ok(isLive(s, 1));
  assert.ok(!isLive(s, 600_001));
  assert.throws(() => tokenResponse(400, { error: "secret detail" }), (e: Error) => !e.message.includes("secret"));
});

test("refuses an ID token with the wrong nonce, audience, issuer, expiry or key", async () => {
  const { keys, sign } = await issuer();
  const other = await issuer();
  const check = (token: string) => verifyIdToken(token, { issuer: ISSUER, nonce: "nn", keys, verify });
  await assert.rejects(check(await sign({ nonce: "other" })));
  await assert.rejects(check(await sign({ aud: "scalvs" })));
  await assert.rejects(check(await sign({ aud: ["fabric", "scalvs"] })));
  await assert.rejects(check(await sign({ iss: "https://cognito-idp.us-east-1.amazonaws.com/x" })));
  await assert.rejects(check(await sign({ exp: Math.floor(Date.now() / 1000) - 3600 })));
  await assert.rejects(check(await other.sign()));
  await assert.rejects(check("not-a-token"));
});
