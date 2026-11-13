import { test } from "node:test";
import assert from "node:assert/strict";
import { sendDecision, trustLabel, isValidUserId } from "./conversation.ts";

const base = { encrypted: true, peer: "@b:fabric.localhost", identity: "unverified" as const };

test("encrypted room with unverified peer may send but is marked unverified", () => {
  assert.deepEqual(sendDecision(base), { ok: true });
  assert.equal(trustLabel("unverified"), "Not verified");
});

test("unencrypted or unknown encryption refuses", () => {
  assert.deepEqual(sendDecision({ ...base, encrypted: false }), { ok: false, reason: "not_encrypted" });
  assert.deepEqual(sendDecision({ ...base, encrypted: null }), { ok: false, reason: "encryption_unknown" });
});

test("changed identity and unresolved identity refuse", () => {
  assert.deepEqual(sendDecision({ ...base, identity: "changed" }), { ok: false, reason: "identity_changed" });
  assert.deepEqual(sendDecision({ ...base, identity: "unknown" }), { ok: false, reason: "identity_unknown" });
  assert.deepEqual(sendDecision({ ...base, peer: null }), { ok: false, reason: "identity_unknown" });
});

test("verified label and user id validation", () => {
  assert.equal(trustLabel("verified"), "Verified");
  assert.ok(isValidUserId("@bob:fabric.localhost"));
  assert.ok(!isValidUserId("bob"));
  assert.ok(!isValidUserId("@bob"));
  assert.ok(!isValidUserId("@b ob:x"));
});
