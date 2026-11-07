export class PaymentsDisabledError extends Error {
  constructor() { super("payments_disabled"); }
}

type Opts = { baseUrl: string; token: () => Promise<string>; fetch: typeof fetch; paymentsEnabled: boolean };
type Plan = { plan: "fabric_personal" | "fabric_business"; status: string; seats: number; features: string[] };

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function createRevenueClient(o: Opts) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await o.fetch(`${o.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await o.token()}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`revenue_${res.status}`);
    return (await res.json()) as T;
  }

  return {
    async fabricPlan(): Promise<Plan> {
      const e = await call<{ products: Array<Plan & { product: string }> }>("GET", "/v1/me/entitlements");
      const f = e.products.find((p) => p.product === "fabric");
      if (!f) throw new Error("no_fabric_entitlement");
      return { plan: f.plan, status: f.status, seats: f.seats, features: f.features };
    },
    async grantDataConsent(): Promise<void> {
      await call("POST", "/v1/consents", { product: "fabric", purpose: "data_licensing" });
    },
    withdrawDataConsent(): Promise<{ withdrawn: number; delisted: number }> {
      return call("DELETE", "/v1/consents/fabric?purpose=data_licensing");
    },
    earnings(): Promise<{ availableCents: number; pendingCents: number }> {
      return call("GET", "/v1/earnings");
    },
    // Live checkout and payouts are not wired in this plan; both always refuse without a request.
    async startCheckout(): Promise<never> {
      throw new PaymentsDisabledError();
    },
    async requestPayout(): Promise<never> {
      throw new PaymentsDisabledError();
    },
  };
}
