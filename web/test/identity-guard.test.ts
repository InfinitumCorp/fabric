import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureOwnIdentity } from "../src/identity.ts";

test("an existing identity is never reset or bootstrapped again", async () => {
  let calls = 0;
  const result = await ensureOwnIdentity({
    hasCrossSigningKeys: async () => true,
    bootstrap: async () => {
      calls += 1;
    },
  });
  assert.equal(result, "existing");
  assert.equal(calls, 0);
});

test("a first sign-in creates keys without requesting a reset", async () => {
  const seen: Array<{ setupNewCrossSigning?: boolean }> = [];
  const result = await ensureOwnIdentity({
    hasCrossSigningKeys: async () => false,
    bootstrap: async (opts) => {
      seen.push(opts);
    },
  });
  assert.equal(result, "created");
  assert.deepEqual(seen, [{ setupNewCrossSigning: false }]);
});

test("a failed key check does not create keys", async () => {
  let calls = 0;
  await assert.rejects(
    ensureOwnIdentity({
      hasCrossSigningKeys: async () => {
        throw new Error("keys_query_failed");
      },
      bootstrap: async () => {
        calls += 1;
      },
    }),
    /keys_query_failed/,
  );
  assert.equal(calls, 0);
});
