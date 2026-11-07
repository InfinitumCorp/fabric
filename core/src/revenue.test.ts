import { test } from "node:test";
import assert from "node:assert/strict";
import { createRevenueClient, formatUsd, PaymentsDisabledError } from "./revenue.ts";

function fakeFetch(routes: Record<string, unknown>, calls: string[]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${new URL(url).pathname}${new URL(url).search}`;
    calls.push(key);
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer t1");
    if (!(key in routes)) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as typeof fetch;
}

test("reads the FABRIC plan, consents, withdraws and reads real earnings", async () => {
  const calls: string[] = [];
  const rc = createRevenueClient({
    baseUrl: "http://rev.test", token: async () => "t1", paymentsEnabled: false,
    fetch: fakeFetch({
      "GET /v1/me/entitlements": { orgId: "o1", credits_cents: 0, products: [
        { product: "scalus", plan: "scalus_free", status: "free", seats: 1, features: [] },
        { product: "fabric", plan: "fabric_personal", status: "free", seats: 1, features: [] }] },
      "POST /v1/consents": { id: "cns_1" },
      "DELETE /v1/consents/fabric?purpose=data_licensing": { withdrawn: 1, delisted: 2 },
      "GET /v1/earnings": { availableCents: 0, pendingCents: 0 },
    }, calls),
  });
  assert.deepEqual(await rc.fabricPlan(), { plan: "fabric_personal", status: "free", seats: 1, features: [] });
  await rc.grantDataConsent();
  assert.deepEqual(await rc.withdrawDataConsent(), { withdrawn: 1, delisted: 2 });
  assert.deepEqual(await rc.earnings(), { availableCents: 0, pendingCents: 0 });
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(7000), "$70.00");
  assert.deepEqual(calls, ["GET /v1/me/entitlements", "POST /v1/consents", "DELETE /v1/consents/fabric?purpose=data_licensing", "GET /v1/earnings"]);
});

test("checkout and payouts make no request while payments are off", async () => {
  const calls: string[] = [];
  const rc = createRevenueClient({ baseUrl: "http://rev.test", token: async () => "t1", paymentsEnabled: false, fetch: fakeFetch({}, calls) });
  await assert.rejects(rc.startCheckout(), PaymentsDisabledError);
  await assert.rejects(rc.requestPayout(), PaymentsDisabledError);
  assert.deepEqual(calls, []);
});

test("a missing FABRIC entitlement is an error, not a guessed plan", async () => {
  const rc = createRevenueClient({ baseUrl: "http://rev.test", token: async () => "t1", paymentsEnabled: false,
    fetch: fakeFetch({ "GET /v1/me/entitlements": { products: [] } }, []) });
  await assert.rejects(rc.fabricPlan(), /no_fabric_entitlement/);
});
