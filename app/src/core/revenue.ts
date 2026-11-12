// FABRIC plans and billing through the central Infinitum revenue API (infinitum-revenue Worker).
// Pure helpers (no React Native imports), so they run under node --test.
//
// The app never holds a Stripe key. It sends the signed-in person's Cumulus ID access token to the
// revenue API, which returns a Stripe Checkout or customer-portal URL to open. After Checkout,
// Stripe returns to `returnUrl` with ?billing=success or ?billing=cancelled.

export const REVENUE_DEFAULT_URL = "https://infinitum-revenue.infinitumcorp.workers.dev";
export const PRODUCT = "fabric";
export const PERSONAL_PLAN = "fabric_personal";
export const BUSINESS_PLAN = "fabric_business";

export class PaymentsDisabledError extends Error {
  constructor() {
    super("payments_disabled");
    this.name = "PaymentsDisabledError";
  }
}

/** A request the revenue API refused, with its short message (never the token). */
export class RevenueError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "RevenueError";
    this.status = status;
    this.code = code;
  }
}

export type CatalogPlan = {
  id: string;
  product: string;
  name: string;
  channel: "self_serve" | "sales_assisted" | "contract";
  priceCents: number;
  interval: "month" | "year";
  perSeat?: boolean;
  included?: Record<string, number>;
  features?: string[];
  trialDays?: number;
};

export type FabricPlan = {
  plan: string;
  status: string;
  seats: number;
  features: string[];
};

type Opts = {
  baseUrl: string;
  token: () => Promise<string>;
  fetch: typeof fetch;
  /** Gates payouts only. Checkout and the portal are run by the revenue API. */
  paymentsEnabled: boolean;
};

/** Revenue API base from EXPO_PUBLIC_REVENUE_URL (or another config value), HTTPS only. */
export function revenueUrl(env: string | undefined): string {
  const value = (env ?? "").trim().replace(/\/+$/, "");
  return value.startsWith("https://") ? value : REVENUE_DEFAULT_URL;
}

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** "Free", "$8 / month per seat", "$8.50 / month". */
export function formatPrice(p: Pick<CatalogPlan, "priceCents" | "interval" | "perSeat">): string {
  if (p.priceCents === 0) return "Free";
  const amount = p.priceCents % 100 ? (p.priceCents / 100).toFixed(2) : String(p.priceCents / 100);
  return `$${amount} / ${p.interval}${p.perSeat ? " per seat" : ""}`;
}

/** FABRIC plans a person can pick in the app (contract plans are sold by sales). */
export function fabricPlans(catalog: unknown): CatalogPlan[] {
  const plans = (catalog as { plans?: unknown })?.plans;
  if (!Array.isArray(plans)) return [];
  return (plans as CatalogPlan[]).filter((p) => p && p.product === PRODUCT && p.channel !== "contract");
}

/** Whole seats, 1..10000 (the revenue API's limit). */
export function seatCount(raw: unknown): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 10000) : 1;
}

/** The ?billing= result Stripe adds to the return URL, as a sentence, or null. */
export function billingNotice(search: string): string | null {
  const v = new URLSearchParams(search).get("billing");
  if (v === "success") return "Payment complete. Your plan is active.";
  if (v === "cancelled") return "Checkout cancelled. No charge was made.";
  return null;
}

export function createRevenueClient(opts: Opts) {
  const base = opts.baseUrl.replace(/\/+$/, "");
  async function call(method: string, path: string, body?: unknown, auth = true) {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (auth) headers.Authorization = `Bearer ${await opts.token()}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await opts.fetch(`${base}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = (data as { error?: { code?: string; message?: string } })?.error ?? {};
      throw new RevenueError(res.status, err.code ?? `http_${res.status}`, err.message ?? `Billing request failed (${res.status})`);
    }
    return data;
  }

  return {
    /** Public: FABRIC plans from GET /v1/catalog. */
    async catalog(): Promise<CatalogPlan[]> {
      return fabricPlans(await call("GET", "/v1/catalog", undefined, false));
    },
    async fabricPlan(): Promise<FabricPlan> {
      const data = await call("GET", "/v1/me/entitlements");
      const fabric = data.products?.find((p: any) => p.product === PRODUCT);
      if (!fabric) throw new Error("no_fabric_entitlement");
      return {
        plan: fabric.plan,
        status: fabric.status,
        seats: fabric.seats,
        features: fabric.features ?? [],
      };
    },
    /** Switches the person's billing org to a business (FABRIC Business is business-only). */
    async becomeBusiness(name?: string): Promise<{ id: string; name: string; kind: string }> {
      const body: Record<string, string> = { kind: "business" };
      if (name && name.trim()) body.name = name.trim().slice(0, 200);
      return call("POST", "/v1/me/org", body);
    },
    /** Stripe Checkout URL for a plan. */
    async startCheckout(planId: string, quantity: number, returnUrl: string): Promise<string> {
      const data = await call("POST", "/v1/subscriptions/checkout", { planId, quantity: seatCount(quantity), returnUrl });
      if (typeof data.url !== "string") throw new Error("no_checkout_url");
      return data.url;
    },
    /** Upgrade to FABRIC Business: switch to a business org, then Checkout with the seat count. */
    async upgradeToBusiness(seats: number, returnUrl: string, orgName?: string): Promise<string> {
      await this.becomeBusiness(orgName);
      return this.startCheckout(BUSINESS_PLAN, seats, returnUrl);
    },
    /** Stripe customer-portal URL. */
    async billingPortal(returnUrl: string): Promise<string> {
      const data = await call("POST", "/v1/billing/portal", { returnUrl });
      if (typeof data.url !== "string") throw new Error("no_portal_url");
      return data.url;
    },
    async grantDataConsent(): Promise<void> {
      await call("POST", "/v1/consents", { product: PRODUCT, purpose: "data_licensing" });
    },
    async withdrawDataConsent(): Promise<{ withdrawn: number; delisted: number }> {
      return call("DELETE", "/v1/consents/fabric?purpose=data_licensing");
    },
    async earnings(): Promise<{ availableCents: number; pendingCents: number }> {
      return call("GET", "/v1/earnings");
    },
    async requestPayout(): Promise<never> {
      if (!opts.paymentsEnabled) throw new PaymentsDisabledError();
      throw new Error("not_implemented");
    },
  };
}
