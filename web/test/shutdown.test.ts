import { test } from "node:test";
import assert from "node:assert/strict";
import { shutdownSession } from "../src/shutdown.ts";

test("sign-out logs out, then stops, then clears, even if logout fails", async () => {
  const calls: string[] = [];
  const client = {
    async logout(stop?: boolean) {
      calls.push(`logout:${String(stop)}`);
    },
    stopClient() {
      calls.push("stop");
    },
    async clearStores() {
      calls.push("clear");
    },
  };
  await shutdownSession(client);
  assert.deepEqual(calls, ["stop", "logout:false", "clear"]);

  const failed: string[] = [];
  await shutdownSession({
    async logout() {
      failed.push("logout");
      throw new Error("network");
    },
    stopClient() {
      failed.push("stop");
    },
    async clearStores() {
      failed.push("clear");
    },
  });
  assert.deepEqual(failed, ["stop", "logout", "clear"]);
});
