export class PaymentsDisabledError extends Error {
  constructor() {
    super("payments_disabled");
    this.name = "PaymentsDisabledError";
  }
}

type Opts = {
  baseUrl: string;
  token: () => Promise<string>;
  fetch: typeof fetch;
  paymentsEnabled: boolean;
};

type Plan = {
  plan: "fabric_personal" | "fabric_business";
  status: string;
  seats: number;
  features: string[];
};

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function createRevenueClient(opts: Opts) {
  const base = opts.baseUrl.replace(/\/$/, "");
  async function call(method: string, path: string, body?: unknown) {
    const token = await opts.token();
    const res = await opts.fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`http_${res.status}`);
    return res.json();
  }

  return {
    async fabricPlan(): Promise<Plan> {
      const data = await call("GET", "/v1/me/entitlements");
      const fabric = data.products?.find((p: any) => p.product === "fabric");
      if (!fabric) throw new Error("no_fabric_entitlement");
      return {
        plan: fabric.plan,
        status: fabric.status,
        seats: fabric.seats,
        features: fabric.features ?? [],
      };
    },
    async grantDataConsent(): Promise<void> {
      await call("POST", "/v1/consents", { product: "fabric", purpose: "data_licensing" });
    },
    async withdrawDataConsent(): Promise<{ withdrawn: number; delisted: number }> {
      return call("DELETE", "/v1/consents/fabric?purpose=data_licensing");
    },
    async earnings(): Promise<{ availableCents: number; pendingCents: number }> {
      return call("GET", "/v1/earnings");
    },
    async startCheckout(): Promise<never> {
      if (!opts.paymentsEnabled) throw new PaymentsDisabledError();
      throw new Error("not_implemented");
    },
    async requestPayout(): Promise<never> {
      if (!opts.paymentsEnabled) throw new PaymentsDisabledError();
      throw new Error("not_implemented");
    },
  };
}
