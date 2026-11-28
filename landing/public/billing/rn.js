/*
 * Billing return pages for the FabriC++ apps.
 *   /billing/return  native Android app (app.infinitumfabric.client, scheme infinitumfabric). The app
 *                    also claims this URL as a verified App Link, so usually this page never shows.
 *   /billing/rn      React Native app (scheme infinitumfabric-app).
 * Stripe Checkout and the customer portal (through the Infinitum revenue API) send the browser here
 * with ?billing=success or ?billing=cancelled; this hands only that result to the app. The Checkout
 * session id is not passed on.
 */
(() => {
  const q = new URLSearchParams(location.search);
  const out = new URLSearchParams();
  const billing = q.get("billing");
  if (billing === "success" || billing === "cancelled") out.set("billing", billing);
  const msg = document.getElementById("msg");
  if (billing === "success") msg.textContent = "Payment complete. Returning you to the FabriC++ app.";
  if (billing === "cancelled") msg.textContent = "Checkout cancelled. No charge was made. Returning you to the FabriC++ app.";
  const query = out.toString();
  const rn = location.pathname.replace(/\.html$/, "").endsWith("/billing/rn");
  const scheme = rn ? "infinitumfabric-app" : "infinitumfabric";
  const pkg = rn ? "" : "package=app.infinitumfabric.client;";
  const href = /Android/i.test(navigator.userAgent)
    ? `intent://billing/return${query ? `?${query}` : ""}#Intent;scheme=${scheme};${pkg}end`
    : `${scheme}://billing/return${query ? `?${query}` : ""}`;
  document.getElementById("open").href = href;
  history.replaceState(null, "", location.pathname);
  location.replace(href);
})();
