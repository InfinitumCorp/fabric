import { test } from "node:test";
import assert from "node:assert/strict";
import { canSend, renderBody, nextStatus } from "./rules.ts";

test("canSend refuses unencrypted or unknown or pending identity change", () => {
  assert.deepEqual(canSend({ encryption: "off", pendingIdentityChange: false }), { ok: false, reason: "not_encrypted" });
  assert.deepEqual(canSend({ encryption: "unknown", pendingIdentityChange: false }), { ok: false, reason: "encryption_unknown" });
  assert.deepEqual(canSend({ encryption: "on", pendingIdentityChange: true }), { ok: false, reason: "identity_changed" });
  assert.deepEqual(canSend({ encryption: "on", pendingIdentityChange: false }), { ok: true });
});

test("renderBody shows text or unable to decrypt", () => {
  assert.equal(renderBody({ kind: "text", body: "hello" }), "hello");
  assert.equal(renderBody({ kind: "undecryptable" }), "Unable to decrypt");
});

test("nextStatus transitions correctly", () => {
  assert.equal(nextStatus("sending", "ack"), "sent");
  assert.equal(nextStatus("sending", "error"), "failed");
  assert.equal(nextStatus("failed", "retry"), "sending");
  assert.equal(nextStatus("sent", "error"), "sent");
});
