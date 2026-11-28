import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REVENUE_DEFAULT_URL,
  RevenueError,
  billingNotice,
  createRevenueClient,
  fabricPlans,
  formatPrice,
  formatUsd,
  PaymentsDisabledError,
  revenueUrl,
  seatCount,
} from "./revenue.ts";

type Call = { key: string; auth: string | null; body: unknown };

function fakeFetch(responses: Record<string, unknown>, calls: Call[], status: Record<string, number> = {}) {
  return async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const key = `${init?.method ?? "GET"} ${u.pathname}${u.search}`;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ key, auth: headers.Authorization ?? null, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const body = responses[key];
    const code = status[key] ?? (body ? 200 : 404);
    return { ok: code < 300, status: code, json: async () => body ?? {} } as any;
  };
}

const CATALOG = {
  plans: [
    { id: "fabric_personal", product: "fabric", name: "FABRIC Personal", channel: "self_serve", priceCents: 0, interval: "month" },
    { id: "fabric_business", product: "fabric", name: "FABRIC Business", channel: "self_serve", priceCents: 800, interval: "month", perSeat: true },
    { id: "fabric_enterprise", product: "fabric", name: "Contract", channel: "contract", priceCents: 0, interval: "year" },
    { id: "scalvs_pro", product: "scalvs", name: "SCALVS.ai Pro", channel: "self_serve", priceCents: 2900, interval: "month" },
  ],
};

const client = (responses: Record<string, unknown>, calls: Call[], status?: Record<string, number>) =>
  createRevenueClient({ baseUrl: "http://rev.test/", token: async () => "t1", paymentsEnabled: false, fetch: fakeFetch(responses, calls, status) as unknown as typeof fetch });

test("revenue URL is configurable and HTTPS only", () => {
  assert.equal(revenueUrl(undefined), REVENUE_DEFAULT_URL);
  assert.equal(revenueUrl("http://evil.test"), REVENUE_DEFAULT_URL);
  assert.equal(revenueUrl(" https://rev.example.ru/ "), "https://rev.example.ru");
});

test("catalog lists FABRIC plans only, without a token", async () => {
  const calls: Call[] = [];
  const plans = await client({ "GET /v1/catalog": CATALOG }, calls).catalog();
  assert.deepEqual(plans.map((p) => p.id), ["fabric_personal", "fabric_business"]);
  assert.equal(calls[0].auth, null);
  assert.deepEqual(fabricPlans({}), []);
  assert.equal(formatPrice(plans[0]), "Free");
  assert.equal(formatPrice(plans[1]), "$8 / month per seat");
  assert.equal(formatPrice({ priceCents: 850, interval: "year" }), "$8.50 / year");
});

test("fabric plan, consent, earnings send the Cumulus ID token", async () => {
  const calls: Call[] = [];
  const rc = client(
    {
      "GET /v1/me/entitlements": {
        products: [{ product: "fabric", plan: "fabric_personal", status: "free", seats: 1, features: [] }],
      },
      "POST /v1/consents": { id: "cns_1" },
      "DELETE /v1/consents/fabric?purpose=data_licensing": { withdrawn: 1, delisted: 2 },
      "GET /v1/earnings": { availableCents: 0, pendingCents: 0 },
    },
    calls,
  );
  assert.deepEqual(await rc.fabricPlan(), { plan: "fabric_personal", status: "free", seats: 1, features: [] });
  await rc.grantDataConsent();
  assert.deepEqual(await rc.withdrawDataConsent(), { withdrawn: 1, delisted: 2 });
  assert.deepEqual(await rc.earnings(), { availableCents: 0, pendingCents: 0 });
  assert.equal(formatUsd(7000), "$70.00");
  assert.deepEqual(
    calls.map((c) => [c.key, c.auth]),
    [
      ["GET /v1/me/entitlements", "Bearer t1"],
      ["POST /v1/consents", "Bearer t1"],
      ["DELETE /v1/consents/fabric?purpose=data_licensing", "Bearer t1"],
      ["GET /v1/earnings", "Bearer t1"],
    ],
  );
});

test("upgrade to Business switches the org to business, then opens Checkout with the seats", async () => {
  const calls: Call[] = [];
  const url = await client(
    {
      "POST /v1/me/org": { id: "org_1", name: "Acme", kind: "business" },
      "POST /v1/subscriptions/checkout": { url: "https://checkout.stripe.com/c/pay/cs_1" },
    },
    calls,
  ).upgradeToBusiness(5, "https://infinitumfabric.app/account", " Acme ");
  assert.equal(url, "https://checkout.stripe.com/c/pay/cs_1");
  assert.deepEqual(calls, [
    { key: "POST /v1/me/org", auth: "Bearer t1", body: { kind: "business", name: "Acme" } },
    {
      key: "POST /v1/subscriptions/checkout",
      auth: "Bearer t1",
      body: { planId: "fabric_business", quantity: 5, returnUrl: "https://infinitumfabric.app/account" },
    },
  ]);
});

test("manage billing opens the Stripe portal", async () => {
  const calls: Call[] = [];
  const url = await client({ "POST /v1/billing/portal": { url: "https://billing.stripe.com/p/session/x" } }, calls).billingPortal(
    "https://infinitumfabric.app/account",
  );
  assert.equal(url, "https://billing.stripe.com/p/session/x");
  assert.deepEqual(calls[0].body, { returnUrl: "https://infinitumfabric.app/account" });
});

test("API errors carry the revenue API's message", async () => {
  const calls: Call[] = [];
  const rc = client(
    { "POST /v1/subscriptions/checkout": { error: { code: "approval_required", message: "Needs approval" } } },
    calls,
    { "POST /v1/subscriptions/checkout": 403 },
  );
  await assert.rejects(rc.startCheckout("fabric_business", 1, "https://infinitumfabric.app/"), (e: unknown) => {
    assert.ok(e instanceof RevenueError);
    assert.equal(e.status, 403);
    assert.equal(e.code, "approval_required");
    assert.equal(e.message, "Needs approval");
    return true;
  });
});

test("payouts make no request while payments are off", async () => {
  const calls: Call[] = [];
  await assert.rejects(client({}, calls).requestPayout(), PaymentsDisabledError);
  assert.deepEqual(calls, []);
});

test("a missing FABRIC entitlement is an error, not a guessed plan", async () => {
  await assert.rejects(client({ "GET /v1/me/entitlements": { products: [] } }, []).fabricPlan(), /no_fabric_entitlement/);
});

test("seat count and billing notice", () => {
  assert.equal(seatCount("3"), 3);
  assert.equal(seatCount(0), 1);
  assert.equal(seatCount("x"), 1);
  assert.equal(seatCount(99999), 10000);
  assert.equal(billingNotice("?billing=success&session_id=cs_1"), "Payment complete. Your plan is active.");
  assert.equal(billingNotice("?billing=cancelled"), "Checkout cancelled. No charge was made.");
  assert.equal(billingNotice(""), null);
});
