import { test } from "node:test";
import assert from "node:assert/strict";
import { FAB_TOKEN, firmLinks, firmState, shortAddress } from "./firm.ts";

test("links carry the product as ref", () => {
  assert.deepEqual(firmLinks(), { wallet: "https://firmwallet.app/?ref=fabric", network: "https://firmnetwork.app/?ref=fabric" });
});

test("no wallet means early access; never a placeholder wallet", () => {
  assert.deepEqual(firmState(null), { kind: "early" });
  assert.deepEqual(firmState({ balances: { FIRM: "1" } }), { kind: "early" });
});

test("a real wallet keeps only ticker-shaped balances", () => {
  const state = firmState({ address: "0xabc", balances: { FIRM: 3, USDC: "1.50", "bad key": "9" } });
  assert.deepEqual(state, { kind: "wallet", wallet: { address: "0xabc", balances: { FIRM: "3", USDC: "1.50" } } });
});

test("FabriC++ token is $FAB on Solana", () => {
  assert.deepEqual(FAB_TOKEN, { ticker: "$FAB", network: "Solana" });
  assert.equal(shortAddress("0x1234567890abcdef1234"), "0x123456…ef1234");
});
