import { test } from "node:test";
import assert from "node:assert/strict";
import { canSend, nextStatus, renderBody } from "./rules.ts";

test("sending is fail-closed", () => {
  assert.deepEqual(canSend({ encryption: "on", pendingIdentityChange: false }), { ok: true });
  assert.deepEqual(canSend({ encryption: "off", pendingIdentityChange: false }), { ok: false, reason: "not_encrypted" });
  assert.deepEqual(canSend({ encryption: "unknown", pendingIdentityChange: false }), { ok: false, reason: "encryption_unknown" });
  assert.deepEqual(canSend({ encryption: "on", pendingIdentityChange: true }), { ok: false, reason: "identity_changed" });
});

test("undecryptable messages show no content", () => {
  assert.equal(renderBody({ kind: "undecryptable" }), "Unable to decrypt");
  assert.equal(renderBody({ kind: "text", body: "hi" }), "hi");
});

test("message status moves sending → sent or failed → sending", () => {
  assert.equal(nextStatus("sending", "ack"), "sent");
  assert.equal(nextStatus("sending", "error"), "failed");
  assert.equal(nextStatus("failed", "retry"), "sending");
  assert.equal(nextStatus("sent", "error"), "sent");
});
