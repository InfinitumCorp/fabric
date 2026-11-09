/*
 * "Sign in with Cumulus://ID", a drop-in button for every Infinitum product site.
 *
 *   <span data-cumulus-id></span>
 *   <script src="/assets/cumulus-id.js" data-client="scalvs" defer></script>
 *
 * Copy this file onto the product's own site (canonical copy: mail.cumuluscloud.app/id/button.js).
 * It only navigates the page, never calls fetch(), so it works under a strict
 * Content-Security-Policy (script-src 'self'; connect-src 'self'; form-action 'none').
 *
 * Flow: OAuth 2.0 authorization code + PKCE (S256) against Cumulus://ID.
 *   1. /api/id/authorize          -> back here with ?code&state
 *   2. /api/id/redeem (+verifier) -> back here with #cid_token&profile&state
 * The token stays in this tab's sessionStorage. Pages can listen for the "cumulus-id" event on
 * window (event.detail = { cid, username, email, name } or null) and use window.CumulusID:
 * { profile(), token(), signIn(), signOut() }.
 */
(() => {
  const script = document.currentScript;
  const ID = (script && script.dataset.id) || "https://mail.cumuluscloud.app";
  const CLIENT = (script && script.dataset.client) || "infinitum";
  const KEY = `cumulus-id:${CLIENT}`;
  const PENDING = `${KEY}:pending`;

  const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const random = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
  const store = {
    get(k) { try { return JSON.parse(sessionStorage.getItem(k) || "null"); } catch { return null; } },
    set(k, v) { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
  };
  // The page itself, without our query or fragment, is where Cumulus://ID sends people back.
  const here = () => { const u = new URL(location.href); u.hash = ""; u.searchParams.delete("code"); u.searchParams.delete("state"); return u.toString(); };
  const go = (path, params) => { const u = new URL(path, ID); u.search = new URLSearchParams(params).toString(); location.assign(u.toString()); };

  async function signIn() {
    const verifier = random(48);
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const state = random(16);
    const redirect = here();
    store.set(PENDING, { verifier, state, redirect, scroll: scrollY });
    go("/api/id/authorize", { client_id: CLIENT, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state });
  }

  function signOut() {
    const saved = store.get(KEY);
    store.set(KEY, null);
    if (saved && saved.token) go("/api/id/end", { client_id: CLIENT, redirect_uri: here(), token: saved.token });
    else render();
  }

  let error = "";
  /** Returns true when the page is about to navigate to finish signing in. */
  function finish() {
    const pending = store.get(PENDING);
    const query = new URLSearchParams(location.search);
    const frag = new URLSearchParams(location.hash.slice(1));
    // Step 2 done: the token came back in the fragment.
    if (frag.has("cid_token") || frag.has("cid_error")) {
      store.set(PENDING, null);
      history.replaceState(null, "", here());
      if (!pending || frag.get("state") !== pending.state) { error = "That sign-in didn't match. Please try again."; return false; }
      if (frag.has("cid_error")) { error = frag.get("cid_error"); return false; }
      try {
        const profile = JSON.parse(atob(frag.get("profile").replace(/-/g, "+").replace(/_/g, "/")));
        store.set(KEY, { token: frag.get("cid_token"), profile, until: Date.now() + Number(frag.get("expires_in") || 3600) * 1000 });
        if (pending.scroll) requestAnimationFrame(() => scrollTo(0, pending.scroll));
      } catch { error = "Sign-in failed. Please try again."; }
      return false;
    }
    // Step 1 done: trade the one-time code for a session (a page navigation, not a request).
    const code = query.get("code"), state = query.get("state");
    if (code && state && pending) {
      if (state !== pending.state) { store.set(PENDING, null); history.replaceState(null, "", here()); error = "That sign-in didn't match. Please try again."; return false; }
      go("/api/id/redeem", { client_id: CLIENT, redirect_uri: pending.redirect, code, code_verifier: pending.verifier, state });
      return true;
    }
    return false;
  }

  const current = () => { const s = store.get(KEY); if (s && s.until > Date.now()) return s; if (s) store.set(KEY, null); return null; };

  const CSS = `.cid-wrap{display:inline-flex;align-items:center;gap:10px;flex-wrap:wrap;font:inherit;color:inherit}
.cid-btn{display:inline-flex;align-items:center;gap:8px;min-height:36px;padding:0 14px;border:1px solid currentColor;background:transparent;color:inherit;font:inherit;font-size:14px;line-height:1;cursor:pointer;border-radius:0;white-space:nowrap}
.cid-btn:hover,.cid-btn:focus-visible{outline:2px solid #2454dd;outline-offset:2px}
.cid-who{font-size:14px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cid-err{color:#b3261e;font-size:13px;flex-basis:100%}`;

  const button = (label, onClick) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "cid-btn"; b.textContent = label; b.addEventListener("click", onClick);
    return b;
  };

  function render() {
    const s = current();
    for (const host of document.querySelectorAll("[data-cumulus-id]")) {
      const wrap = document.createElement("span");
      wrap.className = "cid-wrap";
      if (s) {
        const who = document.createElement("span");
        who.className = "cid-who";
        who.textContent = (s.profile && (s.profile.email || s.profile.username)) || "Signed in";
        who.title = `Signed in with Cumulus://ID as ${who.textContent}`;
        wrap.append(who, button("Sign out", signOut));
      } else {
        wrap.append(button(host.dataset.label || "Sign in with Cumulus://ID", signIn));
        if (error) { const e = document.createElement("span"); e.className = "cid-err"; e.setAttribute("role", "alert"); e.textContent = error; wrap.append(e); }
      }
      host.replaceChildren(wrap);
    }
    window.dispatchEvent(new CustomEvent("cumulus-id", { detail: s ? s.profile : null }));
  }

  window.CumulusID = { profile: () => (current() || {}).profile || null, token: () => (current() || {}).token || null, signIn, signOut };

  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
  const start = () => { if (!finish()) render(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
