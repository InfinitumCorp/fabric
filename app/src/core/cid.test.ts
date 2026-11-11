import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { authorizeUrl, base64url, cidIssuer, isLive, parseReturn, sessionFrom } from "./cid.ts";

const pending = { verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", state: "st", issuer: "https://id.cumuluscloud.app" };

test("challenge is base64url SHA-256 (RFC 7636 example)", () => {
  assert.equal(base64url(createHash("sha256").update(pending.verifier).digest("base64")), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("authorize URL uses the fabric client, PKCE S256 and the RN return page", () => {
  const u = new URL(authorizeUrl(pending, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"));
  assert.equal(u.origin + u.pathname, "https://id.cumuluscloud.app/api/id/authorize");
  assert.equal(u.searchParams.get("client_id"), "fabric");
  assert.equal(u.searchParams.get("redirect_uri"), "https://infinitumfabric.app/cid/rn");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("state"), "st");
  assert.equal(u.searchParams.get("prompt"), null);
  assert.equal(new URL(authorizeUrl(pending, "x", true)).searchParams.get("prompt"), "create");
});

test("issuer is configurable but HTTPS only", () => {
  assert.equal(cidIssuer(undefined), "https://id.cumuluscloud.app");
  assert.equal(cidIssuer("https://ru-id.example.run.app/"), "https://ru-id.example.run.app");
  assert.equal(cidIssuer("http://insecure.example"), "https://id.cumuluscloud.app");
});

test("parses only the app's return URL", () => {
  assert.deepEqual(parseReturn("infinitumfabric-app://cid/return?code=c&state=s"), { code: "c", state: "s", error: "" });
  assert.equal(parseReturn("https://evil.example/?code=c"), null);
  assert.equal(parseReturn("infinitumfabric://cid/return?code=c"), null);
});

test("token response becomes a live session; errors do not echo the body", () => {
  const s = sessionFrom(200, { access_token: "tok", expires_in: 600, profile: { email: "a@cumuluscloud.app" } }, 0);
  assert.equal(s.token, "tok");
  assert.equal(s.until, 600_000);
  assert.ok(isLive(s, 1));
  assert.ok(!isLive(s, 600_001));
  assert.throws(() => sessionFrom(400, { error: "secret detail" }), (e: Error) => !e.message.includes("secret"));
});
