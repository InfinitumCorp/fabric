import { test } from "node:test";
import assert from "node:assert/strict";
import { sendDecision } from "../../core/src/conversation.ts";
import {
  PROTOTYPE_WARNING,
  REVENUE_PLAN,
  REVENUE_DATA,
  acknowledgementCall,
  assertLocalHomeserver,
  assertSecureContext,
  decideSend,
  mapIdentity,
  mapSendState,
  messageText,
  peerUserId,
  reportRequest,
} from "../src/policy.ts";

test("local homeservers are loopback only", () => {
  assert.equal(assertLocalHomeserver("http://127.0.0.1:8008"), "http://127.0.0.1:8008");
  assert.equal(assertLocalHomeserver("http://localhost:18408/"), "http://localhost:18408");
  assert.equal(assertLocalHomeserver("http://[::1]:8008"), "http://[::1]:8008");
  assert.equal(assertSecureContext(true), undefined);
  for (const bad of [
    "https://matrix.org",
    "http://10.0.2.2:8008",
    "http://127.0.0.1.evil.test:8008",
    "ftp://127.0.0.1:8008",
    "http://user:pw@127.0.0.1:8008",
    "http://192.168.1.2:8008",
    "not a url",
  ]) {
    assert.throws(() => assertLocalHomeserver(bad), /bad_server/);
  }
  assert.throws(() => assertSecureContext(false), /insecure_context/);
});

test("identity mapping matches the Android trust labels", () => {
  assert.equal(mapIdentity({ known: false, needsUserApproval: false, crossSigningVerified: false }), "unknown");
  assert.equal(mapIdentity({ known: true, needsUserApproval: false, crossSigningVerified: false }), "unverified");
  assert.equal(mapIdentity({ known: true, needsUserApproval: false, crossSigningVerified: true }), "verified");
  assert.equal(mapIdentity({ known: true, needsUserApproval: true, crossSigningVerified: true }), "changed");
  assert.equal(mapIdentity({ known: true, needsUserApproval: true, crossSigningVerified: false }), "changed");
});

test("unverified known peers may send; changed, unknown, and unencrypted may not", () => {
  const base = { encrypted: true as boolean | null, peer: "@b:localhost", identity: "unverified" as const };
  assert.deepEqual(decideSend(base), sendDecision(base));
  assert.deepEqual(decideSend(base), { ok: true });
  assert.deepEqual(decideSend({ ...base, identity: "changed" }), { ok: false, reason: "identity_changed" });
  assert.deepEqual(decideSend({ ...base, identity: "unknown" }), { ok: false, reason: "identity_unknown" });
  assert.deepEqual(decideSend({ ...base, peer: null }), { ok: false, reason: "identity_unknown" });
  assert.deepEqual(decideSend({ ...base, encrypted: false }), { ok: false, reason: "not_encrypted" });
  assert.deepEqual(decideSend({ ...base, encrypted: null }), { ok: false, reason: "encryption_unknown" });
});

test("a direct room resolves one other member and ignores everyone else", () => {
  assert.equal(peerUserId("@a:localhost", ["@a:localhost", "@b:localhost"], null, "join"), "@b:localhost");
  assert.equal(peerUserId("@a:localhost", ["@a:localhost", "@b:localhost", "@c:localhost"], null, "join"), null);
  assert.equal(peerUserId("@a:localhost", [], "@b:localhost", "invite"), "@b:localhost");
});

test("acknowledgement withdraws a previously verified identity and only pins otherwise", () => {
  assert.equal(acknowledgementCall(true), "withdraw");
  assert.equal(acknowledgementCall(false), "pin");
});

test("message text and send state stay honest", () => {
  assert.equal(messageText(true, "secret"), "Unable to decrypt");
  assert.equal(messageText(false, null), "Unable to decrypt");
  assert.equal(messageText(false, "hello"), "hello");
  assert.equal(mapSendState(null), "sent");
  assert.equal(mapSendState("sent"), "sent");
  assert.equal(mapSendState("sending"), "sending");
  assert.equal(mapSendState("encrypting"), "sending");
  assert.equal(mapSendState("queued"), "sending");
  assert.equal(mapSendState("not_sent"), "failed");
  assert.equal(mapSendState("cancelled"), "failed");
});

test("event reports are metadata only", () => {
  const req = reportRequest("!room:localhost", "$event");
  assert.deepEqual(req.body, { score: -100, reason: "Abuse" });
  assert.equal(JSON.stringify(req).includes("meet at 9"), false);
  assert.equal(Object.keys(req.body).sort().join(), "reason,score");
  assert.throws(() => reportRequest("!room:localhost", "not-an-event"), /bad_input/);
});

test("the prototype warning states the session limits", () => {
  assert.match(PROTOTYPE_WARNING, /new device/i);
  assert.match(PROTOTYPE_WARNING, /not guaranteed/i);
  assert.match(PROTOTYPE_WARNING, /does not reliably/i);
  assert.match(PROTOTYPE_WARNING, /Sign out/);
  assert.doesNotMatch(PROTOTYPE_WARNING, /production-ready/i);
  assert.doesNotMatch(PROTOTYPE_WARNING, /security audit/i);
  assert.match(REVENUE_PLAN, /Not connected/);
  assert.match(REVENUE_DATA, /Not connected/);
  assert.match(REVENUE_DATA, /Messaging does not depend/);
});
