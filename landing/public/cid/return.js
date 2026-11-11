/*
 * Cumulus ID return page for the FabriC++ apps.
 *   /cid/return  native Android app (app.infinitumfabric.client, scheme infinitumfabric). The app
 *                also claims this URL as a verified App Link, so usually this page never shows.
 *   /cid/rn      React Native app (scheme infinitumfabric-app).
 * When the browser keeps the page, it hands the same code and state to the app's scheme. The code is single-use and only works with the verifier
 * the app kept, so nothing here is a secret on its own.
 */
(() => {
  const q = new URLSearchParams(location.search);
  const out = new URLSearchParams();
  for (const k of ["code", "state", "error"]) if (q.has(k)) out.set(k, q.get(k));
  const link = document.getElementById("open");
  const msg = document.getElementById("msg");
  if (!out.has("code") && !out.has("error")) {
    msg.textContent = "Nothing to return. Open the FabriC++ app and choose Sign in with Cumulus ID.";
    return;
  }
  const rn = location.pathname.replace(/\.html$/, "").endsWith("/cid/rn");
  const name = rn ? "infinitumfabric-app" : "infinitumfabric";
  const pkg = rn ? "" : "package=app.infinitumfabric.client;";
  const android = /Android/i.test(navigator.userAgent);
  // Chrome on Android needs an intent: URL to leave the browser for the app.
  const href = android
    ? `intent://cid/return?${out.toString()}#Intent;scheme=${name};${pkg}end`
    : `${name}://cid/return?${out.toString()}`;
  link.href = href;
  link.hidden = false;
  // Drop the code from history so a back press cannot replay it.
  history.replaceState(null, "", location.pathname);
  location.replace(href);
})();
