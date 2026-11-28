/*
 * FABRIC plan and billing (web). Plans come from the Infinitum revenue API (<meta name="revenue-url">).
 * The page never holds a Stripe key: it sends the signed-in person's Cumulus ID access token (from the
 * Cumulus://ID account bar) and navigates to the Checkout or portal URL the revenue API returns.
 * Stripe comes back here with ?billing=success or ?billing=cancelled.
 */
(() => {
  const DEFAULT = "https://infinitum-revenue.infinitumcorp.workers.dev";
  const meta = ((document.querySelector('meta[name="revenue-url"]') || {}).content || "").trim();
  const BASE = (/^https:\/\//.test(meta) ? meta : DEFAULT).replace(/\/+$/, "");
  const BUSINESS = "fabric_business";
  const $ = (id) => document.getElementById(id);
  const returnUrl = () => `${location.origin}${location.pathname}`;
  const token = () => (window.CumulusBar && window.CumulusBar.token()) || null;
  let plans = [];
  let busy = false;

  const show = (el, text) => { el.textContent = text || ""; el.hidden = !text; };
  const price = (p) => p.priceCents === 0 ? "Free"
    : `$${p.priceCents % 100 ? (p.priceCents / 100).toFixed(2) : p.priceCents / 100} / ${p.interval}${p.perSeat ? " per seat" : ""}`;

  async function call(method, path, body) {
    const headers = { Accept: "application/json" };
    if (path !== "/v1/catalog") headers.Authorization = `Bearer ${token() || ""}`;
    if (body) headers["Content-Type"] = "application/json";
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data.error && data.error.message) || `Billing request failed (${res.status})`);
    return data;
  }

  function renderPlans(current) {
    $("plans").replaceChildren(...plans.map((p) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = p.name;
      if (current && current.plan === p.id) {
        const tag = document.createElement("span");
        tag.className = "current";
        tag.textContent = "Current";
        name.append(tag);
      }
      const cost = document.createElement("span");
      cost.className = "muted";
      cost.textContent = price(p);
      li.append(name, cost);
      return li;
    }));
  }

  async function load() {
    show($("error"), "");
    try {
      const c = await call("GET", "/v1/catalog");
      plans = (c.plans || []).filter((p) => p.product === "fabric" && p.channel !== "contract");
    } catch { show($("error"), "Plans could not be loaded."); }
    let current = null;
    if (token()) {
      try {
        const e = await call("GET", "/v1/me/entitlements");
        current = (e.products || []).find((p) => p.product === "fabric") || null;
      } catch (err) { show($("error"), err.message); }
    }
    const name = current && ((plans.find((p) => p.id === current.plan) || {}).name || current.plan);
    $("current").textContent = !token() ? "Sign in with your Cumulus://ID to see your plan and upgrade."
      : current ? `Current plan: ${name} · ${current.status}${current.seats > 1 ? ` · ${current.seats} seats` : ""}`
      : "Your plan could not be loaded.";
    $("upgrade").hidden = !token() || !!(current && current.plan === BUSINESS);
    $("portal").hidden = !token();
    renderPlans(current);
  }

  async function go(button, label, getUrl) {
    if (busy) return;
    busy = true;
    const text = button.textContent;
    button.disabled = true;
    button.textContent = label;
    show($("error"), "");
    try {
      location.assign(await getUrl());
    } catch (err) {
      show($("error"), err.message || "Billing is not available right now.");
      button.disabled = false;
      button.textContent = text;
      busy = false;
    }
  }

  $("upgrade-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const f = ev.currentTarget;
    const seats = Math.min(Math.max(Math.floor(Number(f.seats.value)) || 1, 1), 10000);
    const org = f.org.value.trim().slice(0, 200);
    go($("upgrade-btn"), "Opening checkout…", async () => {
      await call("POST", "/v1/me/org", org ? { kind: "business", name: org } : { kind: "business" });
      return (await call("POST", "/v1/subscriptions/checkout", { planId: BUSINESS, quantity: seats, returnUrl: returnUrl() })).url;
    });
  });
  $("portal").addEventListener("click", () =>
    go($("portal"), "Opening…", async () => (await call("POST", "/v1/billing/portal", { returnUrl: returnUrl() })).url));

  const result = new URLSearchParams(location.search).get("billing");
  show($("notice"), result === "success" ? "Payment complete. Your plan is active."
    : result === "cancelled" ? "Checkout cancelled. No charge was made." : "");
  if (result) history.replaceState(null, "", location.pathname);

  window.addEventListener("cumulus-id", () => load());
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load); else load();
})();
