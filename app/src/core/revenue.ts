export type Entitlement = {
  plan: "personal" | "business";
  seats?: number;
};

export type RevenueClient = {
  getEntitlement: () => Promise<Entitlement>;
  grantConsent: (purpose: string) => Promise<void>;
  revokeConsent: (purpose: string) => Promise<void>;
  getEarnings: () => Promise<{ amountCents: number; holdDays: number }>;
};

export function createRevenueClient(opts: {
  baseUrl: string;
  getToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  paymentsEnabled?: boolean;
}): RevenueClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    async getEntitlement() {
      // Stub: in production call /v1/entitlements
      return { plan: "personal" };
    },
    async grantConsent(purpose: string) {
      // Stub
    },
    async revokeConsent(purpose: string) {
      // Stub
    },
    async getEarnings() {
      return { amountCents: 0, holdDays: 14 };
    },
  };
}
