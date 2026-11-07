import { test } from "node:test";
import assert from "node:assert/strict";
import { unavailableBridge, BridgeUnavailableError } from "./bridge.ts";

test("the placeholder bridge refuses everything and never claims a session", async () => {
  await assert.rejects(unavailableBridge.restore("http://127.0.0.1:8008"), BridgeUnavailableError);
  await assert.rejects(unavailableBridge.login("http://127.0.0.1:8008", "alice", "pw"), BridgeUnavailableError);
  await assert.rejects(unavailableBridge.logoutAndWipe(), BridgeUnavailableError);
  assert.equal(unavailableBridge.encryptedMessaging, false);
});
